import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transaction } from "./database";
import { loadEpisodeDay, type DayHour } from "./episode-day";
import { listEpisodes, summaryColumns, timelineLaneSql, transcribedSql } from "./episodes-store";
import { matchingSegmentIds, searchEpisodes } from "./search";
import { compileSearchQuery, highlightRanges } from "./search-match";
import { searchTextOf } from "./search-text";
import { seedTrackRun, tempDatabase, type TempDatabase } from "./test-helpers";

// Opt-in: SONDINE_BENCH=1 pnpm --filter @sondine/db bench
// The read models of Today and Search on a synthetic day of 2 000 episodes
// (30 conversations, 900 moments, 100 media, 970 traces) after 29 days of
// 500 episodes each. Prints time per call and the query plans; no text.
const enabled = process.env["SONDINE_BENCH"] === "1";

const HOUR = 3_600_000;
const dayStart = Date.UTC(2026, 10, 2);
const hours: DayHour[] = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  startMs: dayStart + hour * HOUR,
  endMs: dayStart + (hour + 1) * HOUR,
}));
const day = { fromMs: dayStart, toMs: dayStart + 24 * HOUR };

/** Deterministic pseudo-random numbers (mulberry32). */
function random(initial: number): () => number {
  let state = initial;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const words = (
  "le la les un une de des du et est à au pour pas que qui on il elle nous vous ils " +
  "demain matin soir réunion projet client devis rendez-vous médecin école l'école " +
  "train gare café semaine prochaine lundi mardi heure minute ok oui non alors voilà " +
  "faut faire dire aller venir voir prendre mettre envoyer lien doc mail compta"
).split(" ");

function sentence(next: () => number, rare: boolean): string {
  const length = 6 + Math.floor(next() * 14);
  const list = Array.from({ length }, () => words[Math.floor(next() * words.length)] ?? "le");
  if (rare) list.splice(Math.floor(next() * list.length), 0, "budget");
  if (next() < 0.1) list.push(String(Math.floor(next() * 100)));
  return `${list.join(" ")}.`;
}

interface Plan {
  readonly size: "conversation" | "moment" | "trace";
  readonly context: "in_person" | "media" | "mixed";
  readonly segments: number;
  readonly transcribed: boolean;
}

function seed(temp: TempDatabase): void {
  const db = temp.db;
  const trackRunId = seedTrackRun(db);
  const next = random(7);
  const episode = db.statement(
    `INSERT INTO episodes (state, context, size, size_state, analysis_state, started_at_ms,
       ended_at_ms, voiced_ms, grouping_version, classifier_version, created_at_ms, updated_at_ms)
     VALUES ('closed', ?, ?, 'final', ?, ?, ?, ?, 'g1', 'c1', ?, ?)`,
  );
  const run = db.statement(
    `INSERT INTO analysis_runs (episode_id, stage, status, engine_id, engine_version,
       engine_runtime, adapter_class, input_hash, input_generation, started_at_ms, published_at_ms)
     VALUES (?, 'asr', 'published', 'bench', '1', 'bench', 'product', 'h', 1, ?, ?)`,
  );
  const current = db.statement(
    `INSERT INTO episode_analysis (episode_id, stage, run_id, input_generation, published_at_ms)
     VALUES (?, 'asr', ?, 1, ?)`,
  );
  const speaker = db.statement(
    `INSERT INTO episode_speakers (episode_id, run_id, label, ordinal, voiced_ms) VALUES (?, ?, ?, ?, 0)`,
  );
  const segment = db.statement(
    `INSERT INTO segments (run_id, episode_id, track_run_id, seq, sample_start, sample_end,
       start_ms, end_ms, speaker_label, episode_speaker_id, text, search_text, lang)
     VALUES (?, ?, ?, ?, 0, 16000, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const add = (startMs: number, plan: Plan) => {
    const id = Number(
      episode.run(
        plan.context,
        plan.size,
        plan.transcribed ? "complete" : "queued",
        startMs,
        startMs + plan.segments * 5_000 + 1_000,
        plan.segments * 4_000,
        startMs,
        startMs,
      ).lastInsertRowid,
    );
    if (!plan.transcribed) return;
    const runId = Number(run.run(id, startMs, startMs).lastInsertRowid);
    current.run(id, runId, startMs);
    const speakers = [1, 2].map((ordinal) =>
      Number(speaker.run(id, runId, `S${ordinal}`, ordinal).lastInsertRowid),
    );
    for (let seq = 0; seq < plan.segments; seq++) {
      const text = sentence(next, next() < 0.01);
      const label = seq % 2;
      segment.run(
        runId,
        id,
        trackRunId,
        seq,
        startMs + seq * 5_000,
        startMs + seq * 5_000 + 4_000,
        `S${label + 1}`,
        speakers[label] ?? null,
        text,
        searchTextOf(text),
      );
    }
  };
  const dayPlan = (count: number): Plan[] => [
    ...Array.from({ length: Math.round(count * 0.015) }, (): Plan => ({
      size: "conversation",
      context: next() < 0.1 ? "mixed" : "in_person",
      segments: 120,
      transcribed: true,
    })),
    ...Array.from({ length: Math.round(count * 0.45) }, (): Plan => ({
      size: "moment",
      context: "in_person",
      segments: 3,
      transcribed: next() < 0.7,
    })),
    ...Array.from({ length: Math.round(count * 0.05) }, (): Plan => ({
      size: "conversation",
      context: "media",
      segments: 20,
      transcribed: next() < 0.5,
    })),
    ...Array.from({ length: Math.round(count * 0.485) }, (): Plan => ({
      size: "trace",
      context: "in_person",
      segments: 0,
      transcribed: false,
    })),
  ];
  transaction(db, () => {
    for (let back = 29; back >= 0; back--) {
      const start = dayStart - back * 24 * HOUR;
      const plans = dayPlan(back === 0 ? 2_000 : 500);
      for (const plan of plans) add(start + Math.floor(next() * 24 * HOUR), plan);
    }
  });
  db.client.exec("INSERT INTO segments_fts (segments_fts) VALUES ('rebuild')");
  db.client.exec("ANALYZE");
}

interface Timing {
  readonly medianMs: number;
  readonly p95Ms: number;
}

function time(fn: () => unknown, runs = 40): Timing {
  for (let warm = 0; warm < 3; warm++) fn();
  const samples: number[] = [];
  for (let index = 0; index < runs; index++) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const pick = (q: number) =>
    Number((samples[Math.floor(q * (samples.length - 1))] ?? 0).toFixed(2));
  return { medianMs: pick(0.5), p95Ms: pick(0.95) };
}

describe.runIf(enabled)("Today and search read models (SONDINE_BENCH=1)", () => {
  let temp: TempDatabase;
  beforeAll(() => {
    temp = tempDatabase();
    seed(temp);
  }, 120_000);
  afterAll(() => temp.cleanup());

  const plan = (sql: string, ...params: (number | string | null)[]) =>
    temp.db.client
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => `${"  ".repeat(Number(row["parent"]) === 0 ? 0 : 1)}${String(row["detail"])}`);

  it("measures one day and its hours", () => {
    const counts = temp.db.client
      .prepare(
        `SELECT (SELECT count(*) FROM episodes) AS episodes, (SELECT count(*) FROM segments) AS segments,
           (SELECT count(*) FROM episodes WHERE started_at_ms >= ? AND started_at_ms < ?) AS today`,
      )
      .get(day.fromMs, day.toMs);
    console.log("data", counts);
    const result = loadEpisodeDay(temp.db, { ...day, hours, pageSize: 100 });
    expect(result.momentHours.reduce((sum, hour) => sum + hour.moments, 0)).toBe(900);
    console.log(
      "episodes.day",
      time(() => loadEpisodeDay(temp.db, { ...day, hours, pageSize: 100 })),
    );
    console.log(
      "  of which conversations + media pages",
      time(() => {
        listEpisodes(temp.db, { ...day, limit: 100, lane: "conversations" });
        listEpisodes(temp.db, { ...day, limit: 100, lane: "media" });
      }),
    );
    const fourteen = { fromMs: dayStart + 14 * HOUR, toMs: dayStart + 15 * HOUR, limit: 200 };
    console.log(
      "episodes.list hour 14 moments",
      time(() => listEpisodes(temp.db, { ...fourteen, lane: "moments" })),
    );
    const first = listEpisodes(temp.db, { ...day, limit: 200 });
    const after = first.next ?? undefined;
    console.log(
      "episodes.list day page 1 (200)",
      time(() => listEpisodes(temp.db, { ...day, limit: 200 })),
    );
    console.log(
      "episodes.list day page 2 (cursor)",
      time(() =>
        listEpisodes(temp.db, { ...day, limit: 200, ...(after === undefined ? {} : { after }) }),
      ),
    );
    console.log(
      "plan: day scan\n",
      plan(
        `SELECT e.id, e.started_at_ms, e.updated_at_ms, ${timelineLaneSql} AS lane, ${transcribedSql} AS t,
           CASE WHEN ${timelineLaneSql} = 'moments' THEN EXISTS (SELECT 1 FROM segments s WHERE s.episode_id = e.id) ELSE 0 END
         FROM episodes e WHERE e.started_at_ms >= ? AND e.started_at_ms < ? ORDER BY e.started_at_ms DESC, e.id DESC`,
        day.fromMs,
        day.toMs,
      ).join("\n "),
    );
    console.log(
      "plan: lane page\n",
      plan(
        `SELECT ${summaryColumns} FROM episodes e
         WHERE e.started_at_ms >= ? AND e.started_at_ms < ? AND (? IS NULL OR ${timelineLaneSql} = ?)
           AND (? IS NULL OR e.started_at_ms < ? OR e.id < ?)
         ORDER BY e.started_at_ms DESC, e.id DESC LIMIT 201`,
        day.fromMs,
        day.toMs,
        "conversations",
        "conversations",
        null,
        null,
        null,
      ).join("\n "),
    );
  });

  it("measures search, grouped by episode", () => {
    const options = { limit: 20, offset: 0 };
    const rare = searchEpisodes(temp.db, "budget", options);
    const common = searchEpisodes(temp.db, "demain", options);
    console.log("matches", {
      rare: rare.total,
      common: common.total,
      untranscribed: rare.untranscribed,
    });
    console.log(
      "search rare word, all time",
      time(() => searchEpisodes(temp.db, "budget", options), 20),
    );
    console.log(
      "search common word, all time",
      time(() => searchEpisodes(temp.db, "demain", options), 10),
    );
    console.log(
      "search common word, one day",
      time(() => searchEpisodes(temp.db, "demain", { ...options, ...day }), 10),
    );
    console.log(
      "search 2-letter prefix, conversations",
      time(() => searchEpisodes(temp.db, "bu", { ...options, sizes: ["conversation"] }), 10),
    );
    console.log(
      "search with nothing searchable (untranscribed count only), all time",
      time(() => searchEpisodes(temp.db, "...", options)),
    );
    console.log(
      "search with nothing searchable (untranscribed count only), one day",
      time(() => searchEpisodes(temp.db, "...", { ...options, ...day })),
    );
    console.log(
      "search page 5 of a common word",
      time(() => searchEpisodes(temp.db, "demain", { limit: 20, offset: 80 }), 10),
    );
    const conversation = temp.db.client
      .prepare(
        `SELECT id FROM episodes WHERE size = 'conversation' AND context <> 'media'
           AND started_at_ms >= ? ORDER BY id LIMIT 1`,
      )
      .get(day.fromMs);
    const episodeId = Number(conversation?.["id"]);
    const query = compileSearchQuery("demain");
    const texts = temp.db.client
      .prepare("SELECT id, text, lang FROM segments WHERE episode_id = ?")
      .all(episodeId);
    console.log(
      "episodes.get q (120 segments: FTS ids + highlights)",
      time(() => {
        const ids = matchingSegmentIds(temp.db, query, episodeId);
        for (const row of texts) {
          if (ids.has(Number(row["id"]))) highlightRanges(String(row["text"]), null, query);
        }
      }),
    );
    console.log(
      "highlightRanges, one segment",
      time(() => highlightRanges(String(texts[0]?.["text"]), null, query), 200),
    );
    console.log(
      "plan: search page\n",
      plan(
        `SELECT e.id, count(*), count(*) OVER () FROM segments_fts
         JOIN segments s ON s.id = segments_fts.rowid JOIN episodes e ON e.id = s.episode_id
         WHERE segments_fts MATCH ? AND (? IS NULL OR e.started_at_ms >= ?)
         GROUP BY e.id ORDER BY e.started_at_ms DESC, e.id DESC LIMIT 20`,
        '"demain"',
        null,
        null,
      ).join("\n "),
    );
    console.log(
      "plan: untranscribed, one day\n",
      plan(
        `SELECT count(*) FROM episodes e WHERE e.state = 'closed' AND coalesce(e.size, 'moment') <> 'trace'
           AND e.started_at_ms >= ? AND e.started_at_ms < ? AND NOT ${transcribedSql}`,
        day.fromMs,
        day.toMs,
      ).join("\n "),
    );
  });
});
