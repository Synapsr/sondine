import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import {
  applyVocabulary,
  buildVocabularyCheck,
  namesWrittenIn,
  readVocabularyCheck,
  VOCABULARY_CHECK_BATCH,
} from "@sondine/core";
import {
  addVocabularyWord,
  finishVocabularyPass,
  loadVocabularyCheck,
  nextVocabularyEpisode,
  openDatabase,
  respellEpisode,
  vocabularyNamesKey,
  vocabularyNotes,
  vocabularyOf,
} from "@sondine/db";
import { userPath } from "../paths.ts";
import { benchTextEngine } from "../journal/run.ts";

// `sondine-bench vocabulary run` (ADR 046): the Vocabulary's two rules on a
// COPY of Sondine's database (it writes to it, as the app would): the words
// that sound like one of the user's names, rewritten without a model, and
// the words that only look like one, read by the journal's model. Prints
// counts and costs only; what was heard and decided goes to `--out`, which
// must be private (mode 0600 files), never the repository.

const exec = promisify(execFile);

/** The process's resident memory, bytes; null once gone. */
async function residentBytes(pid: number): Promise<number | null> {
  try {
    const { stdout } = await exec("ps", ["-o", "rss=", "-p", String(pid)]);
    const kib = Number(stdout.trim());
    return Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
  } catch {
    return null;
  }
}

