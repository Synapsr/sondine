import type { Person } from "@sondine/db";
import { describe, expect, it } from "vitest";
import {
  measurePhoneVoices,
  phoneReportMarkdown,
  sameMomentEpisodes,
  type BenchVoice,
  type PairResult,
  type PhoneInventory,
} from "../src/voices/phone.ts";

const DIM = 256;

/** A unit vector on `axis`, leaning `amount` toward `lean`. */
function vector(axis: number, lean: number, amount: number): Float32Array {
  const out = new Float32Array(DIM);
  out[axis] = Math.sqrt(1 - amount * amount);
  out[lean] = amount;
  return out;
}

const people: Record<"me" | "marie" | "jeanne", Person> = {
  me: { id: 1, name: "Moi", isSelf: true },
  marie: { id: 2, name: "Marie", isSelf: false },
  jeanne: { id: 3, name: "Jeanne", isSelf: false },
};

let episodes = 0;
let leans = 100;
/** One voice heard on `channel` on `day`, near the person's direction (`axis`). */
function heard(
  person: Person | null,
  axis: number,
  day: string,
  options: {
    channel?: "phone" | "microphone";
    phoneApp?: boolean;
    amount?: number;
    episodeId?: number;
  } = {},
): BenchVoice {
  episodes += 1;
  leans += 1;
  const channel = options.channel ?? "phone";
  return {
    episodeId: options.episodeId ?? episodes,
    day,
    channel,
    phoneApp: options.phoneApp ?? channel === "phone",
    person,
    version: "wespeaker-v2:test",
    vector: vector(axis, leans, options.amount ?? 0.3),
    speechMs: 20_000,
  };
}

const days = ["2026-11-14", "2026-11-15", "2026-11-16"];
/** Two phone recordings a day on three days for each person: what the protocol asks. */
const enough = (person: Person, axis: number) =>
  days.flatMap((day) => [heard(person, axis, day), heard(person, axis, day)]);

const row = (results: readonly PairResult[], pair: string, holdout: string, rule: string) =>
  results.find((r) => r.pair === pair && r.holdout === holdout && r.rule === rule);

