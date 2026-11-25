import {
  decideVoice,
  measuredChannels,
  PHONE_VOICES_MEASURED,
  RECOGNIZE_DAYS,
  RECOGNIZE_REFERENCES,
  SAME_MOMENT_SEARCH_MS,
  SAME_MOMENT_UNCERTAIN_SEARCH_MS,
  voiceConfidence,
  type PersonScore,
  type Person,
  type VoiceChannel,
} from "@sondine/db";

// ADR 030's report for the phone (ADR 032, M5.8): each voice the user named
// on a recording made by the iPhone app is held out, then compared with the
// centroid of each person's references, by the production rule
// (`decideVoice`), in two pairs kept apart: against microphone references,
// and against phone references. Known: the person is among the references.
// Stranger: the same voice with that person's references taken out, so every
// named person is a stranger to everyone else. Two rules: the one built
// (phone voices suggested only, from 99 %), and the one the report decides
// on, as if the pair were measured (suggested from 80 %, recognized at 99 %
// with three references on two days). Counts of people and trials only: a
// trial is one person in one recording, all the voices named as them there
// together (diarization may split a person in two), and the worst outcome
// among them counts.

/** One embedded voice of one transcript, with whom the user named it as. */
export interface BenchVoice {
  readonly episodeId: number;
  /** The local day the episode started (`YYYY-MM-DD`). */
  readonly day: string;
  readonly channel: VoiceChannel;
  /** Heard on a recording the iPhone app made (not an imported file). */
  readonly phoneApp: boolean;
  readonly person: Person | null;
  readonly version: string;
  readonly vector: Float32Array;
  readonly speechMs: number;
}

export type PairId = "phone-microphone" | "phone-phone";
export type Holdout = "episode" | "day";
export type Rule = "built" | "opened";

export const PAIRS: readonly { readonly id: PairId; readonly references: VoiceChannel }[] = [
  { id: "phone-microphone", references: "microphone" },
  { id: "phone-phone", references: "phone" },
];

/** What a pair needs before its report can open it (ADR 032's protocol). */
export const ENOUGH = {
  /** Days with named phone voices. */
  days: 3,
  /** People recognizable when held out by day: the user and three others. */
  people: 4,
  /** Stranger trials: a person in a recording, compared without their references. */
  strangerTrials: 30,
} as const;

export interface Tally {
  recognized: number;
  suggested: number;
  none: number;
}

export interface KnownTally {
  recognizedRight: number;
  recognizedWrong: number;
  suggestedRight: number;
  suggestedWrong: number;
  none: number;
}

export interface PairResult {
  readonly pair: PairId;
  readonly holdout: Holdout;
  readonly rule: Rule;
  /** People whose own references were left after the holdout; `known` counts their trials. */
  readonly knownPeople: number;
  readonly known: KnownTally;
  /** People tried as strangers; `strangers` counts their trials. */
  readonly strangerPeople: number;
  readonly strangers: Tally;
  /** Strangers recognized or suggested: people, apart from trials. */
  readonly strangerPeopleRecognized: number;
  readonly strangerPeopleSuggested: number;
  /** The highest confidence a stranger reached against anyone, 0 to 1. */
  readonly bestStrangerConfidence: number | null;
}

export interface PersonRow {
  /** `person 1`, `person 2`…: never a name. */
  readonly alias: string;
  readonly isSelf: boolean;
  /** Recordings where a voice is named as them, and their days. */
  readonly microphoneRecordings: number;
  readonly microphoneDays: number;
  readonly phoneRecordings: number;
  readonly phoneDays: number;
  /** Recordings left for a recognition whatever day of their phone ones is held out: phone ones… */
  readonly phoneTestableByDay: boolean;
  /** …microphone ones. */
  readonly microphoneTestableByDay: boolean;
}

export type Verdict = "too-few" | "fails" | "passes";

