import type { AnalysisInput, AnalysisRegion, TrackStretch } from "@sondine/db";
import { describe, expect, it } from "vitest";
import { dictatedSegments, type DictatedContext } from "./dictated-text";
import type { Dictated } from "./place-typed";

// Times in seconds on one microphone run that started at 0.

const RATE = 16_000;
const region = (from: number, to: number, patch: Partial<AnalysisRegion> = {}): AnalysisRegion => ({
  regionId: from,
  trackRunId: 1,
  trackKey: "input:mic",
  sourceKind: "input",
  sampleRate: RATE,
  sampleStart: from * RATE,
  sampleEnd: to * RATE,
  sliceStart: from * RATE,
  sliceEnd: to * RATE,
  wallStartMs: from * 1000,
  runStartedWallMs: 0,
  runState: "closed",
  runSampleEnd: 10_000 * RATE,
  ...patch,
});
const input = (
  regions: AnalysisRegion[],
  deleted: AnalysisInput["deleted"] = new Map([[1, []]]),
): AnalysisInput => ({
  episodeId: 1,
  state: "closed",
  context: "dictation",
  inputGeneration: 1,
  regions,
  deleted,
});
const said = (from: number, to: number, text = "Ajoute du lait."): Dictated => ({
  startMs: from * 1000,
  endMs: to * 1000,
  text,
});
const context: DictatedContext = {
  wallMsAt: (_run, sample) => Math.round((sample * 1000) / RATE),
  owns: () => true,
  captured: () => true,
};

describe("a dictation's own text", () => {
  it("takes each of the app's dictations as it typed it, where it was heard", () => {
    const heard = [region(10, 14), region(15, 18), region(40, 45)];
    const history = [said(39.5, 45.2, "Puis le pain."), said(9.4, 18.1), said(200, 210, "Loin.")];
    expect(dictatedSegments(input(heard), history, context)).toEqual([
      {
        trackRunId: 1,
        sampleStart: 10 * RATE,
        sampleEnd: 18 * RATE,
        startMs: 10_000,
        endMs: 18_000,
        text: "Ajoute du lait.",
        speakerLabel: "input:mic/voice/1",
      },
      {
        trackRunId: 1,
        sampleStart: 40 * RATE,
        sampleEnd: 45 * RATE,
        startMs: 40_000,
        endMs: 45_000,
        text: "Puis le pain.",
        speakerLabel: "input:mic/voice/1",
      },
    ]);
  });

  it("leaves it to the transcription when something heard was not dictated", () => {
    expect(
      dictatedSegments(input([region(10, 14), region(20, 22)]), [said(10, 14)], context),
    ).toBeNull();
    expect(dictatedSegments(input([region(10, 30)]), [said(10, 20)], context)).toBeNull();
    expect(dictatedSegments(input([region(10, 14)]), [], context)).toBeNull();
  });

  it("asks for all of a dictation, its silences too, and takes none that is not the episode's", () => {
    const asked: TrackStretch[] = [];
    const owns = (stretch: TrackStretch) => (asked.push(stretch), false);
    expect(
      dictatedSegments(input([region(10, 14)]), [said(8, 15)], { ...context, owns }),
    ).toBeNull();
    expect(asked).toEqual([{ trackRunId: 1, sampleStart: 8.1 * RATE, sampleEnd: 14.9 * RATE }]);
  });

  it("takes a text placed by the microphone only while it was watched until the text came", () => {
    const asked: TrackStretch[] = [];
    const placed = { ...said(10, 14), watchedUntilMs: 32_000 };
    const captured = (stretch: TrackStretch) => (asked.push(stretch), false);
    expect(
      dictatedSegments(input([region(10, 14)]), [placed], { ...context, captured }),
    ).toBeNull();
    expect(asked).toEqual([{ trackRunId: 1, sampleStart: 10.1 * RATE, sampleEnd: 32 * RATE }]);
    expect(dictatedSegments(input([region(10, 14)]), [placed], context)).toHaveLength(1);
  });

  it("takes none said across two microphones", () => {
    const heard = [region(10, 14), region(14, 18, { trackRunId: 2 })];
    expect(dictatedSegments(input(heard), [said(10, 18)], context)).toBeNull();
  });

  it("never brings back what the user deleted", () => {
    const cut = new Map<number, [number, number][]>([[1, [[12 * RATE, 13 * RATE]]]]);
    expect(dictatedSegments(input([region(10, 14)], cut), [said(10, 14)], context)).toBeNull();
  });

  it("takes only a microphone's speech, closed, with words", () => {
    const history = [said(10, 14)];
    expect(
      dictatedSegments(input([region(10, 14, { trackKey: "system:other" })]), history, context),
    ).toBeNull();
    expect(
      dictatedSegments(
        input([region(10, 14, { sliceEnd: null, sampleEnd: null })]),
        history,
        context,
      ),
    ).toBeNull();
    expect(dictatedSegments(input([region(10, 14)]), [said(10, 14, "")], context)).toBeNull();
    expect(dictatedSegments(input([]), history, context)).toBeNull();
  });
});
