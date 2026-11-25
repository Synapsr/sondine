import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import * as z from "zod";
import type { MainToCore } from "../shared/core-messages";

// The voice read's recorder (ADR 034). Main spawns `sondine-audio
// read-voice`, as it spawns the helper, so macOS credits Sondine.app for the
// microphone. The recorder writes 16 kHz PCM16 to a file core named in the
// data directory's `voice-read` folder and reports, every ~100 ms, how much it
// wrote and how loud: main relays those numbers and the exit, never audio.
// One recording at a time; closing stdin stops it, and a recorder that does
// not exit soon after is killed.

const KILL_AFTER_MS = 3_000;

const Line = z.discriminatedUnion("event", [
  z.object({ event: z.literal("started") }),
  z.object({
    event: z.literal("level"),
    ms: z.int().min(0),
    rms: z.number().min(0).max(1),
    peak: z.number().min(0).max(1),
  }),
  z.object({ event: z.literal("stopped"), ms: z.int().min(0) }),
]);

/** Closing stdin stops the recorder; one still there soon after is killed. */
function stopChild(child: ChildProcess): void {
  child.stdin?.end();
  const kill = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
  kill.unref();
  child.once("exit", () => clearTimeout(kill));
}

export interface VoiceRecorderOptions {
  readonly executable: string;
  /** Extra arguments (`--hal fake` in development). */
  readonly args: readonly string[];
  /** The one folder recordings may be written to. */
  readonly directory: string;
  readonly post: (message: MainToCore) => void;
  readonly log: (event: string, fields: Record<string, string | number | null>) => void;
}

export interface VoiceRecorder {
  record(readId: string, path: string, maxMs: number): void;
  stop(readId: string): void;
  /** Stops any recording (main quitting). */
  stopAll(): void;
  /** Kills any recording at once: the core that asked for it is gone, nothing is kept. */
  abort(): void;
}

export function createVoiceRecorder(options: VoiceRecorderOptions): VoiceRecorder {
  let current: { readonly readId: string; readonly child: ChildProcess } | null = null;

  const ended = (readId: string, ok: boolean, message: string | null) =>
    options.post({ type: "voice-read-ended", readId, ok, message });

  return {
    record(readId, path, maxMs) {
      if (current !== null) {
        ended(readId, false, "a recording already runs");
        return;
      }
      if (dirname(resolve(path)) !== resolve(options.directory) || !path.endsWith(".pcm")) {
        options.log("voice-read.refused-path", {});
        ended(readId, false, "the recording must go to the voice read folder");
        return;
      }
      const child = spawn(
        options.executable,
        [
          "read-voice",
          "--out",
          path,
          "--max-seconds",
          String(Math.ceil(maxMs / 1000)),
          ...options.args,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      current = { readId, child };
      let stderr = "";
      let buffered = "";
      child.stdin?.on("error", () => undefined);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const text = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          let parsed: z.output<typeof Line> | null = null;
          try {
            const result = Line.safeParse(JSON.parse(text));
            parsed = result.success ? result.data : null;
          } catch {
            parsed = null;
          }
          if (parsed?.event === "level") {
            options.post({
              type: "voice-read-level",
              readId,
              ms: parsed.ms,
              rms: parsed.rms,
              peak: parsed.peak,
            });
          }
        }
      });
      let reported = false;
      const finish = (ok: boolean, message: string | null) => {
        if (reported) return;
        reported = true;
        if (current?.child === child) current = null;
        options.log("voice-read.recorder-exit", { ok: ok ? 1 : 0 });
        ended(readId, ok, message);
      };
      child.once("error", (error) => finish(false, error.message));
      child.once("exit", (code, signal) =>
        finish(
          code === 0,
          code === 0 ? null : `exited with ${code ?? signal ?? "?"}: ${stderr.trim()}`,
        ),
      );
      options.log("voice-read.recorder", { pid: child.pid ?? null });
    },
    stop(readId) {
      if (current?.readId === readId) stopChild(current.child);
    },
    stopAll() {
      if (current !== null) stopChild(current.child);
    },
    abort() {
      current?.child.kill("SIGKILL");
    },
  };
}
