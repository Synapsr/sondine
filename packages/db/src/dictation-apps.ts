import { upsertApp } from "./capture-import";
import type { Database } from "./database";
import { int, str, strOrNull } from "./rows";

// Which apps listening to the microphone are dictation apps (ADR 020): mic
// speech while one listens is the user talking to it, grouped apart from the
// talk around it. The known dictation apps count by default: they take the
// microphone only while dictating (Hex once its "release the microphone while
// idle" setting is on). Any other app counts once the user says so. The system's speech recognition (Siri,
// accessibility) is never a default: it listens for other reasons too. A rule
// applies to the episodes grouped after it: open ones, never closed ones.

/**
 * The dictation apps on Téo's Mac (2026-11-08), then the others he asked to
 * count (2026-11-25), by the bundle IDs of their Homebrew casks or source;
 * with the name shown before one has listened.
 */
export const KNOWN_DICTATION_APPS: readonly { readonly bundleId: string; readonly name: string }[] =
  [
    { bundleId: "anomaly.hex", name: "Hex" },
    { bundleId: "com.prakashjoshipax.VoiceInk", name: "VoiceInk" },
    { bundleId: "app.synapsr.parler", name: "Parler" },
    { bundleId: "com.pais.handy", name: "Handy" },
    { bundleId: "com.kitlangton.Hex", name: "Hex" },
    { bundleId: "com.superduper.superwhisper", name: "superwhisper" },
    { bundleId: "com.electron.wispr-flow", name: "Wispr Flow" },
    { bundleId: "com.electron.aqua-voice", name: "Aqua Voice" },
    { bundleId: "app.spokenly", name: "Spokenly" },
    { bundleId: "com.gizmolabs.openwhispr", name: "OpenWhispr" },
    { bundleId: "com.FluidApp.app", name: "FluidVoice" },
    { bundleId: "com.seewillow.WillowMac", name: "Willow Voice" },
  ];

export const DEFAULT_DICTATION_APPS: readonly string[] = KNOWN_DICTATION_APPS.map(
  (app) => app.bundleId,
);

/** The dictation apps whose text Sondine can take from their own history, in place of a transcription. */
export const DICTATION_TEXT_APPS: readonly string[] = [
  "anomaly.hex",
  "com.prakashjoshipax.VoiceInk",
  "app.synapsr.parler",
  "com.pais.handy",
];

const KEY = "dictation.apps";
const TEXT_KEY = "dictation.text";
const TEXT_PAST_KEY = "dictation.text.past";

/** The user's rules over the defaults, by bundle id: true counts the app, false leaves it out. */
const rules = (db: Database) => switches(db, KEY);

