// Adds one invented two-hour call, with many voices, to a development data
// folder already seeded (seed.ts): the long transcript the episode screen is
// measured on (transcript-perf.ts), and the voices it is tried with. Every
// name and word is made up. With a shape file (a JSON list of
// `{ s, e, l, n }`: start and end in ms from the call's start, speaker label,
// text length), the call takes that shape instead of a random one: a real
// conversation's timing without any of its words. Shape files stay outside
// the repository.
//
// Usage: node scripts/ux/long-call.ts <data-folder> [shape.json]
// Prints the new episode's id.

import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || context.parentURL?.endsWith(".ts") !== true) throw error;
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
  },
});

const { openDatabase, upsertTrackRun, openSpeechRegion, closeSpeechRegion, publishAnalysis } =
  await import("@sondine/db");
const { nameSpeaker } = await import("@sondine/db");

const RATE = 16_000;
const VERSION = "wespeaker-v2:ux:sondine-windows-v1";

interface Shape {
  readonly s: number;
  readonly e: number;
  readonly l: string;
  readonly n: number;
}

const [folder, shapeFile] = process.argv.slice(2);
if (folder === undefined) throw new Error("usage: node scripts/ux/long-call.ts <folder> [shape]");
const db = openDatabase(join(folder, "sondine.db"));

let seed = 1_339;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

const WORDS =
  "alors on regarde la carte du café pour la semaine prochaine et je pense que le four peut attendre mais il faut appeler le fournisseur avant jeudi sinon la livraison arrive trop tard pour le marché du samedi matin avec les nouvelles tasses et le chocolat chaud".split(
    " ",
  );
const sentence = (length: number) => {
  let text = "";
  while (text.length < length) text += `${WORDS[Math.floor(random() * WORDS.length)]} `;
  const trimmed = text.slice(0, Math.max(2, length)).trim();
  return `${trimmed.charAt(0).toLocaleUpperCase()}${trimmed.slice(1)}.`;
};

/** Labels in the order they first speak, each heard on a track: the microphone or the call app. */
const LABELS = [
  "app:com.hnc.Discord/1/1",
  "app:com.hnc.Discord/1/2",
  "input:BuiltInMicrophoneDevice/1/1",
  "app:com.hnc.Discord/2/1",
  "app:com.hnc.Discord/2/2",
  "app:com.hnc.Discord/2/3",
  "app:com.hnc.Discord/3/1",
  "app:com.hnc.Discord/3/2",
];
/** A random call of about the same make: 2 h, ~2 100 sentences, one voice speaking most. */
function randomShape(): Shape[] {
  const weights = [14, 46, 19, 3, 3, 15, 0, 0];
  const out: Shape[] = [];
  let at = 1_500;
  while (at < 2 * 3_600_000) {
    let pick = random() * 100;
    let index = 0;
    while (index < weights.length - 1 && pick >= (weights[index] ?? 0)) {
      pick -= weights[index] ?? 0;
      index += 1;
    }
    const length = 20 + Math.floor(random() * random() * 400);
    const ms = Math.max(1_200, length * 65);
    out.push({ s: at, e: at + ms, l: LABELS[index] ?? "", n: length });
    at += ms + Math.floor(random() * 900);
  }
  // A few seconds of one voice, and one second of another, as diarization leaves them.
  out.push({ s: 4_000_000, e: 4_005_200, l: LABELS[6] ?? "", n: 40 });
  out.push({ s: 5_000_000, e: 5_000_900, l: LABELS[7] ?? "", n: 12 });
  return out.toSorted((a, b) => a.s - b.s);
}

const shape: Shape[] =
  shapeFile === undefined
    ? randomShape()
    : (JSON.parse(readFileSync(shapeFile, "utf8")) as Shape[]).toSorted((a, b) => a.s - b.s);
// A shape's own labels, renamed in the order they first speak.
const order = [...new Set(shape.map((line) => line.l))];
const labelOf = (label: string) =>
  shapeFile === undefined ? label : (LABELS[order.indexOf(label)] ?? `app:other/${label}`);

const today = new Date();
today.setHours(17, 15, 0, 0);
const base = today.getTime() - 86_400_000;
const endMs = Math.max(...shape.map((line) => line.e)) + 2_000;