export interface PhoneReport {
  readonly results: readonly PairResult[];
  readonly people: readonly PersonRow[];
  readonly phoneVoices: {
    readonly embedded: number;
    readonly named: number;
    /** A person in a recording. */
    readonly trials: number;
    readonly days: number;
  };
  /** For each pair, held out by day, with the rule it would open. */
  readonly verdicts: Readonly<Record<PairId, { readonly verdict: Verdict; readonly why: string }>>;
  readonly phoneMeasured: boolean;
}

const EMBEDDING = 256;

/** Cosine with the centroid (the sum) of `references`, all of one embedder version. */
function similarity(vector: Float32Array, references: readonly BenchVoice[]): number | null {
  const sum = new Float64Array(EMBEDDING);
  for (const reference of references) {
    for (let index = 0; index < EMBEDDING; index++) {
      sum[index] = (sum[index] ?? 0) + (reference.vector[index] ?? 0);
    }
  }
  let product = 0;
  let centroid = 0;
  let length = 0;
  for (let index = 0; index < EMBEDDING; index++) {
    const value = vector[index] ?? 0;
    const total = sum[index] ?? 0;
    product += total * value;
    centroid += total * total;
    length += value * value;
  }
  return centroid === 0 || length === 0 ? null : product / Math.sqrt(centroid * length);
}

/** An episode with voices, on the wall clock. */
export interface EpisodeSpan {
  readonly episodeId: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  /** Recorded by the iPhone app… */
  readonly phoneApp: boolean;
  /** …and placed at its arrival, its clock not plausible (ADR 032). */
  readonly timeUncertain: boolean;
}

/**
 * The episodes that may have heard the same moment as each phone recording:
 * those M5.7 linked, and, whether it linked them or not (detection pending,
 * failed, an overlap too short), every other episode whose time meets the
 * phone recording's, widened as M5.7 searches (2 minutes, 15 when its time
 * is uncertain). A meeting heard twice is the same speech: never its own
 * reference, even across midnight.
 */
export function sameMomentEpisodes(
  spans: readonly EpisodeSpan[],
  links: readonly (readonly [number, number])[] = [],
): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  const pair = (a: number, b: number) => {
    out.set(a, (out.get(a) ?? new Set()).add(b));
    out.set(b, (out.get(b) ?? new Set()).add(a));
  };
  for (const [a, b] of links) pair(a, b);
  for (const phone of spans) {
    if (!phone.phoneApp) continue;
    const margin = phone.timeUncertain ? SAME_MOMENT_UNCERTAIN_SEARCH_MS : SAME_MOMENT_SEARCH_MS;
    for (const other of spans) {
      if (
        other.episodeId !== phone.episodeId &&
        other.startedAtMs < phone.endedAtMs + margin &&
        other.endedAtMs > phone.startedAtMs - margin
      ) {
        pair(phone.episodeId, other.episodeId);
      }
    }
  }
  return out;
}

/** The references a held-out voice may be compared with. */
function heldOut(
  test: BenchVoice,
  references: readonly BenchVoice[],
  holdout: Holdout,
  sameMoment: ReadonlyMap<number, ReadonlySet<number>>,
): BenchVoice[] {
  const heardThen = sameMoment.get(test.episodeId);
  return references.filter(
    (reference) =>
      reference.version === test.version &&
      reference.episodeId !== test.episodeId &&
      heardThen?.has(reference.episodeId) !== true &&
      (holdout === "episode" || reference.day !== test.day),
  );
}

/** Every person's score against a held-out voice, from their references in `gallery`. */
function scores(
  test: BenchVoice,
  gallery: ReadonlyMap<number, readonly BenchVoice[]>,
  same: boolean,
): PersonScore[] {
  return [...gallery].flatMap(([, references]) => {
    const person = references[0]?.person;
    const cosine = similarity(test.vector, references);
    if (person === null || person === undefined || cosine === null) return [];
    return [
      {
        person,
        similarity: cosine,
        references: references.length,
        dictations: 0,
        reads: 0,
        days: new Set(references.map((reference) => reference.day)).size,
        same,
        speechMs: test.speechMs,
      },
    ];
  });
}

