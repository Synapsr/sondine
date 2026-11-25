import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dictationHistories, parseHex, parseParler } from "./histories";
import { removeLeftCopies } from "./read-history";

// Each app's own format, with invented words.

let home: string;
beforeEach(() => (home = mkdtempSync(join(tmpdir(), "sondine-histories-"))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

const pathOf = (...parts: string[]) => {
  const path = join(home, "Library", "Application Support", ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
};
const read = (bundleId: string) => dictationHistories(home).get(bundleId)?.();

const hexEntry = (patch: Record<string, unknown> = {}) => ({
  id: 1,
  timestamp_ms: 1_000_000,
  kind: "dictation",
  raw_text: "ajoute du lait",
  final_text: " Ajoute du lait. ",
  application: "Notes",
  audio_ms: 8_000,
  inference_ms: 700,
  total_ms: 900,
  model: "Cohere Transcribe",
  ...patch,
});
const hexFile = (entries: unknown[], version: unknown = 1) =>
  JSON.stringify({ version, next_id: 2, entries });

describe("Hex", () => {
  it("places a dictation where the user spoke, not where its text came", () => {
    expect(parseHex(hexFile([hexEntry()]))).toEqual([
      { kind: "spoken", startMs: 991_100, endMs: 999_100, text: "Ajoute du lait." },
    ]);
  });

  it("leaves out what it does not know, and refuses another version", () => {
    expect(
      parseHex(hexFile([hexEntry({ kind: "meeting" }), { id: 2 }, hexEntry({ audio_ms: -1 })])),
    ).toEqual([]);
    expect(parseHex(hexFile([hexEntry()], 2))).toBeNull();
    expect(parseHex("{")).toBeNull();
    expect(parseHex("[]")).toBeNull();
    expect(parseHex(null)).toBeNull();
  });

  it("is read again once it changed, and never waited on", () => {
    const path = pathOf("hex", "history.json");
    const history = dictationHistories(home).get("anomaly.hex");
    expect(history?.()).toBeNull();
    writeFileSync(path, hexFile([hexEntry()]));
    const first = history?.();
    expect(first).toHaveLength(1);
    expect(history?.()).toBe(first);
    writeFileSync(path, hexFile([hexEntry(), hexEntry({ id: 2 })]));
    expect(history?.()).toHaveLength(2);
    rmSync(path);
    execFileSync("mkfifo", [path]);
    expect(history?.()).toBeNull();
  });
});

describe("Parler", () => {
  it("says when the text came, and how long the user spoke", () => {
    const entry = { id: 5_000, text: " Bonjour. ", durationMs: 2_000, provider: "local" };
    expect(parseParler(JSON.stringify([entry, { id: -1 }]))).toEqual([
      { kind: "came", fromMs: 5_000, toMs: 5_000, spokeMs: 2_000, text: "Bonjour." },
    ]);
    expect(parseParler("{}")).toBeNull();
  });
});

describe("VoiceInk", () => {
  const bundleId = "com.prakashjoshipax.VoiceInk";
  const store = () => pathOf(bundleId, "default.store");
  const create = (path: string) => {
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE ZTRANSCRIPTION (Z_PK INTEGER PRIMARY KEY, ZDURATION FLOAT, ZTIMESTAMP TIMESTAMP,
        ZTEXT VARCHAR, ZENHANCEDTEXT VARCHAR, ZENHANCEMENTDURATION FLOAT,
        ZTRANSCRIPTIONSTATUS VARCHAR)`);
    return database;
  };

  it("takes what was typed, enhanced or not, and only what completed", () => {
    const database = create(store());
    const add = database.prepare(
      `INSERT INTO ZTRANSCRIPTION (ZDURATION, ZTIMESTAMP, ZTEXT, ZENHANCEDTEXT,
         ZENHANCEMENTDURATION, ZTRANSCRIPTIONSTATUS) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    add.run(3, 100, "ajoute du lait", "Ajoute du lait.", 0.4, "completed");
    // The enhancement failed: its error is where its text would be.
    add.run(2, 200, "puis du pain", "Enhancement failed", null, "completed");
    add.run(2, 300, "annulé", null, null, "canceled");
    add.run(null, 400, "sans durée", null, null, "completed");
    // Still open, its rows in the log: as VoiceInk leaves it while it runs.
    const at = Date.UTC(2001, 0, 1);
    expect(read(bundleId)).toEqual([
      { kind: "spoken", startMs: at + 198_000, endMs: at + 200_000, text: "puis du pain" },
      { kind: "spoken", startMs: at + 97_000, endMs: at + 100_000, text: "Ajoute du lait." },
    ]);
    database.close();
  });

  it("touches nothing of the app's, and leaves nothing behind", () => {
    const path = store();
    create(path).close();
    const before = [readdirSync(dirname(path)), statSync(path).mtimeMs];
    const left = () =>
      readdirSync(tmpdir()).filter((name) => name.startsWith("sondine-dictation-"));
    const others = left().length;
    expect(read(bundleId)).toEqual([]);
    expect([readdirSync(dirname(path)), statSync(path).mtimeMs]).toEqual(before);
    expect(left()).toHaveLength(others);
  });

  it("is as if there were none when it is not what it should be", () => {
    const path = store();
    expect(read(bundleId)).toBeNull();
    writeFileSync(path, "not a database");
    expect(read(bundleId)).toBeNull();
    rmSync(path);
    const view = new DatabaseSync(path);
    view.exec(`CREATE VIEW ZTRANSCRIPTION AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n)
      SELECT i AS ZDURATION, i AS ZTIMESTAMP, 'x' AS ZTEXT, '' AS ZENHANCEDTEXT, 'completed' AS ZTRANSCRIPTIONSTATUS FROM n`);
    view.close();
    expect(read(bundleId)).toBeNull();
    rmSync(path);
    const generated = new DatabaseSync(path);
    generated.exec(`CREATE TABLE ZTRANSCRIPTION (ZDURATION FLOAT, ZTIMESTAMP TIMESTAMP,
      ZTEXT VARCHAR AS (hex(zeroblob(8000000))), ZENHANCEDTEXT VARCHAR, ZENHANCEMENTDURATION FLOAT,
      ZTRANSCRIPTIONSTATUS VARCHAR);
      INSERT INTO ZTRANSCRIPTION (ZDURATION, ZTIMESTAMP, ZTRANSCRIPTIONSTATUS) VALUES (1, 1, 'completed')`);
    generated.close();
    expect(read(bundleId)).toBeNull();
    rmSync(path);
    const virtual = new DatabaseSync(path);
    virtual.exec("CREATE VIRTUAL TABLE ZTRANSCRIPTION USING fts5(ZTEXT)");
    virtual.close();
    expect(read(bundleId)).toBeNull();
    rmSync(path);
    execFileSync("mkfifo", [path]);
    expect(read(bundleId)).toBeNull();
    rmSync(path);
    execFileSync("ln", ["-s", path, path]);
    expect(read(bundleId)).toBeNull();
  });

  it("removes the copies a crash left, not one being read", () => {
    const left = mkdtempSync(join(tmpdir(), "sondine-dictation-"));
    removeLeftCopies(Date.now());
    expect(existsSync(left)).toBe(true);
    removeLeftCopies(Date.now() + 120_000);
    expect(existsSync(left)).toBe(false);
  });
});

describe("Handy", () => {
  it("takes dictations, not the files the user had transcribed", () => {
    const database = new DatabaseSync(pathOf("com.pais.handy", "history.db"));
    database.exec(`CREATE TABLE transcription_history (id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL, timestamp INTEGER NOT NULL, saved BOOLEAN NOT NULL DEFAULT 0,
      title TEXT NOT NULL, transcription_text TEXT NOT NULL, post_processed_text TEXT, source_name TEXT)`);
    const add = database.prepare(
      `INSERT INTO transcription_history (file_name, timestamp, title, transcription_text,
         post_processed_text, source_name) VALUES ('a.wav', ?, 't', ?, ?, ?)`,
    );
    add.run(1_000, "ajoute du lait", "Ajoute du lait.", null);
    add.run(2_000, "puis du pain", null, null);
    add.run(3_000, "une réunion", null, "réunion.m4a");
    database.close();
    expect(read("com.pais.handy")).toEqual([
      { kind: "came", fromMs: 2_000_000, toMs: 2_000_999, spokeMs: null, text: "puis du pain" },
      { kind: "came", fromMs: 1_000_000, toMs: 1_000_999, spokeMs: null, text: "Ajoute du lait." },
    ]);
  });
});
