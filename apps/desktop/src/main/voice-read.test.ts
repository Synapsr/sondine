import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MainToCore } from "../shared/core-messages";
import { createVoiceRecorder } from "./voice-read";

const readId = "00000000-0000-4000-8000-000000000001";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function recorder(executable: string, directory: string) {
  const posted: MainToCore[] = [];
  const voice = createVoiceRecorder({
    executable,
    args: [],
    directory,
    post: (message) => posted.push(message),
    log: () => undefined,
  });
  return { voice, posted };
}

/** A stand-in for `sondine-audio read-voice`: prints what it prints, stops when stdin closes. */
function standIn(): { readonly dir: string; readonly executable: string } {
  const dir = mkdtempSync(join(tmpdir(), "sondine-recorder-"));
  dirs.push(dir);
  const executable = join(dir, "read-voice");
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      `echo '{"event":"started"}'`,
      `echo '{"event":"level","ms":100,"rms":0.1,"peak":0.4}'`,
      "echo 'not json'",
      "cat > /dev/null",
      `echo '{"event":"stopped","ms":100}'`,
      "",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  return { dir, executable };
}

describe("the voice read's recorder", () => {
  it("kills a recording at once when core is gone", async () => {
    const { dir, executable } = standIn();
    const { voice, posted } = recorder(executable, dir);
    voice.record(readId, join(dir, `${readId}.pcm`), 60_000);
    await expect
      .poll(() => posted.some((message) => message.type === "voice-read-level"))
      .toBe(true);
    voice.abort();
    await expect
      .poll(() => posted.find((message) => message.type === "voice-read-ended"))
      .toMatchObject({ ok: false });
  });

  it("records only into the voice read folder", () => {
    const { voice, posted } = recorder("/bin/false", "/data/voice-read");
    voice.record(readId, "/data/spool/x.pcm", 60_000);
    voice.record(readId, "/data/voice-read/../spool/x.pcm", 60_000);
    voice.record(readId, "/data/voice-read/x.wav", 60_000);
    expect(posted).toEqual([
      expect.objectContaining({ type: "voice-read-ended", ok: false }),
      expect.objectContaining({ type: "voice-read-ended", ok: false }),
      expect.objectContaining({ type: "voice-read-ended", ok: false }),
    ]);
  });

  it("relays the recorder's levels and its exit, never more", async () => {
    const { dir, executable } = standIn();
    const { voice, posted } = recorder(executable, dir);
    voice.record(readId, join(dir, `${readId}.pcm`), 60_000);
    await expect
      .poll(() => posted.some((message) => message.type === "voice-read-level"))
      .toBe(true);
    voice.stop(readId);
    await expect
      .poll(() => posted.some((message) => message.type === "voice-read-ended"))
      .toBe(true);
    expect(posted).toEqual([
      { type: "voice-read-level", readId, ms: 100, rms: 0.1, peak: 0.4 },
      { type: "voice-read-ended", readId, ok: true, message: null },
    ]);
  });
});