const byPerson = (voices: readonly BenchVoice[]) =>
  Map.groupBy(
    voices.filter((voice) => voice.person !== null),
    (voice) => voice.person?.id ?? 0,
  );

const countDays = (voices: readonly BenchVoice[]) => new Set(voices.map((voice) => voice.day)).size;
const countRecordings = (voices: readonly BenchVoice[]) =>
  new Set(voices.map((voice) => voice.episodeId)).size;

/**
 * Whether a person keeps enough references for a recognition (three on two
 * days) whatever day of their phone voices is held out, counted in
 * recordings: two voices of one sitting are not two references' worth.
 */
function testableByDay(tests: readonly BenchVoice[], references: readonly BenchVoice[]): boolean {
  const days = new Set(tests.map((voice) => voice.day));
  if (days.size === 0) return false;
  return [...days].every((day) => {
    const left = references.filter((voice) => voice.day !== day);
    return countRecordings(left) >= RECOGNIZE_REFERENCES && countDays(left) >= RECOGNIZE_DAYS;
  });
}

type KnownOutcome = keyof KnownTally;
type StrangerOutcome = keyof Tally;
/** Worst first: one voice of a trial taken for someone else makes the trial wrong. */
const KNOWN_WORST: readonly KnownOutcome[] = [
  "recognizedWrong",
  "suggestedWrong",
  "recognizedRight",
  "suggestedRight",
  "none",
];
const STRANGER_WORST: readonly StrangerOutcome[] = ["recognized", "suggested", "none"];
const worst = <T>(order: readonly T[], outcomes: readonly T[]): T | undefined =>
  order.find((outcome) => outcomes.includes(outcome));

/** The named phone voices, one trial per person and recording. */
const trialsOf = (tests: readonly BenchVoice[]) => [
  ...Map.groupBy(tests, (voice) => `${voice.person?.id ?? 0}:${voice.episodeId}`).values(),
];

function measurePair(input: {
  readonly pair: PairId;
  readonly referencesOn: VoiceChannel;
  readonly holdout: Holdout;
  readonly rule: Rule;
  readonly tests: readonly BenchVoice[];
  readonly references: readonly BenchVoice[];
  readonly sameMoment: ReadonlyMap<number, ReadonlySet<number>>;
}): PairResult {
  // The rule built compares a phone voice with phone references as « the same
  // way », not measured, and with microphone references across channels; the
  // rule opened takes the pair as measured.
  const opened = input.rule === "opened";
  const measured = measuredChannels(opened || PHONE_VOICES_MEASURED);
  const same = opened || input.referencesOn === "phone";
  const known: KnownTally = {
    recognizedRight: 0,
    recognizedWrong: 0,
    suggestedRight: 0,
    suggestedWrong: 0,
    none: 0,
  };
  const strangers: Tally = { recognized: 0, suggested: 0, none: 0 };
  const knownPeople = new Set<number>();
  const strangerPeople = new Set<number>();
  const recognizedPeople = new Set<number>();
  const suggestedPeople = new Set<number>();
  let bestStranger: number | null = null;
  for (const trial of trialsOf(input.tests)) {
    const own = trial[0]?.person;
    const first = trial[0];
    if (own === null || own === undefined || first === undefined) continue;
    // A trial's voices share their recording, so their day and references.
    const gallery = byPerson(heldOut(first, input.references, input.holdout, input.sameMoment));
    // Known: the person's references are there.
    if (gallery.has(own.id)) {
      knownPeople.add(own.id);
      const outcomes = trial.map((test): KnownOutcome => {
        const match = decideVoice(scores(test, gallery, same), "phone", { measured });
        const right = match?.person.id === own.id;
        if (match === null) return "none";
        if (match.zone === "recognized") return right ? "recognizedRight" : "recognizedWrong";
        return right ? "suggestedRight" : "suggestedWrong";
      });
      known[worst(KNOWN_WORST, outcomes) ?? "none"] += 1;
    }
    // Stranger: the same voices, their person taken out.
    const others = new Map([...gallery].filter(([id]) => id !== own.id));
    if (others.size === 0) continue;
    strangerPeople.add(own.id);
    const outcomes = trial.map((test): StrangerOutcome => {
      const scored = scores(test, others, same);
      for (const score of scored) {
        const confidence = voiceConfidence(score.similarity);
        if (bestStranger === null || confidence > bestStranger) bestStranger = confidence;
      }
      const match = decideVoice(scored, "phone", { measured });
      return match === null ? "none" : match.zone === "recognized" ? "recognized" : "suggested";
    });
    const outcome = worst(STRANGER_WORST, outcomes) ?? "none";
    strangers[outcome] += 1;
    if (outcome === "recognized") recognizedPeople.add(own.id);
    if (outcome === "suggested") suggestedPeople.add(own.id);
  }
  return {
    pair: input.pair,
    holdout: input.holdout,
    rule: input.rule,
    knownPeople: knownPeople.size,
    known,
    strangerPeople: strangerPeople.size,
    strangers,
    strangerPeopleRecognized: recognizedPeople.size,
    strangerPeopleSuggested: suggestedPeople.size,
    bestStrangerConfidence: bestStranger,
  };
}

