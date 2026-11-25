import type { AnalysisStatus } from "@sondine/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueLine, queueLineText, waitReasonText } from "./queue-line";

const analysis = (patch: Partial<AnalysisStatus> = {}): AnalysisStatus => ({
  worker: "absent",
  queued: { requested: 0, conversations: 0, moments: 0, media: 0, traces: 0 },
  running: null,
  waitingFor: [],
  waitingEpisodeId: null,
  server: null,
  requests: [],
  retryAtMs: null,
  lastError: null,
  models: [],
  ...patch,
});

const queued = { requested: 1, conversations: 2, moments: 8, media: 1, traces: 37 };
const retrying = (retryAtMs: number | null) =>
  analysis({ queued, waitingFor: ["retry-later"], retryAtMs });

const conversation = { context: "call", size: "conversation" } as const;
const dictation = { context: "dictation", size: "moment" } as const;
const trace = { context: "media", size: "trace" } as const;

describe("while a compute server transcribes", () => {
  // 2026-11-25: every moment said « quand le Mac est branché et inactif », for dictations' sake.
  const held = analysis({
    queued: { requested: 0, conversations: 0, moments: 11, media: 0, traces: 44 },
    waitingFor: ["on-battery", "not-idle"],
    waitingEpisodeId: 3,
    server: { waitingFor: [], dictationsWaitingFor: ["on-battery", "not-idle"] },
  });

  it("never lends the dictations' reasons to the rest", () => {
    expect(waitReasonText(held, conversation, "fr")).toBe("part au serveur dans un instant");
    expect(waitReasonText(held, trace, "fr")).toBe(
      "très court : part au serveur avec la prochaine conversation, ou dès que 30 attendent",
    );
    expect(waitReasonText(held, dictation, "fr")).toBe(
      "dictées, sur ce Mac : reprend quand le Mac est branché et inactif",
    );
    expect(queueLineText(queueLine(held), "fr")).toBe(
      "11 en attente · dictées, sur ce Mac : reprend quand le Mac est branché et inactif",
    );
  });

  it("says when it is the server that does not answer, not the dictations", () => {
    const down = analysis({
      queued,
      waitingFor: ["server-offline"],
      server: { waitingFor: ["server-offline"], dictationsWaitingFor: [] },
    });
    expect(waitReasonText(down, conversation, "fr")).toBe("le serveur ne répond pas");
    expect(waitReasonText(down, trace, "fr")).toBe("le serveur ne répond pas");
    expect(waitReasonText(down, dictation, "fr")).toBe(
      "dictée, transcrite sur ce Mac dans un instant",
    );
    expect(queueLine(down)).toMatchObject({ reason: "server-offline", dictations: false });
  });
});

describe("queue line", () => {
  it("counts what waits, traces left out, with the main reason", () => {
    expect(queueLine(analysis({ queued, waitingFor: ["on-battery", "not-idle"] }))).toEqual({
      kind: "waiting",
      waiting: 12,
      reason: "power-and-idle",
      dictations: false,
      retryAtMs: null,
    });
    expect(queueLine(analysis({ queued, waitingFor: ["not-idle", "no-model"] }))).toMatchObject({
      reason: "no-model",
    });
    expect(queueLine(analysis({ queued, waitingFor: ["thermal", "memory"] }))).toMatchObject({
      reason: "thermal",
    });
    expect(queueLine(analysis({ queued }))).toMatchObject({ reason: null });
  });

  it("shows the job running with what still waits", () => {
    const running = { jobId: 3, episodeId: 9, progress: 0.64, startedAtMs: 0 };
    expect(queueLine(analysis({ queued, running }))).toEqual({
      kind: "running",
      waiting: 12,
      progress: 0.64,
    });
  });

  it("is empty when only traces wait", () => {
    expect(
      queueLine(
        analysis({ queued: { requested: 0, conversations: 0, moments: 0, media: 0, traces: 5 } }),
      ),
    ).toEqual({ kind: "empty" });
  });

  it("says it in the menu bar's language, whatever the window's", () => {
    const waiting = {
      kind: "waiting",
      waiting: 3,
      reason: "not-idle",
      dictations: false,
      retryAtMs: null,
    } as const;
    expect(queueLineText(waiting, "fr")).toBe("3 en attente · reprend quand le Mac est inactif");
    expect(queueLineText(waiting, "en")).toMatch(/^3 /);
    expect(queueLineText({ kind: "running", waiting: 0, progress: null }, "fr")).toBe(
      "Transcription en cours",
    );
    expect(queueLineText({ kind: "empty" }, "fr")).toBe("Rien en attente de transcription");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says when the next try starts, when it is known", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 10, 8, 18, 10).getTime();
    vi.setSystemTime(now);
    expect(waitReasonText(retrying(null), conversation, "fr")).toBe("nouvel essai bientôt");
    expect(
      waitReasonText(retrying(new Date(2026, 10, 8, 18, 42).getTime()), conversation, "fr"),
    ).toBe("prochain essai : 18:42");
    expect(
      queueLineText(queueLine(retrying(new Date(2026, 10, 8, 18, 42).getTime())), "en"),
    ).toMatch(/^12 waiting · next try: /);
  });
});