function switches(db: Database, key: string): ReadonlyMap<string, boolean> {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(key);
  if (row === undefined) return new Map();
  const value: unknown = JSON.parse(str(row, "value"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
  return new Map(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

export function dictationApps(db: Database): ReadonlySet<string> {
  const out = new Set(DEFAULT_DICTATION_APPS);
  for (const [bundleId, counts] of rules(db)) {
    if (counts) out.add(bundleId);
    else out.delete(bundleId);
  }
  return out;
}

/**
 * Counts an app as dictation or not. `name`, for an app the user added from
 * the open panel, is kept with the apps Sondine knows, so Settings names it
 * before it listens.
 */
export function setDictationApp(
  db: Database,
  bundleId: string,
  counts: boolean,
  nowMs: number,
  name?: string,
): ReadonlySet<string> {
  if (name !== undefined) upsertApp(db, { bundleId, name, seenAtMs: nowMs });
  const next = Object.fromEntries(rules(db));
  // A default app counted is no rule: the defaults may change with a release.
  // Any other app keeps its rule, on or off, so Settings keeps listing it.
  if (DEFAULT_DICTATION_APPS.includes(bundleId) && counts) delete next[bundleId];
  else next[bundleId] = counts;
  store(db, KEY, next, nowMs);
  return dictationApps(db);
}

function store(db: Database, key: string, value: Record<string, boolean>, nowMs: number): void {
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(key, JSON.stringify(value), nowMs);
}

/** Whether a dictation's text is taken from its app; null when Sondine cannot read that app's. */
export function dictationText(db: Database, bundleId: string): boolean | null {
  if (!DICTATION_TEXT_APPS.includes(bundleId)) return null;
  return switches(db, TEXT_KEY).get(bundleId) ?? true;
}

export function setDictationText(db: Database, bundleId: string, on: boolean, nowMs: number): void {
  store(db, TEXT_KEY, { ...Object.fromEntries(switches(db, TEXT_KEY)), [bundleId]: on }, nowMs);
}

/** Whether the app's past dictations were taken from its history: it happens once. */
export function dictationTextPastTaken(db: Database, bundleId: string): boolean {
  return switches(db, TEXT_PAST_KEY).get(bundleId) === true;
}

export function setDictationTextPastTaken(db: Database, bundleId: string, nowMs: number): void {
  store(
    db,
    TEXT_PAST_KEY,
    { ...Object.fromEntries(switches(db, TEXT_PAST_KEY)), [bundleId]: true },
    nowMs,
  );
}

/** The app's dictations whose transcript is not its own text, latest first. */
export function pastDictations(db: Database, bundleId: string, limit = 2_000): number[] {
  return db
    .statement(
      `SELECT e.id FROM episodes e
       JOIN apps a ON a.id = e.primary_app_id
       JOIN episode_analysis ea ON ea.episode_id = e.id AND ea.stage = 'asr'
       JOIN analysis_runs r ON r.id = ea.run_id
       WHERE e.context = 'dictation' AND e.state = 'closed' AND a.bundle_id = ?
         AND r.engine_id NOT LIKE 'dictation-text:%'
       ORDER BY e.started_at_ms DESC LIMIT ?`,
    )
    .all(bundleId, limit)
    .map((row) => int(row, "id"));
}

/** The stretches an app listened to the microphone that ended, as the helper saw, in a window of wall time. */
export function listenSpans(
  db: Database,
  bundleId: string,
  fromMs: number,
  toMs: number,
): { readonly startMs: number; readonly endMs: number }[] {
  return db
    .statement(
      `SELECT started_wall_ms, ended_wall_ms FROM listens
       WHERE bundle_id = ? AND ended_wall_ms BETWEEN ? AND ? AND end_reason = 'ended'
       ORDER BY started_wall_ms`,
    )
    .all(bundleId, fromMs, toMs)
    .map((row) => ({ startMs: int(row, "started_wall_ms"), endMs: int(row, "ended_wall_ms") }));
}

/** The app an episode was dictated to; null when it is no dictation. */
export function dictationAppOf(db: Database, episodeId: number): string | null {
  const row = db
    .statement(
      `SELECT a.bundle_id FROM episodes e JOIN apps a ON a.id = e.primary_app_id
       WHERE e.id = ? AND e.context = 'dictation'`,
    )
    .get(episodeId);
  return row === undefined ? null : str(row, "bundle_id");
}

/**
 * An app seen listening to the microphone outside a call, a known dictation
 * app installed, or an app the user ruled on.
 */
export interface ListeningApp {
  readonly bundleId: string;
  /** The app's name when the helper resolved one, else a known app's. */
  readonly name: string | null;
  readonly via: "app" | "speech";
  /** Null: a known dictation app installed here, or an app the user added, that has not listened yet. */
  readonly lastListenedAtMs: number | null;
  readonly dictation: boolean;
  /** Its dictations' text is taken from it; null when Sondine cannot read it. */
  readonly text: boolean | null;
}

/**
 * Every app seen listening, the latest first, then the known dictation apps
 * installed here (`installed`, by bundle id) and the apps the user added or
 * ruled on that have not listened yet, each with whether it counts as
 * dictation.
 */
export function listeningApps(db: Database, installed: ReadonlySet<string>): ListeningApp[] {
  const counted = dictationApps(db);
  const seen: ListeningApp[] = db
    .statement(
      `SELECT l.bundle_id, max(a.name) AS name, max(l.via) AS via,
         max(coalesce(l.ended_wall_ms, l.last_seen_wall_ms)) AS last_ms
       FROM listens l LEFT JOIN apps a ON a.id = l.app_id
       GROUP BY l.bundle_id
       ORDER BY last_ms DESC, l.bundle_id`,
    )
    .all()
    .map((row) => {
      const bundleId = str(row, "bundle_id");
      return {
        bundleId,
        name: strOrNull(row, "name"),
        via: str(row, "via") === "speech" ? "speech" : "app",
        lastListenedAtMs: int(row, "last_ms"),
        dictation: counted.has(bundleId),
        text: dictationText(db, bundleId),
      };
    });
  const listed = new Set(seen.map((app) => app.bundleId));
  const waiting: ListeningApp[] = [];
  const add = (bundleId: string, name: string | null) => {
    if (listed.has(bundleId)) return;
    listed.add(bundleId);
    waiting.push({
      bundleId,
      name,
      via: "app",
      lastListenedAtMs: null,
      dictation: counted.has(bundleId),
      text: dictationText(db, bundleId),
    });
  };
  for (const app of KNOWN_DICTATION_APPS)
    if (installed.has(app.bundleId)) add(app.bundleId, app.name);
  const named = db.statement("SELECT name FROM apps WHERE bundle_id = ?");
  for (const bundleId of [...rules(db).keys()].toSorted()) {
    add(bundleId, strOrNull(named.get(bundleId) ?? { name: null }, "name"));
  }
  return [...seen, ...waiting];
}
