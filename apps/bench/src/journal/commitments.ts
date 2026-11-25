import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { JournalBenchResult } from "./run.ts";

// Scores the journal's commitments against a person's labels (ADR 028):
// which ones are real (a "unit": the sentences that make one promise, and
// who made it), and which sentences hold none (a "false" sentence and why).
// The labels quote nothing: episode ids, segment ids, speaker labels and a
// short note. They stay in the private results folder all the same, with the
// runs they judge.

export const FALSE_FAMILIES = [
  "question",
  "request",
  "suggestion",
  "reported",
  "information",
  "past",
  "fragment",
  "immediate",
  "vague",
  "duplicate",
  "not-conversation",
  /** A plan or an intention of one's own, which nobody is owed. */
  "intention",
  /** Cites a real promise, but gives it to the wrong voice. */
  "wrong-person",
] as const;
export type FalseFamily = (typeof FALSE_FAMILIES)[number];

const unitSchema = z.object({
  id: z.string(),
  episodeId: z.number().int(),
  /** The promiser's sentence first: its speaker is `who`. */
  segments: z.array(z.number().int()).min(1),
  /** 1 a commitment, 0.5 borderline (an intention, an offer). */
  grade: z.union([z.literal(1), z.literal(0.5)]),
  who: z.string().nullable(),
  /** Tells apart two promises of one sentence: a pattern the item's words match. */
  words: z.string().optional(),
  note: z.string().optional(),
});

export const commitmentLabelsSchema = z.object({
  version: z.literal(1),
  units: z.array(unitSchema),
  falses: z.array(
    z.object({
      episodeId: z.number().int(),
      segments: z.array(z.number().int()).min(1),
      family: z.enum(FALSE_FAMILIES),
    }),
  ),
});
export type CommitmentLabels = z.infer<typeof commitmentLabelsSchema>;

/** One commitment written, by whoever wrote it (a bench run or the app). */
export interface CommitmentCandidate {
  readonly episodeId: number;
  /** The promiser's speaker label, null when the model gave none. */
  readonly whoLabel: string | null;
  /** Whom it was promised to; absent in older files. */
  readonly toLabel?: string | null;
  readonly text: string;
  readonly segmentIds: readonly number[];
}

/** What the app wrote, read from its database (`journal commitments export`). */
export interface CommitmentExport {
  readonly schema: "sondine.bench.journal-commitments";
  readonly label: string;
  readonly configKey: string;
  readonly episodes: readonly number[];
  readonly candidates: readonly CommitmentCandidate[];
}

export type Verdict =
  | { readonly kind: "right"; readonly unit: string; readonly grade: number }
  | { readonly kind: "false"; readonly family: FalseFamily }
  | { readonly kind: "unjudged" };

export interface CommitmentScore {
  readonly label: string;
  readonly episodes: number;
  readonly written: number;
  /** Grades of the units found, summed. */
  readonly right: number;
  readonly unjudged: number;
  readonly families: Readonly<Partial<Record<FalseFamily, number>>>;
  /** Grades of the labelled units in the episodes the run covered. */
  readonly possible: number;
  readonly found: readonly string[];
  readonly missed: readonly string[];
  readonly verdicts: readonly { candidate: CommitmentCandidate; verdict: Verdict }[];
}

const overlaps = (a: readonly number[], b: readonly number[]) => a.some((id) => b.includes(id));

/**
 * Each candidate, in order: a unit it cites (the one whose words it matches
 * first, then one not found yet), right once and a duplicate after, the
 * wrong person when another voice made that promise; else the family of a
 * false sentence it cites; else unjudged.
 */
export function scoreCommitments(
  labels: CommitmentLabels,
  run: {
    readonly label: string;
    readonly episodes: readonly number[];
    readonly candidates: readonly CommitmentCandidate[];
  },
): CommitmentScore {
  const covered = new Set(run.episodes);
  const units = labels.units.filter((unit) => covered.has(unit.episodeId));
  const found = new Set<string>();
  const families: Partial<Record<FalseFamily, number>> = {};
  const verdicts: { candidate: CommitmentCandidate; verdict: Verdict }[] = [];
  let right = 0;
  let unjudged = 0;
  const count = (family: FalseFamily) => {
    families[family] = (families[family] ?? 0) + 1;
    return { kind: "false", family } as const;
  };
  for (const candidate of run.candidates) {
    const cited = units.filter(
      (unit) =>
        unit.episodeId === candidate.episodeId && overlaps(unit.segments, candidate.segmentIds),
    );
    const rank = (unit: (typeof cited)[number]) =>
      (unit.words !== undefined && new RegExp(unit.words, "iu").test(candidate.text) ? 0 : 2) +
      (found.has(unit.id) ? 1 : 0);
    const unit = cited.toSorted((a, b) => rank(a) - rank(b))[0];
    let verdict: Verdict;
    if (unit !== undefined) {
      if (unit.who !== null && candidate.whoLabel !== unit.who) verdict = count("wrong-person");
      else if (found.has(unit.id)) verdict = count("duplicate");
      else {
        found.add(unit.id);
        right += unit.grade;
        verdict = { kind: "right", unit: unit.id, grade: unit.grade };
      }
    } else {
      const sentence = labels.falses.find(
        (other) =>
          other.episodeId === candidate.episodeId && overlaps(other.segments, candidate.segmentIds),
      );
      if (sentence !== undefined) verdict = count(sentence.family);
      else {
        unjudged += 1;
        verdict = { kind: "unjudged" };
      }
    }
    verdicts.push({ candidate, verdict });
  }
  return {
    label: run.label,
    episodes: covered.size,
    written: run.candidates.length,
    right,
    unjudged,
    families,
    possible: units.reduce((sum, unit) => sum + unit.grade, 0),
    found: [...found],
    missed: units.filter((unit) => !found.has(unit.id)).map((unit) => unit.id),
    verdicts,
  };
}