export async function vocabularyMain(
  command: string | undefined,
  args: readonly string[],
  usageError: (message: string) => Error,
): Promise<number> {
  if (command !== "run") throw usageError(`unknown vocabulary command: ${command ?? ""}`);
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      db: { type: "string" },
      model: { type: "string" },
      server: { type: "string" },
      out: { type: "string" },
      words: { type: "string" },
      socket: { type: "string" },
      "no-model": { type: "boolean" },
    },
  });
  if (values.db === undefined || values.out === undefined)
    throw usageError("--db and --out are required");
  const useModel = values["no-model"] !== true;
  if (useModel && (values.model === undefined || values.server === undefined)) {
    throw usageError("--model and --server are required, or --no-model");
  }
  const out = userPath(values.out);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const db = openDatabase(userPath(values.db));
  const nowMs = Date.now();
  for (const entry of (values.words ?? "").split(",").filter((word) => word.trim() !== "")) {
    const [word = "", note = null] = entry.split("=");
    addVocabularyWord(db, { word, note, nowMs });
  }
  const vocabulary = vocabularyOf(db);
  const namesKey = vocabularyNamesKey(db, { model: useModel });
  const notes = vocabularyNotes(db);

  // The rule without the model, word by word (private), before the queue applies it.
  const sinceMs = nowMs - 7 * 86_400_000;
  const episodes = db
    .statement(
      `SELECT e.id FROM episodes e JOIN episode_analysis a ON a.episode_id = e.id AND a.stage = 'asr'
       WHERE e.state = 'closed' AND e.context IN ('call', 'in_person', 'mixed', 'imported')
         AND e.started_at_ms >= ? ORDER BY e.started_at_ms`,
    )
    .all(sinceMs)
    .map((row) => Number(row["id"]));
  const sounding = new Map<string, number>();
  let segments = 0;
  for (const episodeId of episodes) {
    const texts = db
      .statement(
        `SELECT s.text FROM segments s JOIN episode_analysis a ON a.run_id = s.run_id AND a.stage = 'asr'
         WHERE s.episode_id = ? AND s.edit_id IS NULL`,
      )
      .all(episodeId)
      .map((row) => String(row["text"]));
    segments += texts.length;
    const written = namesWrittenIn(texts);
    for (const text of texts) {
      const { segment } = applyVocabulary({ text }, vocabulary, written);
      const before = text.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? [];
      const after = segment.text.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? [];
      for (const [index, word] of before.entries()) {
        if (after[index] !== word) {
          const pair = `${word} → ${after[index] ?? ""}`;
          sounding.set(pair, (sounding.get(pair) ?? 0) + 1);
        }
      }
    }
  }

  // The words that only look like a name, through the scheduler's own queue.
  const engine = useModel
    ? benchTextEngine({
        label: "vocabulary",
        engine: "llama",
        model: userPath(values.model ?? ""),
        server: userPath(values.server ?? ""),
        effort: null,
        contextTokens: 16_384,
        socketPath: values.socket ?? "/tmp/sondine-bench-vocabulary.sock",
      })
    : null;
  let peakBytes = 0;
  let sampler: ReturnType<typeof setInterval> | null = null;
  const decided: { word: string; name: string; userWord: boolean | null; segmentId: number }[] = [];
  const cost = {
    loadMs: 0,
    requests: 0,
    promptTokens: 0,
    outputTokens: 0,
    computeMs: 0,
    wallMs: 0,
    failed: 0,
  };
  let passes = 0;
  let corrected = 0;
  let spelled = 0;
  try {
    if (engine !== null) {
      cost.loadMs = (await engine.load()).loadMs;
      const pid = engine.pid();
      if (pid !== undefined) {
        sampler = setInterval(() => {
          void residentBytes(pid).then((bytes) => {
            if (bytes !== null) peakBytes = Math.max(peakBytes, bytes);
          });
        }, 250);
      }
    }
    for (;;) {
      const episodeId = nextVocabularyEpisode(db, { namesKey, nowMs });
      if (episodeId === null) break;
      passes += 1;
      // As the scheduler's queue does: the rule first, then the model on what is left.
      spelled += respellEpisode(db, episodeId, vocabulary, nowMs);
      const check = loadVocabularyCheck(db, episodeId, vocabulary, notes);
      if (check === null) break;
      const answers: { target: (typeof check.targets)[number]; userWord: boolean }[] = [];
      let failed = false;
      if (engine === null) {
        for (const target of check.targets) {
          decided.push({
            word: target.word,
            name: target.name,
            userWord: null,
            segmentId: target.segmentId,
          });
        }
      } else {
        for (let start = 0; start < check.targets.length; start += VOCABULARY_CHECK_BATCH) {
          const batch = check.targets.slice(start, start + VOCABULARY_CHECK_BATCH);
          const request = buildVocabularyCheck(batch);
          const began = performance.now();
          const result = await engine.generate(
            {
              id: `vocabulary-${episodeId}-${start}`,
              system: request.system,
              user: request.user,
              schema: request.schema,
              maxOutputTokens: request.maxOutputTokens,
            },
            {},
          );
          cost.wallMs += performance.now() - began;
          cost.requests += 1;
          cost.promptTokens += result.metrics.promptTokens;
          cost.outputTokens += result.metrics.outputTokens;
          cost.computeMs += result.metrics.computeMs;
          const verdicts =
            result.stop === "complete" ? readVocabularyCheck(request, result.text) : null;
          if (verdicts === null) {
            failed = true;
            cost.failed += 1;
          }
          for (const [index, target] of batch.entries()) {
            const userWord = verdicts?.[index] ?? null;
            decided.push({
              word: target.word,
              name: target.name,
              userWord,
              segmentId: target.segmentId,
            });
            if (userWord !== null) answers.push({ target, userWord });
          }
        }
      }
      corrected += finishVocabularyPass(db, {
        episodeId,
        runId: check.runId,
        namesKey,
        status: failed ? "failed" : "done",
        answers,
        candidates: check.targets.length,
        nowMs,
      });
      if (failed) {
        // Asked once: a failed pass would come back after 10 minutes only.
        db.statement("UPDATE vocabulary_passes SET attempts = 99 WHERE episode_id = ?").run(
          episodeId,
        );
      }
    }
  } finally {
    if (sampler !== null) clearInterval(sampler);
    await engine?.unload();
    db.close();
  }
  const pairs = new Map<string, { user: number; written: number; failed: number }>();
  for (const entry of decided) {
    const key = `${entry.word} ~ ${entry.name}`;
    const counts = pairs.get(key) ?? { user: 0, written: 0, failed: 0 };
    if (entry.userWord === null) counts.failed += 1;
    else if (entry.userWord) counts.user += 1;
    else counts.written += 1;
    pairs.set(key, counts);
  }
  // Words heard and decided: private.
  writeFileSync(
    join(out, "vocabulary-decisions.json"),
    JSON.stringify(
      { sounding: Object.fromEntries(sounding), looking: Object.fromEntries(pairs), decided },
      null,
      1,
    ),
    { mode: 0o600 },
  );
  const summary = {
    episodes: episodes.length,
    segments,
    soundingRewritten: [...sounding.values()].reduce((sum, n) => sum + n, 0),
    spelled,
    passes,
    candidates: decided.length,
    candidateSegments: new Set(decided.map((entry) => entry.segmentId)).size,
    userWord: decided.filter((entry) => entry.userWord === true).length,
    asWritten: decided.filter((entry) => entry.userWord === false).length,
    corrected,
    ...cost,
    peakResidentBytes: peakBytes,
  };
  console.log(JSON.stringify(summary, null, 1));
  return 0;
}