const { trackRunId } = upsertTrackRun(db, {
  uid: `ux-long-call-${shapeFile === undefined ? "random" : "shape"}`,
  trackKey: "input:BuiltInMicrophoneDevice",
  sourceKind: "input",
  device: {
    uid: "BuiltInMicrophoneDevice",
    name: "MacBook Pro Microphone",
    transport: "built_in",
    hasInput: true,
    seenAtMs: base,
  },
  startedWallMs: base,
  nowMs: base,
});
const opened = openSpeechRegion(db, {
  trackRunId,
  sampleStart: 0,
  wallStartMs: base,
  vadVersion: "silero-6.2",
});
if (opened.speechRegionId === null) throw new Error("speech region refused");
closeSpeechRegion(db, {
  trackRunId,
  sampleStart: 0,
  sampleEnd: Math.round((endMs * RATE) / 1000),
  wallEndMs: base + endMs,
  endReason: "silence",
});
db.statement(
  `INSERT INTO apps (bundle_id, name, first_seen_ms, last_seen_ms) VALUES ('com.hnc.Discord', 'Discord', ?, ?)
   ON CONFLICT (bundle_id) DO NOTHING`,
).run(base, base);
const appId = db.statement(`SELECT id FROM apps WHERE bundle_id = 'com.hnc.Discord'`).get()?.["id"];
db.statement(`UPDATE speech_regions SET attributed_app_id = ? WHERE id = ?`).run(
  appId,
  opened.speechRegionId,
);
const voicedMs = shape.reduce((sum, line) => sum + line.e - line.s, 0);
const episodeId = Number(
  db
    .statement(
      `INSERT INTO episodes (state, started_at_ms, ended_at_ms, grouping_version,
         classifier_version, created_at_ms, updated_at_ms, size, context, size_state, voiced_ms)
       VALUES ('closed', ?, ?, 'g1', 'c1', ?, ?, 'conversation', 'call', 'final', ?)`,
    )
    .run(base, base + endMs, base, base, voicedMs).lastInsertRowid,
);
db.statement(
  `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start)
   VALUES (?, ?, 'g1', 0)`,
).run(episodeId, opened.speechRegionId);
const runId = Number(
  db
    .statement(
      `INSERT INTO analysis_runs (episode_id, stage, status, engine_id, engine_version,
         engine_runtime, adapter_class, input_hash, input_generation, started_at_ms)
       VALUES (?, 'asr', 'succeeded', 'nemotron-3.5-transcribe-30b', 'iq4_nl', 'speech.cpp',
         'product', ?, 1, ?)`,
    )
    .run(episodeId, `ux-long-${episodeId}`, base).lastInsertRowid,
);
const segments = shape.map((line) => ({
  trackRunId,
  sampleStart: Math.round((line.s * RATE) / 1000),
  sampleEnd: Math.round((line.e * RATE) / 1000),
  startMs: base + line.s,
  endMs: base + line.e,
  text: sentence(line.n),
  speakerLabel: labelOf(line.l),
}));
const published = publishAnalysis(db, {
  episodeId,
  stage: "asr",
  runId,
  inputGeneration: 1,
  segments,
  turns: segments.map(({ text: _text, ...turn }) => turn),
  analysisState: "complete",
});
if (!published.published) throw new Error(`not published: ${JSON.stringify(published)}`);
// Linked already: the voice pass leaves the voices as they are.
db.statement("INSERT INTO voice_links (run_id, merged, finished_at_ms) VALUES (?, 0, ?)").run(
  runId,
  base,
);

const personId = (name: string) =>
  db.statement("SELECT id FROM people WHERE name = ?").get(name)?.["id"] as number | undefined;
/** A long call's usual shape: two voices for one person twice, one voice to confirm, two left unnamed. */
const names: Record<string, string> = {
  [LABELS[0] ?? ""]: "Camille",
  [LABELS[1] ?? ""]: "Jules",
  [LABELS[2] ?? ""]: "@self",
  [LABELS[3] ?? ""]: "Camille",
  [LABELS[5] ?? ""]: "Marc",
  [LABELS[6] ?? ""]: "Jules",
};
for (const [label, name] of Object.entries(names)) {
  const known = personId(name);
  const result = nameSpeaker(db, {
    episodeId,
    runId,
    label,
    person:
      name === "@self"
        ? { kind: "self", name: "Alex" }
        : known === undefined
          ? { kind: "new", name }
          : { kind: "existing", personId: known },
    nowMs: Date.now(),
  });
  if (!result.ok) throw new Error(`could not name ${label}: ${result.reason}`);
}

// Voice embeddings, invented: each person's direction plus noise. Every named
// voice of the seeded history becomes a reference, so the call's unnamed
// voice that sounds like Inès is suggested at 99 % (another channel than the
// references: the call app's), as a real call's voice was.
const direction = new Map<number, Float32Array>();
const unit = (vector: Float32Array) => {
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
};
const towards = (person: number, noise: number) => {
  let from = direction.get(person);
  if (from === undefined) {
    from = unit(Float32Array.from({ length: 256 }, () => random() - 0.5));
    direction.set(person, from);
  }
  return unit(Float32Array.from(from, (value) => value + (random() - 0.5) * noise));
};
const insertEmbedding = db.statement(
  `INSERT OR REPLACE INTO speaker_embeddings
     (run_id, episode_id, label, embedder_version, vector, speech_ms, created_at_ms)
   VALUES (?, ?, ?, ?, ?, 30000, ?)`,
);
const insertPass = db.statement(
  "INSERT OR REPLACE INTO voice_passes (run_id, embedder_version, finished_at_ms) VALUES (?, ?, ?)",
);
const named = db
  .statement(
    `SELECT DISTINCT s.run_id, s.episode_id, s.label, a.person_id
     FROM episode_speakers s
     JOIN episode_analysis ea ON ea.run_id = s.run_id AND ea.stage = 'asr'
     JOIN user_assertions a ON a.kind = 'speaker_is' AND a.revoked_at_ms IS NULL
     JOIN segments g ON g.run_id = s.run_id AND g.speaker_label = s.label
       AND g.track_run_id = a.track_run_id
       AND g.sample_start < a.sample_end AND g.sample_end > a.sample_start
     WHERE s.run_id <> ?`,
  )
  .all(runId);
for (const row of named) {
  const vector = towards(Number(row["person_id"]), 0.05);
  insertEmbedding.run(
    row["run_id"],
    row["episode_id"],
    row["label"],
    VERSION,
    Buffer.from(vector.buffer),
    base,
  );
  insertPass.run(row["run_id"], VERSION, base);
}
const ines = personId("Inès");
if (ines !== undefined) {
  insertEmbedding.run(
    runId,
    episodeId,
    LABELS[4],
    VERSION,
    Buffer.from(towards(ines, 0.05).buffer),
    base,
  );
}
insertPass.run(runId, VERSION, base);

db.close();
console.log(episodeId);