/** A bench run's commitments, in the episodes it wrote. */
export function benchCandidates(result: JournalBenchResult): {
  readonly label: string;
  readonly episodes: readonly number[];
  readonly candidates: readonly CommitmentCandidate[];
} {
  const episodes = new Set<number>();
  for (const day of result.days) for (const window of day.windows) episodes.add(window.episodeId);
  return {
    label: result.label,
    episodes: [...episodes],
    candidates: result.days.flatMap((day) =>
      day.items.flatMap((record) =>
        record.item.kind === "commitment"
          ? [
              {
                episodeId: record.episodeId,
                whoLabel: record.whoLabel ?? null,
                toLabel: record.toLabel ?? null,
                text: record.item.text,
                segmentIds: record.item.segmentIds,
              },
            ]
          : [],
      ),
    ),
  };
}

/**
 * The commitments the app published with one configuration, and the
 * episodes it wrote with it, from a copy of its database.
 */
export function exportAppCommitments(
  db: DatabaseSync,
  label: string,
  configKey: string | null,
): CommitmentExport {
  const key =
    configKey ??
    String(
      db
        .prepare(
          `SELECT config_key FROM journal_runs WHERE status = 'published'
           GROUP BY config_key ORDER BY count(*) DESC LIMIT 1`,
        )
        .get()?.["config_key"] ?? "",
    );
  const runs = db
    .prepare(
      `SELECT id, episode_id, speaker_refs FROM journal_runs
       WHERE status = 'published' AND config_key = ? ORDER BY episode_id`,
    )
    .all(key);
  const items = db.prepare(
    `SELECT id, text, who_ref, to_ref FROM journal_items WHERE run_id = ? AND kind = 'commitment'
     ORDER BY start_ms, seq`,
  );
  const citations = db.prepare(
    "SELECT segment_id FROM journal_citations WHERE item_id = ? ORDER BY ord",
  );
  const candidates: CommitmentCandidate[] = [];
  for (const run of runs) {
    const refs = z.record(z.string(), z.string()).parse(JSON.parse(String(run["speaker_refs"])));
    for (const item of items.all(Number(run["id"]))) {
      const who = item["who_ref"] === null ? null : String(item["who_ref"]);
      const to = item["to_ref"] === null ? null : String(item["to_ref"]);
      candidates.push({
        episodeId: Number(run["episode_id"]),
        whoLabel: who === null ? null : (refs[who] ?? null),
        toLabel: to === null ? null : (refs[to] ?? null),
        text: String(item["text"]),
        segmentIds: citations.all(Number(item["id"])).map((row) => Number(row["segment_id"])),
      });
    }
  }
  return {
    schema: "sondine.bench.journal-commitments",
    label,
    configKey: key,
    episodes: runs.map((run) => Number(run["episode_id"])),
    candidates,
  };
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "—" : `${Math.round((part / whole) * 100)} %`;

/** Numbers only, for bench/results. */
export function scoreRows(scores: readonly CommitmentScore[]): string {
  const lines = [
    "| Run | Episodes | Written | Right | Precision | Recall | Unjudged |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const score of scores) {
    lines.push(
      `| ${score.label} | ${score.episodes} | ${score.written} | ${score.right} | ${percent(score.right, score.written)} | ${score.right} of ${score.possible} (${percent(score.right, score.possible)}) | ${score.unjudged} |`,
    );
  }
  const families = FALSE_FAMILIES.filter((family) =>
    scores.some((score) => (score.families[family] ?? 0) > 0),
  );
  lines.push(
    "",
    `| Wrong, by family | ${scores.map((score) => score.label).join(" | ")} |`,
    `| --- | ${scores.map(() => "---").join(" | ")} |`,
  );
  for (const family of families) {
    lines.push(`| ${family} | ${scores.map((score) => score.families[family] ?? 0).join(" | ")} |`);
  }
  return lines.join("\n");
}

/**
 * Private: each unjudged commitment with the lines around what it cites,
 * and the units the run missed, for the person who labels.
 */
export function unjudgedMarkdown(score: CommitmentScore, db: DatabaseSync | null): string {
  const out = [`# ${score.label}: to judge`, ""];
  const around = db?.prepare(
    `SELECT s.id, s.speaker_label, s.text FROM segments s
     JOIN segments c ON c.id = ? AND s.run_id = c.run_id AND s.episode_id = c.episode_id
     WHERE s.seq BETWEEN c.seq - 3 AND c.seq + 2 ORDER BY s.seq`,
  );
  for (const { candidate, verdict } of score.verdicts) {
    if (verdict.kind !== "unjudged") continue;
    out.push(
      `- episode ${candidate.episodeId}, ${candidate.whoLabel ?? "?"}: ${candidate.text} (cites ${candidate.segmentIds.join(", ")})`,
    );
    const first = candidate.segmentIds[0];
    if (around === undefined || first === undefined) continue;
    for (const row of around.all(first)) {
      const mark = candidate.segmentIds.includes(Number(row["id"])) ? ">>" : "  ";
      out.push(`    ${mark} [${row["id"]}] ${row["speaker_label"]}: ${String(row["text"])}`);
    }
  }
  out.push("", `Missed: ${score.missed.join(", ") || "none"}`);
  return out.join("\n");
}
