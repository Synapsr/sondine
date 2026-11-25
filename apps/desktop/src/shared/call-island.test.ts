import type { ListeningStatus } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { CARD_MAX_AGE_MS, islandCard, islandView, type CaptureView } from "./call-island";
import type { CallView } from "./call-menu";

const now = new Date(2026, 10, 25, 15, 0).getTime();

const listening = (patch: Partial<ListeningStatus> = {}): ListeningStatus => ({
  desired: "listening",
  effective: "listening",
  microphonePaused: false,
  systemAudioPaused: false,
  changedAtMs: now,
  pausedUntilMs: null,
  holds: [],
  callOffer: null,
  forCall: null,
  call: null,
  callEnded: null,
  pauseReminder: null,
  ...patch,
});

const DISCORD = { bundleId: "com.hnc.Discord", name: "Discord" };
const call = { callId: "a", ...DISCORD, sinceMs: now, episodeId: 31 };
const on: CaptureView = { mayRecord: true, paused: false, label: "À l’écoute" };
const off: CaptureView = { mayRecord: false, paused: true, label: "En pause" };

const people: CallView = {
  callId: 4,
  title: "Marie ?",
  people: [{ personId: 2, label: "Marie ?", monogram: "M", conversations: [], none: "Aucune" }],
  dismiss: "Masquer pour cet appel",
  openOnHover: true,
};

const view = (
  status: ListeningStatus | null,
  capture: CaptureView,
  with_: CallView | null = null,
) =>
  islandView({
    listening: status,
    capture,
    people: with_,
    card: status === null ? null : islandCard(status, "fr", now, new Set()),
    openOnHover: true,
    locale: "fr",
  });

describe("the island's view", () => {
  it("shows the call with its switch, its recording, and whom it may be with", () => {
    expect(view(listening({ call, callOffer: { kind: "skip", ...call } }), on, people)).toEqual({
      call: {
        callId: "a",
        bundleId: "com.hnc.Discord",
        title: "Appel Discord",
        detail: "À l’écoute",
        monogram: "D",
        on: true,
        toggle: "Écouter cet appel",
        announce: true,
        episode: { episodeId: 31, open: "Ouvrir", end: "Terminer" },
        mute: "Ne plus prévenir pour Discord",
      },
      people: people.people,
      dismiss: { label: "Masquer les personnes pour cet appel", callId: 4 },
      card: null,
      openOnHover: true,
    });
  });

  it("follows what the capture does, never the request alone", () => {
    // Asked to pause, not confirmed: it may still record.
    const asked = {
      mayRecord: true,
      paused: false,
      label: "Pas encore en pause : écoute en cours",
    };
    expect(view(listening({ desired: "paused", call }), asked)?.call).toMatchObject({
      on: true,
      detail: "Pas encore en pause : écoute en cours",
    });
    expect(view(listening({ call }), off)?.call).toMatchObject({ on: false, detail: "En pause" });
    // Starting, held, unavailable: no switch that could lie; the people stay.
    const unknown = { mayRecord: false, paused: false, label: "Démarrage de la capture…" };
    expect(view(listening({ call }), unknown)).toBeNull();
    expect(view(listening({ call }), unknown, people)).toMatchObject({
      call: null,
      dismiss: { label: "Masquer pour cet appel", callId: 4 },
    });
  });

  it("says when the pause, or the listening, is for this call", () => {
    const answered = (kind: "listen" | "skip") =>
      listening({ call, forCall: { kind, ...DISCORD, sinceMs: now } });
    expect(view(answered("skip"), off)?.call?.detail).toBe("En pause le temps de l’appel");
    expect(view(answered("listen"), on)?.call?.detail).toBe("À l’écoute le temps de l’appel");
    // Not yet paused for it: what the capture does comes first.
    expect(view(answered("skip"), on)?.call?.detail).toBe("À l’écoute");
  });

  it("says what a call left once, then nothing", () => {
    const callEnded = {
      callId: "a",
      ...DISCORD,
      endedAtMs: now - 10_000,
      recording: { episodeId: 31, durationMs: 32 * 60_000, open: true },
      restored: "paused" as const,
    };
    const status = listening({ callEnded });
    expect(view(status, off)).toMatchObject({
      call: null,
      card: {
        title: "Appel Discord terminé",
        detail: "32 min enregistrées · De nouveau en pause",
        actions: [
          { action: "open-episode", label: "Ouvrir", episodeId: 31 },
          { action: "end-episode", label: "Terminer", episodeId: 31 },
        ],
      },
    });
    // Already ended by hand, or nothing recorded.
    expect(
      islandCard(
        listening({
          callEnded: { ...callEnded, recording: { ...callEnded.recording, open: false } },
        }),
        "fr",
        now,
        new Set(),
      )?.actions.map(({ action }) => action),
    ).toEqual(["open-episode"]);
    expect(
      islandCard(
        listening({ callEnded: { ...callEnded, recording: null, restored: "listening" } }),
        "fr",
        now,
        new Set(),
      ),
    ).toMatchObject({ detail: "Sondine écoute à nouveau", actions: [] });
    // Said, too late, or another call goes on.
    expect(islandCard(status, "fr", now, new Set([`ended:${callEnded.endedAtMs}`]))).toBeNull();
    expect(islandCard(status, "fr", now + CARD_MAX_AGE_MS, new Set())).toBeNull();
    expect(islandCard({ ...status, call }, "fr", now, new Set())).toBeNull();
  });

  it("says a forgotten pause, with the day when it is not today", () => {
    const at = (sinceMs: number) =>
      islandCard(listening({ pauseReminder: { sinceMs } }), "fr", now, new Set());
    expect(at(new Date(2026, 10, 25, 9, 12).getTime())).toMatchObject({
      title: "En pause depuis 9:12",
      actions: [{ action: "resume", label: "Reprendre l’écoute", episodeId: null }],
    });
    expect(at(new Date(2026, 10, 24, 18, 30).getTime())?.title).toBe("En pause depuis mardi 18:30");
  });
});