const knownTotal = (known: KnownTally) =>
  known.recognizedRight +
  known.recognizedWrong +
  known.suggestedRight +
  known.suggestedWrong +
  known.none;
const strangerTotal = (tally: Tally) => tally.recognized + tally.suggested + tally.none;

/**
 * The phone's report: both pairs, held out by episode and by day, under the
 * rule built and the rule a pass would open. `sameMoment` maps each episode
 * to those that may have heard the same moment (`sameMomentEpisodes`), left
 * out of its references.
 */
export function measurePhoneVoices(
  voices: readonly BenchVoice[],
  sameMoment: ReadonlyMap<number, ReadonlySet<number>> = new Map(),
): PhoneReport {
  const phone = voices.filter((voice) => voice.channel === "phone" && voice.phoneApp);
  const tests = phone.filter((voice) => voice.person !== null);
  const results: PairResult[] = [];
  for (const { id, references: on } of PAIRS) {
    const references = voices.filter(
      (voice) =>
        voice.person !== null && voice.channel === on && (on !== "phone" || voice.phoneApp),
    );
    for (const holdout of ["episode", "day"] as const) {
      for (const rule of ["built", "opened"] as const) {
        results.push(
          measurePair({
            pair: id,
            referencesOn: on,
            holdout,
            rule,
            tests,
            references,
            sameMoment,
          }),
        );
      }
    }
  }

  const microphone = byPerson(voices.filter((voice) => voice.channel === "microphone"));
  const phoneByPerson = byPerson(tests);
  const everyone = new Map(
    [...microphone, ...phoneByPerson].flatMap(([id, list]) =>
      list[0]?.person === null || list[0]?.person === undefined ? [] : [[id, list[0].person]],
    ),
  );
  const ordered = [...everyone.values()].toSorted(
    (a, b) =>
      Number(b.isSelf) - Number(a.isSelf) ||
      countRecordings(phoneByPerson.get(b.id) ?? []) -
        countRecordings(phoneByPerson.get(a.id) ?? []) ||
      countRecordings(microphone.get(b.id) ?? []) - countRecordings(microphone.get(a.id) ?? []) ||
      a.id - b.id,
  );
  const people: PersonRow[] = ordered.map((person, index) => {
    const mic = microphone.get(person.id) ?? [];
    const onPhone = phoneByPerson.get(person.id) ?? [];
    return {
      alias: `person ${index + 1}`,
      isSelf: person.isSelf,
      microphoneRecordings: countRecordings(mic),
      microphoneDays: countDays(mic),
      phoneRecordings: countRecordings(onPhone),
      phoneDays: countDays(onPhone),
      phoneTestableByDay: testableByDay(onPhone, onPhone),
      microphoneTestableByDay: testableByDay(onPhone, mic),
    };
  });

  const verdictOf = (pair: PairId): { verdict: Verdict; why: string } => {
    const result = results.find(
      (entry) => entry.pair === pair && entry.holdout === "day" && entry.rule === "opened",
    );
    if (result === undefined) return { verdict: "too-few", why: "not measured" };
    if (result.strangers.recognized > 0 || result.known.recognizedWrong > 0) {
      return {
        verdict: "fails",
        why: `${result.strangers.recognized} stranger trials and ${result.known.recognizedWrong} known ones recognized as someone else`,
      };
    }
    const testable = people.filter((person) =>
      pair === "phone-phone" ? person.phoneTestableByDay : person.microphoneTestableByDay,
    ).length;
    const missing = [
      ...(countDays(tests) < ENOUGH.days
        ? [`named phone voices on ${countDays(tests)} days of ${ENOUGH.days}`]
        : []),
      ...(testable < ENOUGH.people
        ? [`${testable} people recognizable held out by day, of ${ENOUGH.people}`]
        : []),
      ...(strangerTotal(result.strangers) < ENOUGH.strangerTrials
        ? [`${strangerTotal(result.strangers)} stranger trials of ${ENOUGH.strangerTrials}`]
        : []),
    ];
    return missing.length > 0
      ? { verdict: "too-few", why: missing.join("; ") }
      : { verdict: "passes", why: "no stranger recognized, nobody recognized as someone else" };
  };

  return {
    results,
    people,
    phoneVoices: {
      embedded: phone.length,
      named: tests.length,
      trials: trialsOf(tests).length,
      days: countDays(tests),
    },
    verdicts: {
      "phone-microphone": verdictOf("phone-microphone"),
      "phone-phone": verdictOf("phone-phone"),
    },
    phoneMeasured: PHONE_VOICES_MEASURED,
  };
}

