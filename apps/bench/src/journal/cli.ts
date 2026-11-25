import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findMeter, userPath } from "../paths.ts";
import {
  benchCandidates,
  commitmentLabelsSchema,
  exportAppCommitments,
  scoreCommitments,
  scoreRows,
  unjudgedMarkdown,
  type CommitmentExport,
} from "./commitments.ts";
import { checkCommitments } from "./check.ts";
import { fixtureRows, reviewMarkdown, summaryRows } from "./report.ts";
import { runJournalBench, type JournalBenchResult } from "./run.ts";
import { privateResults } from "./usage.ts";

const sondineDatabase = join(
  homedir(),
  "Library",
  "Group Containers",
  "P5G8WAJ2G2.app.sondine",
  "sondine.db",
);

export async function journalMain(
  command: string | undefined,
  args: readonly string[],
  usageError: (message: string) => Error,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      label: { type: "string" },
      engine: { type: "string" },
      effort: { type: "string" },
      model: { type: "string" },
      server: { type: "string" },
      days: { type: "string" },
      episodes: { type: "string" },
      labels: { type: "string" },
      config: { type: "string" },
      db: { type: "string" },
      language: { type: "string" },
      context: { type: "string" },
      socket: { type: "string" },
      meter: { type: "string" },
      out: { type: "string" },
    },
  });
  const out = values.out === undefined ? privateResults : userPath(values.out);
  const engine = values.engine ?? "llama";
  if (engine !== "llama" && engine !== "claude") throw usageError("--engine is llama or claude");
  /** A GGUF file for llama, a model alias for Claude. */
  const modelOf = (model: string) => (engine === "claude" ? model : userPath(model));
  const load = (label: string): JournalBenchResult =>
    JSON.parse(readFileSync(join(out, `${label}.json`), "utf8")) as JournalBenchResult;
  const labelsPath =
    values.labels === undefined ? join(out, "commitments", "labels.json") : userPath(values.labels);
  const readLabels = () =>
    commitmentLabelsSchema.parse(JSON.parse(readFileSync(labelsPath, "utf8")));
  /** A run's commitments: an export (the app, a check) or a bench result. */
  const candidatesOf = (label: string) => {
    const exported = join(out, `${label}.commitments.json`);
    return existsSync(exported)
      ? (JSON.parse(readFileSync(exported, "utf8")) as CommitmentExport)
      : benchCandidates(load(label));
  };
  /** `--episodes labels`: every episode the labels judge. */
  const episodeList = (value: string | undefined): number[] => {
    if (value === undefined) return [];
    if (value === "labels") {
      const labels = readLabels();
      return [
        ...new Set([...labels.units, ...labels.falses].map((entry) => entry.episodeId)),
      ].toSorted((a, b) => a - b);
    }
    return value.split(",").map((id) => {
      const number = Number(id.trim());
      if (!Number.isInteger(number) || number <= 0)
        throw usageError(`--episodes: "${id}" is not an episode id`);
      return number;
    });
  };
  switch (command) {
    case "run": {
      if (values.label === undefined || values.model === undefined || values.server === undefined) {
        throw usageError("journal run needs --label, --model and --server");
      }
      const language = values.language ?? "fr";
      if (language !== "fr" && language !== "en") throw usageError("--language is fr or en");
      const path = await runJournalBench({
        label: values.label,
        engine,
        model: modelOf(values.model),
        server: userPath(values.server),
        effort: values.effort ?? null,
        meter: values.meter === undefined ? null : findMeter(values.meter),
        database: values.db === undefined ? sondineDatabase : userPath(values.db),
        out,
        days: values.days === undefined ? [] : values.days.split(",").map((day) => day.trim()),
        episodes: episodeList(values.episodes),
        language,
        contextTokens: Number(values.context ?? 16_384),
        socketPath: values.socket ?? "/tmp/sondine-bench-journal.sock",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        log: (line) => console.error(line),
      });
      console.log(`written: ${path}`);
      return 0;
    }
    case "report": {
      if (positionals.length === 0) throw usageError("journal report needs labels");
      const results = positionals.map(load);
      console.log(`${summaryRows(results)}\n\n${fixtureRows(results)}`);
      return 0;
    }
    case "review": {
      const [label] = positionals;
      if (label === undefined) throw usageError("journal review needs a label");
      const path = join(out, `${label}-review.md`);
      writeFileSync(path, reviewMarkdown(load(label)), { mode: 0o600 });
      console.log(`written: ${path}`);
      return 0;
    }
    case "commitments": {
      const [action, ...labels] = positionals;
      if (action === "export") {
        const [label] = labels;
        if (label === undefined) throw usageError("journal commitments export needs a label");
        // A copy first: the app's database is never held open while it runs.
        mkdirSync(join(out, "commitments"), { recursive: true, mode: 0o700 });
        const snapshot = join(out, "commitments", "export.db");
        const source = new DatabaseSync(
          values.db === undefined ? sondineDatabase : userPath(values.db),
          {
            readOnly: true,
          },
        );
        await backup(source, snapshot);
        source.close();
        const db = new DatabaseSync(snapshot, { readOnly: true });
        const exported = exportAppCommitments(db, label, values.config ?? null);
        db.close();
        const path = join(out, `${label}.commitments.json`);
        writeFileSync(path, JSON.stringify(exported, null, 1), { mode: 0o600 });
        console.log(
          `written: ${path} (${exported.candidates.length} commitments, ${exported.episodes.length} episodes, ${exported.configKey})`,
        );
        return 0;
      }
      if (action === "score") {
        if (labels.length === 0) throw usageError("journal commitments score needs labels");
        const judged = readLabels();
        const restrict =
          values.episodes === undefined ? null : new Set(episodeList(values.episodes));
        const scores = labels.map((label) => {
          const run = candidatesOf(label);
          return scoreCommitments(judged, {
            label,
            episodes: run.episodes.filter((id) => restrict === null || restrict.has(id)),
            candidates: run.candidates.filter(
              (candidate) => restrict === null || restrict.has(candidate.episodeId),
            ),
          });
        });
        console.log(scoreRows(scores));
        const db =
          values.db === undefined
            ? null
            : new DatabaseSync(userPath(values.db), { readOnly: true });
        for (const score of scores) {
          const path = join(out, `${score.label}-unjudged.md`);
          writeFileSync(path, unjudgedMarkdown(score, db), { mode: 0o600 });
          console.error(`to judge: ${path}`);
        }
        db?.close();
        return 0;
      }
      if (action === "check") {
        const [label] = labels;
        if (
          label === undefined ||
          values.model === undefined ||
          values.server === undefined ||
          values.db === undefined
        ) {
          // The copy the run read: the app's own database may have changed since.
          throw usageError("journal commitments check needs a label, --model, --server and --db");
        }
        // The copy of the database the run read: the episodes as it read them.
        const path = await checkCommitments({
          run: candidatesOf(label),
          out,
          database: userPath(values.db),
          engine,
          model: modelOf(values.model),
          server: userPath(values.server),
          effort: values.effort ?? null,
          socketPath: values.socket ?? "/tmp/sondine-bench-journal.sock",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          log: (line) => console.error(line),
        });
        console.log(`written: ${path}`);
        return 0;
      }
      throw usageError("journal commitments is export, score or check");
    }
    default:
      throw usageError(
        command === undefined ? "journal needs a command" : `unknown journal command "${command}"`,
      );
  }
}
