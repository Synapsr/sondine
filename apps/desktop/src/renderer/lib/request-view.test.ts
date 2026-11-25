import type { AnalysisStatus } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { requestView } from "./request-view";

const idle: AnalysisStatus = {
  worker: "absent",
  queued: { requested: 1, conversations: 0, moments: 0, media: 0, traces: 0 },
  running: null,
  waitingFor: [],
  waitingEpisodeId: null,
  server: null,
  requests: [{ episodeId: 7, state: "queued", failure: null }],
  retryAtMs: null,
  lastError: null,
  models: [],
};
const episode = {
  id: 7,
  state: "closed",
  analysisState: "queued",
  context: "call",
  size: "conversation",
} as const;

describe("what a row says of its transcription", () => {
  it("says why the queue waits on this very request", () => {
    const analysis = {
      ...idle,
      waitingFor: ["memory"],
      waitingEpisodeId: 7,
    } satisfies AnalysisStatus;
    expect(requestView(analysis, episode)).toEqual({
      kind: "waiting",
      cause: { kind: "reasons", analysis, episode },
    });
  });

  it("does not lend another job's reasons to this one", () => {
    const analysis = {
      ...idle,
      waitingFor: ["memory"],
      waitingEpisodeId: 3,
    } satisfies AnalysisStatus;
    expect(requestView(analysis, episode)).toEqual({ kind: "waiting", cause: { kind: "behind" } });
  });

  it("waits after the transcription under way, and says nothing of its own while it runs", () => {
    const running = { jobId: 1, episodeId: 3, progress: 0.4, startedAtMs: 0 };
    expect(requestView({ ...idle, running }, episode)).toEqual({
      kind: "waiting",
      cause: { kind: "after-running" },
    });
    expect(requestView({ ...idle, running: { ...running, episodeId: 7 } }, episode)).toBeNull();
  });

  it("says why this very request waits while a server transcribes another", () => {
    const analysis = {
      ...idle,
      running: { jobId: 1, episodeId: 3, progress: 0.4, startedAtMs: 0 },
      waitingFor: ["thermal"],
      waitingEpisodeId: 7,
    } satisfies AnalysisStatus;
    expect(requestView(analysis, episode)).toEqual({
      kind: "waiting",
      cause: { kind: "reasons", analysis, episode },
    });
  });

  it("keeps a server's jobs and the dictations apart", () => {
    const analysis = {
      ...idle,
      running: { jobId: 1, episodeId: 3, progress: 0.4, startedAtMs: 0 },
      waitingFor: ["on-battery"],
      waitingEpisodeId: 5,
      server: { waitingFor: [], dictationsWaitingFor: ["on-battery"] },
    } satisfies AnalysisStatus;
    expect(requestView(analysis, episode)).toEqual({
      kind: "waiting",
      cause: { kind: "after-running" },
    });
    expect(requestView({ ...analysis, running: null }, episode)).toEqual({
      kind: "waiting",
      cause: { kind: "starting" },
    });
    expect(requestView(analysis, { ...episode, context: "dictation" })).toEqual({
      kind: "waiting",
      cause: { kind: "behind" },
    });
  });

  it("names a failed request's code, and a failure nobody asked for without one", () => {
    const failed = { ...episode, analysisState: "failed" } as const;
    expect(
      requestView(
        { ...idle, requests: [{ episodeId: 7, state: "failed", failure: "invalid_output" }] },
        failed,
      ),
    ).toEqual({ kind: "failed", failure: "invalid_output" });
    expect(requestView({ ...idle, requests: [] }, failed)).toEqual({
      kind: "failed",
      failure: null,
    });
  });

  it("says nothing of an episode nobody asked for", () => {
    expect(requestView({ ...idle, requests: [] }, episode)).toBeNull();
  });
});