describe("the phone's report (ADR 030 for ADR 032)", () => {
  it("recognizes known people only under the rule opened, and no stranger", () => {
    const voices = [
      ...enough(people.me, 0),
      ...enough(people.marie, 1),
      ...enough(people.jeanne, 2),
    ];
    const { results, verdicts } = measurePhoneVoices(voices);
    const opened = row(results, "phone-phone", "day", "opened");
    expect(opened).toMatchObject({
      knownPeople: 3,
      known: { recognizedRight: 18, recognizedWrong: 0, suggestedWrong: 0 },
      strangerPeople: 3,
      strangers: { recognized: 0, suggested: 0, none: 18 },
    });
    // The rule built: the same voices only suggested.
    expect(row(results, "phone-phone", "day", "built")?.known).toMatchObject({
      recognizedRight: 0,
      suggestedRight: 18,
    });
    // No microphone references: the other pair has no one to compare with.
    expect(row(results, "phone-microphone", "day", "opened")?.knownPeople).toBe(0);
    // Three people, 18 stranger trials: too few to open, though nothing went wrong.
    expect(verdicts["phone-phone"].verdict).toBe("too-few");
    expect(verdicts["phone-phone"].why).toContain("3 people recognizable held out by day, of 4");
  });

  it("passes with four people on three days and enough strangers, and fails on one stranger recognized", () => {
    const fourth = { id: 4, name: "Paul", isSelf: false };
    const base = [
      ...enough(people.me, 0),
      ...enough(people.marie, 1),
      ...enough(people.jeanne, 2),
      ...enough(fourth, 3),
      ...enough(fourth, 3),
    ];
    expect(measurePhoneVoices(base).verdicts["phone-phone"]).toMatchObject({ verdict: "passes" });
    // A fifth person who sounds just like Marie: as a stranger, taken for her.
    const lookalike = { id: 5, name: "Louise", isSelf: false };
    const report = measurePhoneVoices([...base, heard(lookalike, 1, days[0] ?? "")]);
    expect(row(report.results, "phone-phone", "day", "opened")?.strangers.recognized).toBe(1);
    expect(report.verdicts["phone-phone"].verdict).toBe("fails");
  });

  it("holds out by day: references of the same day do not count", () => {
    const sameDay = [0, 1, 2, 3].map(() => heard(people.marie, 1, "2026-11-14"));
    const { results } = measurePhoneVoices([...sameDay, ...enough(people.me, 0)]);
    expect(row(results, "phone-phone", "episode", "opened")?.knownPeople).toBe(2);
    expect(row(results, "phone-phone", "day", "opened")?.knownPeople).toBe(1);
  });

  it("compares phone voices with microphone references, apart", () => {
    const voices = [
      ...days.flatMap((day) => [heard(people.me, 0, day, { channel: "microphone" })]),
      heard(people.me, 0, "2026-11-17"),
    ];
    const { results } = measurePhoneVoices(voices);
    expect(row(results, "phone-microphone", "day", "opened")?.known.recognizedRight).toBe(1);
    expect(row(results, "phone-microphone", "day", "built")?.known.suggestedRight).toBe(1);
    expect(row(results, "phone-phone", "day", "opened")?.knownPeople).toBe(0);
  });

  it("leaves out imported files and the Mac's recording of the same moment", () => {
    const imported = days.map((day) => heard(people.marie, 1, day, { phoneApp: false }));
    const test = heard(people.marie, 1, "2026-11-17", { episodeId: 900 });
    const mac = heard(people.marie, 1, "2026-11-17", { channel: "microphone", episodeId: 901 });
    const linked = new Map([
      [900, new Set([901])],
      [901, new Set([900])],
    ]);
    const report = measurePhoneVoices([...imported, test, mac], linked);
    expect(report.phoneVoices).toEqual({ embedded: 1, named: 1, trials: 1, days: 1 });
    expect(row(report.results, "phone-phone", "episode", "opened")?.knownPeople).toBe(0);
    expect(row(report.results, "phone-microphone", "episode", "opened")?.knownPeople).toBe(0);
    expect(
      measurePhoneVoices([...imported, test, mac]).results.find(
        (r) => r.pair === "phone-microphone" && r.holdout === "episode",
      )?.knownPeople,
    ).toBe(1);
  });

  it("writes numbers only, people as « person n »", () => {
    const voices = [
      ...enough(people.me, 0),
      ...enough(people.marie, 1),
      ...days.map((day) => heard(people.jeanne, 2, day, { channel: "microphone" })),
    ];
    const inventory: PhoneInventory = {
      appRecordings: 12,
      appRecordingDays: 3,
      appRecordingMinutes: 95,
      appRecordingsDeleted: 0,
      importedFiles: 1,
      unnamedToday: { recognized: 0, suggested: 2, none: 5 },
      sameMomentPairs: 0,
      sameMomentLinks: 0,
    };
    const markdown = phoneReportMarkdown({
      date: "2026-11-20",
      embedder: ["wespeaker-v2:test"],
      inventory,
      report: measurePhoneVoices(voices),
    });
    for (const name of ["Moi", "Marie", "Jeanne"]) expect(markdown).not.toContain(name);
    expect(markdown).toContain("| person 1 (the user) | 0 (0) | 6 (3) | yes / no |");
    expect(markdown).toContain("| person 3 | 3 (3) | 0 (0) | no / no |");
    expect(markdown).toContain("**too-few**");
  });

  it("counts a person in a recording once, the worst of their voices deciding", () => {
    // Every recording of Marie holds two voices named as her: one trial each.
    const marie = enough(people.marie, 1);
    const split = marie.map((voice) => ({ ...voice, vector: vector(1, 200, 0.3) }));
    const voices = [...enough(people.me, 0), ...marie, ...split];
    const opened = row(measurePhoneVoices(voices).results, "phone-phone", "day", "opened");
    expect(opened?.known).toMatchObject({ recognizedRight: 12, recognizedWrong: 0 });
    expect(opened?.strangers).toMatchObject({ none: 12 });
    // One of Marie's two voices in a recording sounds like the user: that trial is wrong.
    const [first, ...rest] = split;
    if (first === undefined) throw new Error("no voice");
    const taken = { ...first, vector: vector(0, 201, 0.3) };
    const wrong = row(
      measurePhoneVoices([...enough(people.me, 0), ...marie, taken, ...rest]).results,
      "phone-phone",
      "day",
      "opened",
    );
    expect(wrong?.known).toMatchObject({ recognizedRight: 11, recognizedWrong: 1 });
    expect(wrong?.strangers).toMatchObject({ recognized: 1, none: 11 });
  });

  it("gates on independent trials, not voices", () => {
    const fourth = { id: 4, name: "Paul", isSelf: false };
    const fifth = { id: 5, name: "Louise", isSelf: false };
    const everyone = [people.me, people.marie, people.jeanne, fourth, fifth];
    // Five people in three recordings a day on three days, each named twice in each: 90 voices…
    const voices = everyone.flatMap((person, axis) =>
      days.flatMap((day, index) =>
        [0, 1, 2].flatMap((recording) => {
          const episodeId = 1000 + index * 10 + recording;
          return [heard(person, axis, day, { episodeId }), heard(person, axis, day, { episodeId })];
        }),
      ),
    );
    const report = measurePhoneVoices(voices);
    // …but 45 trials, enough; with one recording a day, 15 trials are too few.
    expect(report.phoneVoices).toMatchObject({ named: 90, trials: 45 });
    expect(report.verdicts["phone-phone"].verdict).toBe("passes");
    const fewer = measurePhoneVoices(voices.filter((voice) => voice.episodeId % 10 === 0));
    expect(fewer.phoneVoices).toMatchObject({ named: 30, trials: 15 });
    expect(fewer.verdicts["phone-phone"].verdict).toBe("too-few");
    expect(fewer.verdicts["phone-phone"].why).toContain("15 stranger trials of 30");
  });
});

