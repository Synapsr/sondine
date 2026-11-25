import { describe, expect, it } from "vitest";
import { diagnosticText, type DiagnosticFacts } from "./diagnostic";

// The diagnostic (ADR 042) is a closed list: whatever reaches it that is not
// an enum, a catalog id, a version or a known code is not written.

const secret = "/Users/camille/Réunion avec Jules";

const facts = {
  appVersion: "0.7.0",
  macosVersion: "27.0.1",
  processor: "Apple M5 Max",
  queue: { queued: 2, running: 1, failed: 0 },
  failures: [
    { area: "transcription", code: "deadline", times: 2 },
    { area: "transcription", code: secret, times: 1 },
    { area: "journal", code: "claude_signed_out", times: 1 },
  ],
  models: {
    memoryBytes: 32 * 1024 ** 3,
    freeDiskBytes: 0,
    artifacts: [
      {
        artifactId: "nemotron-3.5",
        phase: "failed",
        displayName: secret,
        found: { path: secret, clones: true },
        problem: { code: "disk_full", message: secret, atMs: 0 },
      },
    ],
  },
  status: {
    permissions: { microphone: { status: "granted" }, systemAudio: { status: "denied" } },
    helper: {
      version: "0.7.0",
      lastError: { code: "helper.disconnected", message: secret, atMs: 0 },
    },
    analysis: { worker: "absent", waitingFor: ["on-battery"], lastError: { message: secret } },
    spool: [{ code: "disk.full", trackKey: secret }],
    updates: { problem: "network" },
    tracks: [{ name: secret, trackKey: secret }],
    listening: { holds: [{ name: secret }], callOffer: { name: secret } },
  },
} as unknown as DiagnosticFacts;

describe("the diagnostic", () => {
  it("is exactly this", () => {
    expect(diagnosticText(facts).split("\n")).toEqual([
      "Sondine 0.7.0, helper 0.7.0, macOS 27.0.1",
      "Mac: Apple M5 Max, 32 GB of memory",
      "Permissions: microphone granted, system audio denied",
      "Model nemotron-3.5: failed, disk_full",
      "Queue: 2 queued, 1 running, 0 failed; worker absent, waits for on-battery",
      "Errors in 7 days: transcription_deadline 2, transcription_other 1, journal_other 1, helper helper.disconnected, spool disk.full, update network",
    ]);
  });

  it("writes nothing it does not know", () => {
    const text = diagnosticText({
      ...facts,
      appVersion: secret,
      macosVersion: secret,
      processor: secret,
      status: {
        ...facts.status,
        helper: {
          ...facts.status.helper,
          version: secret,
          lastError: { code: secret, message: secret, atMs: 0 },
        },
      },
    });
    expect(text).not.toContain("camille");
    expect(text).not.toContain("Jules");
    expect(text).toContain("Sondine unknown, helper unknown, macOS unknown");
  });
});
