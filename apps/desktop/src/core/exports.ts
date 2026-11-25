import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import { MainChannel } from "./main-channel";

// Exports (M2): what leaves Sondine goes by the user's hand, through main.
// « Exporter l'audio… » asks main for a save panel, and main writes the WAV
// through the media relay, so the audio never crosses oRPC (a read of deleted
// audio fails). A transcript goes to the clipboard or through a save panel;
// main asks once more right before it writes (`export-ready`), and core says
// go only while `stillCurrent` holds. Core waits for the outcome.

export type ExportOutcome = "saved" | "copied" | "shared" | "cancelled" | "stale" | "failed";

export interface ExportsService {
  audio(target: {
    readonly episodeId: number;
    readonly generation: number;
    readonly fileName: string;
  }): Promise<"saved" | "cancelled" | "failed">;
  text(target: {
    readonly destination: "file" | "clipboard" | "share";
    readonly fileName: string;
    readonly text: string;
    /** Whether the text may still leave: nothing was deleted since the window read it. */
    readonly stillCurrent: () => Promise<boolean>;
  }): Promise<ExportOutcome>;
  /** Main's answer to `export-audio` or `export-text`. */
  receive(requestId: string, outcome: ExportOutcome): void;
  /** Main is about to write a transcript: answers `export-go`. */
  confirm(requestId: string): void;
}

export class Exports extends Context.Service<Exports, ExportsService>()("sondine/core/Exports") {}

/** A long recording takes a while to write; a panel left open is not a failure. */
const EXPORT_TIMEOUT_MS = 30 * 60_000;

export const exportsLayer = Layer.effect(
  Exports,
  Effect.gen(function* () {
    const main = yield* MainChannel;
    const pending = new Map<string, (outcome: ExportOutcome) => void>();
    const checks = new Map<string, () => Promise<boolean>>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const answer of pending.values()) answer("failed");
      }),
    );
    const ask = (post: (requestId: string) => void, stillCurrent?: () => Promise<boolean>) =>
      new Promise<ExportOutcome>((resolve) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => answer("failed"), EXPORT_TIMEOUT_MS);
        const answer = (outcome: ExportOutcome) => {
          clearTimeout(timer);
          pending.delete(requestId);
          checks.delete(requestId);
          resolve(outcome);
        };
        pending.set(requestId, answer);
        if (stillCurrent !== undefined) checks.set(requestId, stillCurrent);
        post(requestId);
      });
    return Exports.of({
      // Main never copies or shares audio, nor asks to confirm it; such an answer is a fault.
      audio: (target) =>
        ask((requestId) => main.post({ type: "export-audio", requestId, ...target })).then(
          (outcome) =>
            outcome === "copied" || outcome === "shared" || outcome === "stale"
              ? "failed"
              : outcome,
        ),
      text: ({ stillCurrent, ...target }) =>
        ask((requestId) => main.post({ type: "export-text", requestId, ...target }), stillCurrent),
      receive: (requestId, outcome) => pending.get(requestId)?.(outcome),
      confirm: (requestId) => {
        const check = checks.get(requestId);
        void (check === undefined ? Promise.resolve(false) : check())
          .catch(() => false)
          .then((go) => main.post({ type: "export-go", requestId, go }));
      },
    });
  }),
);