describe("recordings that may have heard the same moment", () => {
  const minute = 60_000;
  const midnight = Date.UTC(2026, 10, 14);
  const span = (
    episodeId: number,
    from: number,
    to: number,
    phoneApp = false,
    timeUncertain = false,
  ) => ({
    episodeId,
    startedAtMs: midnight + from * minute,
    endedAtMs: midnight + to * minute,
    phoneApp,
    timeUncertain,
  });

  it("keeps out every Mac recording meeting a phone recording's time, 2 minutes wider", () => {
    const pairs = sameMomentEpisodes([
      span(1, -30, 30, true), // a phone recording across midnight
      span(2, -60, -20), // the Mac's, before midnight: overlaps
      span(3, 31, 40), // starts a minute after the phone stops: within 2 minutes
      span(4, 33, 50), // three minutes after: apart
      span(5, -90, -80), // long before: apart
    ]);
    expect([...(pairs.get(1) ?? [])].toSorted()).toEqual([2, 3]);
    expect(pairs.get(2)).toEqual(new Set([1]));
    expect(pairs.has(4)).toBe(false);
    // Two Mac recordings that overlap each other are not paired: only phone recordings are tested.
    expect(sameMomentEpisodes([span(6, 0, 10), span(7, 5, 15)]).size).toBe(0);
  });

  it("widens an uncertain time to 15 minutes, and adds M5.7's links", () => {
    const uncertain = sameMomentEpisodes([span(1, 0, 10, true, true), span(2, 22, 30)]);
    expect(uncertain.get(1)).toEqual(new Set([2]));
    const linked = sameMomentEpisodes([span(1, 0, 10, true), span(2, 200, 300)], [[1, 2]]);
    expect(linked.get(2)).toEqual(new Set([1]));
  });
});