/** Recordings of the user's phone inventory, from the database (`readBenchVoices`). */
export interface PhoneInventory {
  readonly appRecordings: number;
  readonly appRecordingDays: number;
  readonly appRecordingMinutes: number;
  readonly appRecordingsDeleted: number;
  /** Imported files heard on the phone channel: not the app's, never embedded (context `imported`). */
  readonly importedFiles: number;
  /** Unnamed phone voices, and what the app shows for them today (`voiceMatches`). */
  readonly unnamedToday: Tally;
  /** Pairs of recordings kept out of each other's references (`sameMomentEpisodes`)… */
  readonly sameMomentPairs: number;
  /** …of which M5.7 linked. */
  readonly sameMomentLinks: number;
}

const percent = (value: number | null) =>
  value === null ? "—" : `${(Math.floor(value * 1000) / 10).toFixed(1)} %`;

const PAIR_TITLE: Record<PairId, string> = {
  "phone-microphone": "A phone voice against microphone references",
  "phone-phone": "A phone voice against phone references",
};
const RULE_TITLE: Record<Rule, string> = {
  built: "built (suggested only, from 99 %)",
  opened: "opened (as measured: 80 % / 99 %)",
};

/** The report as Markdown for `bench/results/`: numbers only, people as « person n ». */
export function phoneReportMarkdown(input: {
  readonly date: string;
  readonly embedder: readonly string[];
  readonly inventory: PhoneInventory;
  readonly report: PhoneReport;
}): string {
  const { inventory, report } = input;
  const lines = [
    `# Phone voices, recognized? (ADR 030 for ADR 032, M5.8) — ${input.date}`,
    "",
    "`node apps/bench/src/cli.ts voices phone`, on a copy of Sondine's database on",
    "Téo's Mac (read only; the copy is deleted after the run). Only the voices the user",
    "named, as the app embedded them; dictations are not references here. People",
    "are numbered, never named. Embedder: " +
      (input.embedder.length === 0
        ? "none yet."
        : `${input.embedder.map((version) => `\`${version}\``).join(", ")}.`),
    "",
    "## What there is",
    "",
    `- Recordings made by the iPhone app: ${inventory.appRecordings} kept (${inventory.appRecordingMinutes.toFixed(1)} min, ${inventory.appRecordingDays} days), ${inventory.appRecordingsDeleted} deleted.`,
    `- Their voices embedded: ${report.phoneVoices.embedded}; named by the user: ${report.phoneVoices.named}, on ${report.phoneVoices.days} days, ${report.phoneVoices.trials} trials (a person in a recording).`,
    `- Unnamed phone voices, as the app shows them today: ${inventory.unnamedToday.recognized} recognized, ${inventory.unnamedToday.suggested} suggested, ${inventory.unnamedToday.none} nothing.`,
    `- Imported files on the phone channel (not the app's; never embedded, context \`imported\`): ${inventory.importedFiles}, left out.`,
    `- Recordings that may have heard the same moment, left out of each other's references: ${inventory.sameMomentPairs} pairs (linked by M5.7: ${inventory.sameMomentLinks}; the others meet on the clock, 2 minutes wider, 15 for an uncertain time).`,
    "",
    "Recognizable: three recordings on two days left whatever day of the person's phone",
    "recordings is held out, against phone references, and against microphone references.",
    "",
    "| Person | Microphone recordings named (days) | Phone recordings named (days) | Recognizable: phone / microphone references |",
    "| --- | --- | --- | --- |",
    ...report.people.map(
      (person) =>
        `| ${person.alias}${person.isSelf ? " (the user)" : ""} | ${person.microphoneRecordings} (${person.microphoneDays}) | ${person.phoneRecordings} (${person.phoneDays}) | ${person.phoneTestableByDay ? "yes" : "no"} / ${person.microphoneTestableByDay ? "yes" : "no"} |`,
    ),
    "",
    "## The rule, held out",
    "",
    "A trial is one person in one recording: every voice named as them there, the worst",
    "outcome counting (one voice taken for someone else makes the trial wrong). Known: the",
    "person has references left. Stranger: the same voices with their person's references",
    "taken out. Right / wrong: the person suggested or recognized.",
    "",
  ];
  for (const { id } of PAIRS) {
    lines.push(
      `### ${PAIR_TITLE[id]}`,
      "",
      "| Held out by | Rule | Known people (trials) | Recognized right / wrong | Suggested right / wrong | Nothing | Stranger people (trials) | Strangers recognized (people) | Strangers suggested (people) | Best stranger confidence |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...report.results
        .filter((result) => result.pair === id)
        .map(
          (r) =>
            `| ${r.holdout} | ${RULE_TITLE[r.rule]} | ${r.knownPeople} (${knownTotal(r.known)}) | ${r.known.recognizedRight} / ${r.known.recognizedWrong} | ${r.known.suggestedRight} / ${r.known.suggestedWrong} | ${r.known.none} | ${r.strangerPeople} (${strangerTotal(r.strangers)}) | ${r.strangers.recognized} (${r.strangerPeopleRecognized}) | ${r.strangers.suggested} (${r.strangerPeopleSuggested}) | ${percent(r.bestStrangerConfidence)} |`,
        ),
      "",
    );
  }
  const verdict = (id: PairId) => {
    const { verdict: v, why } = report.verdicts[id];
    return `- ${PAIR_TITLE[id]}, held out by day, rule opened: **${v}** (${why}).`;
  };
  lines.push(
    "## Verdict",
    "",
    verdict("phone-phone"),
    verdict("phone-microphone"),
    `- \`PHONE_VOICES_MEASURED\` (packages/db voices.ts) is ${report.phoneMeasured ? "on" : "off"}: ${report.phoneMeasured ? "a phone voice may be recognized against phone references" : "a phone voice is suggested only, from 99 %"}. It turns on only when the phone-against-phone pair passes; a voice compared across channels stays suggested only either way (ADR 030).`,
    `- Enough means: named phone voices on ${ENOUGH.days} days or more, ${ENOUGH.people} people or more (the user and three others) each recognizable whatever day is held out (${RECOGNIZE_REFERENCES} recordings on ${RECOGNIZE_DAYS} days left), and ${ENOUGH.strangerTrials} stranger trials or more. Zero strangers recognized among few people bounds nothing tightly: it is what was seen, not a rate.`,
    "",
  );
  return lines.join("\n");
}
