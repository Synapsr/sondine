import {
  DEFAULT_AUDIO_DAYS,
  NIGHT,
  RECORDING_TYPES,
  ZONE_OUTCOMES,
  validWindow,
  type RecordingType,
  type ScheduleWindow,
  type Weekday,
  type Zone,
  type ZoneOutcome,
  type ZoneSituation,
} from "@sondine/core";
import { randomUUID } from "node:crypto";
import { transaction, type Database } from "./database";
import { msToSamples } from "./deleted-ranges";
import { speechPostRollMs, speechPreRollMs } from "./delete-episode";
import { int, intOrNull, str, strOrNull } from "./rows";
import { DEFAULT_UNKEPT_SITES, setSiteKept, unkeptSites } from "./web-plays";

// Private zones in the database (ADR 029): the zones as the user set them
// (settings), when each was on (`privacy_zone_spans`), what the helper saw
// (`situation_spans`), the durations by type, and « Garder l'audio »
// (`kept_audio`). Nothing here pauses or resumes listening.

const ZONES_KEY = "privacy.zones";
const DURATIONS_KEY = "privacy.durations";
const SINCE_KEY = "privacy.since";
const NETWORK_KEY = "privacy.network-key";
const MIGRATED_KEY = "privacy.migrated";

/** Built-in zones, in the order Settings lists them. */
export const BUILTIN_ZONE_IDS = ["media-sites", "calls", "screen", "night"] as const;
export type BuiltinZoneId = (typeof BUILTIN_ZONE_IDS)[number];

interface BuiltinState {
  readonly on: boolean;
  readonly outcome: ZoneOutcome;
  readonly windows?: readonly ScheduleWindow[];
}

const BUILTIN_DEFAULTS: Readonly<Record<BuiltinZoneId, BuiltinState>> = {
  "media-sites": { on: true, outcome: "nothing" },
  calls: { on: false, outcome: "nothing" },
  screen: { on: false, outcome: "nothing" },
  night: { on: false, outcome: "nothing", windows: [NIGHT] },
};

/** A zone the user added: an app, a site, a network or hours. */
interface StoredZone {
  readonly id: string;
  readonly on: boolean;
  readonly outcome: ZoneOutcome;
  readonly situation: ZoneSituation;
  readonly createdAtMs: number;
}

interface StoredZones {
  readonly builtins: Partial<Record<BuiltinZoneId, BuiltinState>>;
  readonly zones: readonly StoredZone[];
}

const isOutcome = (value: unknown): value is ZoneOutcome =>
  typeof value === "string" && (ZONE_OUTCOMES as readonly string[]).includes(value);

function readSetting(db: Database, key: string): unknown {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(key);
  if (row === undefined) return undefined;
  try {
    return JSON.parse(str(row, "value"));
  } catch {
    return undefined;
  }
}

function writeSetting(db: Database, key: string, value: unknown, nowMs: number): void {
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(key, JSON.stringify(value), nowMs);
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function parseWindows(value: unknown): ScheduleWindow[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  const out: ScheduleWindow[] = [];
  for (const item of value) {
    const window = record(item);
    if (window === null || !Array.isArray(window["days"])) return null;
    const candidate: ScheduleWindow = {
      days: window["days"].filter((day): day is Weekday => typeof day === "number") as Weekday[],
      startMinute: typeof window["startMinute"] === "number" ? window["startMinute"] : -1,
      endMinute: typeof window["endMinute"] === "number" ? window["endMinute"] : -1,
    };
    if (!validWindow(candidate) || candidate.days.length !== window["days"].length) return null;
    out.push(candidate);
  }
  return out;
}

/** A user zone's situation as stored; null for anything malformed. */
function parseSituation(value: unknown): ZoneSituation | null {
  const situation = record(value);
  if (situation === null) return null;
  const text = (key: string, max = 512) => {
    const field = situation[key];
    return typeof field === "string" && field.length > 0 && field.length <= max ? field : null;
  };
  switch (situation["kind"]) {
    case "app": {
      const bundleId = text("bundleId", 255);
      const name = text("name", 255);
      return bundleId === null ? null : { kind: "app", bundleId, name: name ?? bundleId };
    }
    case "site": {
      const site = text("site", 253);
      return site === null ? null : { kind: "site", site };
    }
    case "network": {
      const name = text("name", 80);
      const raw = situation["hashes"];
      const hashes = Array.isArray(raw)
        ? [
            ...new Set(
              raw.filter(
                (hash): hash is string => typeof hash === "string" && /^[0-9a-f]{32}$/.test(hash),
              ),
            ),
          ]
        : [];
      return hashes.length === 0 || hashes.length > 8 || name === null
        ? null
        : { kind: "network", hashes: hashes.toSorted(), name };
    }
    case "hours": {
      const name = text("name", 80);
      const windows = parseWindows(situation["windows"]);
      return name === null || windows === null ? null : { kind: "hours", name, windows };
    }
    default:
      return null;
  }
}

function storedZones(db: Database): StoredZones {
  const value = record(readSetting(db, ZONES_KEY));
  const builtins: Partial<Record<BuiltinZoneId, BuiltinState>> = {};
  const rawBuiltins = record(value?.["builtins"]);
  for (const id of BUILTIN_ZONE_IDS) {
    const state = record(rawBuiltins?.[id]);
    if (state === null || typeof state["on"] !== "boolean" || !isOutcome(state["outcome"])) {
      continue;
    }
    const windows = id === "night" ? parseWindows(state["windows"]) : null;
    builtins[id] = {
      on: state["on"],
      outcome: state["outcome"],
      ...(windows === null ? {} : { windows }),
    };
  }
  const zones: StoredZone[] = [];
  for (const item of Array.isArray(value?.["zones"]) ? value["zones"] : []) {
    const zone = record(item);
    if (zone === null) continue;
    const situation = parseSituation(zone["situation"]);
    if (
      situation === null ||
      typeof zone["id"] !== "string" ||
      typeof zone["on"] !== "boolean" ||
      !isOutcome(zone["outcome"])
    ) {
      continue;
    }
    zones.push({
      id: zone["id"],
      on: zone["on"],
      outcome: zone["outcome"],
      situation,
      createdAtMs: typeof zone["createdAtMs"] === "number" ? zone["createdAtMs"] : 0,
    });
  }
  return { builtins, zones };
}

/** The films, series and music sites still left out (ADR 023's defaults the user did not keep). */
export function mediaSitesLeftOut(db: Database): string[] {
  const unkept = unkeptSites(db);
  return DEFAULT_UNKEPT_SITES.filter((site) => unkept.has(site));
}

function builtinZone(db: Database, id: BuiltinZoneId, state: BuiltinState): Zone {
  const situation: ZoneSituation =
    id === "media-sites"
      ? { kind: "media_sites", sites: mediaSitesLeftOut(db) }
      : id === "calls"
        ? { kind: "calls" }
        : id === "screen"
          ? { kind: "screen" }
          : { kind: "hours", name: "night", windows: state.windows ?? [NIGHT] };
  return { id, on: state.on, outcome: state.outcome, situation };
}

/** Every zone: the built-in ones first, then the user's in the order they were added. */
export function listZones(db: Database): Zone[] {
  const stored = storedZones(db);
  return [
    ...BUILTIN_ZONE_IDS.map((id) =>
      builtinZone(db, id, stored.builtins[id] ?? BUILTIN_DEFAULTS[id]),
    ),
    ...stored.zones
      .toSorted((a, b) => a.createdAtMs - b.createdAtMs)
      .map(({ id, on, outcome, situation }) => ({ id, on, outcome, situation })),
  ];
}

const isBuiltin = (id: string): id is BuiltinZoneId =>
  (BUILTIN_ZONE_IDS as readonly string[]).includes(id);

/** A zone that is not there (an unknown id, or a built-in one asked to be removed). */
export class ZoneNotFound extends Error {
  override readonly name = "ZoneNotFound";
}

/** A situation the user cannot add (malformed, or the same as a zone already there). */
export class ZoneRefused extends Error {
  override readonly name = "ZoneRefused";
}

const sameSituation = (a: ZoneSituation, b: ZoneSituation): boolean => {
  switch (a.kind) {
    case "app":
      return b.kind === "app" && a.bundleId === b.bundleId;
    case "site":
      return b.kind === "site" && a.site === b.site;
    case "network":
      return b.kind === "network" && a.hashes.some((hash) => b.hashes.includes(hash));
    default:
      return false;
  }
};

function saveZones(db: Database, zones: StoredZones, nowMs: number): void {
  writeSetting(db, ZONES_KEY, zones, nowMs);
  syncZoneSpans(db, nowMs);
}

/** Adds a zone for an app, a site, a network or hours: on, keeping nothing. */
export function addZone(db: Database, situation: ZoneSituation, nowMs: number): Zone {
  const parsed = parseSituation(situation);
  if (parsed === null) throw new ZoneRefused("This zone is not valid.");
  return transaction(db, () => {
    const stored = storedZones(db);
    if (stored.zones.some((zone) => sameSituation(zone.situation, parsed))) {
      throw new ZoneRefused("There is already a zone for this.");
    }
    const zone: StoredZone = {
      id: randomUUID(),
      on: true,
      outcome: "nothing",
      situation: parsed,
      createdAtMs: nowMs,
    };
    saveZones(db, { ...stored, zones: [...stored.zones, zone] }, nowMs);
    return { id: zone.id, on: zone.on, outcome: zone.outcome, situation: zone.situation };
  });
}

export interface ZoneChange {
  readonly on?: boolean;
  readonly outcome?: ZoneOutcome;
  /** Hours: a new name and windows; network: a new name. */
  readonly name?: string;
  readonly windows?: readonly ScheduleWindow[];
}

/** Switches a zone on or off, or changes what it keeps, its name or its hours. */
export function updateZone(db: Database, id: string, change: ZoneChange, nowMs: number): Zone {
  return transaction(db, () => {
    const stored = storedZones(db);
    if (change.outcome !== undefined && !isOutcome(change.outcome)) {
      throw new ZoneRefused("Unknown outcome.");
    }
    const windows = change.windows === undefined ? undefined : parseWindows(change.windows);
    if (windows === null) throw new ZoneRefused("These hours are not valid.");
    if (isBuiltin(id)) {
      const current = stored.builtins[id] ?? BUILTIN_DEFAULTS[id];
      const next: BuiltinState = {
        on: change.on ?? current.on,
        outcome: change.outcome ?? current.outcome,
        ...(id === "night" ? { windows: windows ?? current.windows ?? [NIGHT] } : {}),
      };
      saveZones(db, { ...stored, builtins: { ...stored.builtins, [id]: next } }, nowMs);
      return builtinZone(db, id, next);
    }
    const zone = stored.zones.find((candidate) => candidate.id === id);
    if (zone === undefined) throw new ZoneNotFound(`No zone ${id}.`);
    const name = change.name?.trim();
    const situation: ZoneSituation =
      zone.situation.kind === "hours"
        ? {
            kind: "hours",
            name: name !== undefined && name !== "" ? name.slice(0, 80) : zone.situation.name,
            windows: windows ?? zone.situation.windows,
          }
        : zone.situation.kind === "network" && name !== undefined && name !== ""
          ? { ...zone.situation, name: name.slice(0, 80) }
          : zone.situation;
    const next: StoredZone = {
      ...zone,
      on: change.on ?? zone.on,
      outcome: change.outcome ?? zone.outcome,
      situation,
    };
    saveZones(
      db,
      {
        ...stored,
        zones: stored.zones.map((candidate) => (candidate.id === id ? next : candidate)),
      },
      nowMs,
    );
    return { id: next.id, on: next.on, outcome: next.outcome, situation: next.situation };
  });
}

/** Removes a zone the user added; built-in zones are only switched off. */
export function removeZone(db: Database, id: string, nowMs: number): void {
  transaction(db, () => {
    const stored = storedZones(db);
    if (isBuiltin(id) || !stored.zones.some((zone) => zone.id === id)) {
      throw new ZoneNotFound(`No zone ${id} to remove.`);
    }
    saveZones(db, { ...stored, zones: stored.zones.filter((zone) => zone.id !== id) }, nowMs);
  });
}

/** Keeps one of the films, series and music sites, or leaves it out again. */
export function setMediaSiteKept(db: Database, site: string, kept: boolean, nowMs: number): void {
  if (!DEFAULT_UNKEPT_SITES.includes(site))
    throw new ZoneNotFound(`${site} is not a built-in site.`);
  transaction(db, () => {
    setSiteKept(db, site, kept, nowMs);
    syncZoneSpans(db, nowMs);
  });
}

// Zone spans

/** The situation as stored in a span: its keys in one order, so equal situations compare equal. */
function canonical(situation: ZoneSituation): string {
  switch (situation.kind) {
    case "app":
      return JSON.stringify({ kind: "app", bundleId: situation.bundleId, name: situation.name });
    case "site":
      return JSON.stringify({ kind: "site", site: situation.site });
    case "media_sites":
      return JSON.stringify({ kind: "media_sites", sites: situation.sites.toSorted() });
    case "network":
      return JSON.stringify({
        kind: "network",
        hashes: situation.hashes.toSorted(),
        name: situation.name,
      });
    case "hours":
      return JSON.stringify({
        kind: "hours",
        name: situation.name,
        windows: situation.windows.map((window) => ({
          days: window.days.toSorted(),
          startMinute: window.startMinute,
          endMinute: window.endMinute,
        })),
      });
    case "calls":
      return JSON.stringify({ kind: "calls" });
    case "screen":
      return JSON.stringify({ kind: "screen" });
  }
}

/**
 * Makes `privacy_zone_spans` say what is on now: a span closes when its zone
 * is switched off, removed or changed, and each zone on has one open span
 * with its outcome and situation. Idempotent; run after every zone change
 * and at startup.
 */
export function syncZoneSpans(db: Database, nowMs: number): void {
  transaction(db, () => {
    const wanted = new Map(
      listZones(db)
        .filter((zone) => zone.on)
        .map((zone) => [zone.id, { outcome: zone.outcome, situation: canonical(zone.situation) }]),
    );
    const open = db
      .statement(
        "SELECT id, zone_id, outcome, situation FROM privacy_zone_spans WHERE ended_wall_ms IS NULL",
      )
      .all();
    const close = db.statement(
      "UPDATE privacy_zone_spans SET ended_wall_ms = max(started_wall_ms, ?) WHERE id = ?",
    );
    const kept = new Set<string>();
    for (const row of open) {
      const zoneId = str(row, "zone_id");
      const want = wanted.get(zoneId);
      if (
        want === undefined ||
        kept.has(zoneId) ||
        want.outcome !== str(row, "outcome") ||
        want.situation !== str(row, "situation")
      ) {
        close.run(nowMs, int(row, "id"));
      } else {
        kept.add(zoneId);
      }
    }
    const insert = db.statement(
      `INSERT INTO privacy_zone_spans (zone_id, outcome, situation, started_wall_ms)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [zoneId, want] of wanted) {
      if (!kept.has(zoneId)) insert.run(zoneId, want.outcome, want.situation, nowMs);
    }
  });
}

/** A zone on over part of a stretch, with its outcome and situation as they were. */
export interface StoredZoneSpan {
  readonly zoneId: string;
  readonly outcome: ZoneOutcome;
  readonly situation: ZoneSituation | { readonly kind: "media_sites"; readonly sites: string[] };
  readonly startedWallMs: number;
  readonly endedWallMs: number | null;
}

/** The zone spans that overlap `[fromMs, toMs]`. */
export function zoneSpansBetween(db: Database, fromMs: number, toMs: number): StoredZoneSpan[] {
  return db
    .statement(
      `SELECT zone_id, outcome, situation, started_wall_ms, ended_wall_ms FROM privacy_zone_spans
       WHERE started_wall_ms <= ? AND coalesce(ended_wall_ms, ?) >= ?
       ORDER BY started_wall_ms, id`,
    )
    .all(toMs, toMs, fromMs)
    .flatMap((row) => {
      const outcome = str(row, "outcome");
      const situation = spanSituation(str(row, "situation"));
      if (!isOutcome(outcome) || situation === null) return [];
      return [
        {
          zoneId: str(row, "zone_id"),
          outcome,
          situation,
          startedWallMs: int(row, "started_wall_ms"),
          endedWallMs: intOrNull(row, "ended_wall_ms"),
        },
      ];
    });
}

function spanSituation(text: string): ZoneSituation | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const situation = record(value);
  if (situation === null) return null;
  switch (situation["kind"]) {
    case "media_sites":
      return Array.isArray(situation["sites"])
        ? {
            kind: "media_sites",
            sites: situation["sites"].filter((site): site is string => typeof site === "string"),
          }
        : null;
    case "calls":
      return { kind: "calls" };
    case "screen":
      return { kind: "screen" };
    case "hours": {
      const windows = parseWindows(situation["windows"]);
      const name = typeof situation["name"] === "string" ? situation["name"] : "";
      return windows === null ? null : { kind: "hours", name, windows };
    }
    default:
      return parseSituation(situation);
  }
}

// Situations the helper reports

export interface Situation {
  readonly screenAway: boolean;
  /** Keyed hashes of the networks the Mac is on. */
  readonly networks: readonly string[];
}

/** Records what the helper says now: spans open and close to match it. */
export function recordSituation(db: Database, situation: Situation, atMs: number): void {
  transaction(db, () => {
    const open = db
      .statement("SELECT id, kind, network_hash FROM situation_spans WHERE ended_wall_ms IS NULL")
      .all();
    const close = db.statement(
      "UPDATE situation_spans SET ended_wall_ms = max(started_wall_ms, ?) WHERE id = ?",
    );
    let screenOpen = false;
    const networksOpen = new Set<string>();
    const wanted = new Set(situation.networks);
    for (const row of open) {
      const kind = str(row, "kind");
      const hash = strOrNull(row, "network_hash");
      if (kind === "screen_away") {
        if (situation.screenAway && !screenOpen) screenOpen = true;
        else close.run(atMs, int(row, "id"));
      } else if (hash !== null && wanted.has(hash) && !networksOpen.has(hash)) {
        networksOpen.add(hash);
      } else {
        close.run(atMs, int(row, "id"));
      }
    }
    const insert = db.statement(
      "INSERT INTO situation_spans (kind, network_hash, started_wall_ms) VALUES (?, ?, ?)",
    );
    if (situation.screenAway && !screenOpen) insert.run("screen_away", null, atMs);
    for (const hash of wanted) if (!networksOpen.has(hash)) insert.run("network", hash, atMs);
  });
}

export interface StoredSituationSpan {
  readonly kind: "screen_away" | "network";
  readonly networkHash: string | null;
  readonly startedWallMs: number;
  readonly endedWallMs: number | null;
}

export function situationSpansBetween(
  db: Database,
  fromMs: number,
  toMs: number,
): StoredSituationSpan[] {
  return db
    .statement(
      `SELECT kind, network_hash, started_wall_ms, ended_wall_ms FROM situation_spans
       WHERE started_wall_ms <= ? AND coalesce(ended_wall_ms, ?) >= ?
       ORDER BY started_wall_ms, id`,
    )
    .all(toMs, toMs, fromMs)
    .map((row) => ({
      kind: str(row, "kind") === "network" ? "network" : "screen_away",
      networkHash: strOrNull(row, "network_hash"),
      startedWallMs: int(row, "started_wall_ms"),
      endedWallMs: intOrNull(row, "ended_wall_ms"),
    }));
}

/** The networks the Mac is on now, as the last situation said. */
export function currentNetworks(db: Database): string[] {
  return db
    .statement(
      `SELECT network_hash FROM situation_spans
       WHERE kind = 'network' AND ended_wall_ms IS NULL ORDER BY started_wall_ms, id`,
    )
    .all()
    .map((row) => str(row, "network_hash"));
}

// Durations

export interface Durations {
  /** Audio days by type. */
  readonly audioDays: Readonly<Record<RecordingType, number>>;
  /** « Effacé après » by type, in days; null: never. */
  readonly deleteDays: Readonly<Record<RecordingType, number | null>>;
}

const positiveDays = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 3650 ? value : null;

export function durations(db: Database): Durations {
  const stored = record(readSetting(db, DURATIONS_KEY));
  const audio = record(stored?.["audioDays"]);
  const remove = record(stored?.["deleteDays"]);
  const audioDays = { ...DEFAULT_AUDIO_DAYS };
  const deleteDays: Record<RecordingType, number | null> = {
    calls: null,
    conversations: null,
    moments: null,
    traces: null,
    media: null,
    dictations: null,
  };
  for (const type of RECORDING_TYPES) {
    const days = positiveDays(audio?.[type]);
    if (days !== null) audioDays[type] = days;
    deleteDays[type] = positiveDays(remove?.[type]);
  }
  return { audioDays, deleteDays };
}

/** Sets a type's audio days, or its « Effacé après » (null: never). */
export function setDuration(
  db: Database,
  type: RecordingType,
  change: { readonly audioDays?: number; readonly deleteDays?: number | null },
  nowMs: number,
): Durations {
  return transaction(db, () => {
    const current = durations(db);
    if (change.audioDays !== undefined && positiveDays(change.audioDays) === null) {
      throw new ZoneRefused("Not a duration.");
    }
    if (
      change.deleteDays !== undefined &&
      change.deleteDays !== null &&
      positiveDays(change.deleteDays) === null
    ) {
      throw new ZoneRefused("Not a duration.");
    }
    const audioDays = {
      ...current.audioDays,
      ...(change.audioDays === undefined ? {} : { [type]: change.audioDays }),
    };
    const deleteDays = {
      ...current.deleteDays,
      ...(change.deleteDays === undefined ? {} : { [type]: change.deleteDays }),
    };
    // Defaults are not stored, so a later release can change them.
    const storedAudio = Object.fromEntries(
      RECORDING_TYPES.filter((key) => audioDays[key] !== DEFAULT_AUDIO_DAYS[key]).map((key) => [
        key,
        audioDays[key],
      ]),
    );
    const storedDelete = Object.fromEntries(
      RECORDING_TYPES.filter((key) => deleteDays[key] !== null).map((key) => [
        key,
        deleteDays[key],
      ]),
    );
    writeSetting(db, DURATIONS_KEY, { audioDays: storedAudio, deleteDays: storedDelete }, nowMs);
    return { audioDays, deleteDays };
  });
}

/**
 * When durations started counting: audio recorded before the update keeps its
 * full time from then (ADR 029, « Migration »). Set once.
 */
export function durationsSince(db: Database, nowMs: number): number {
  const stored = readSetting(db, SINCE_KEY);
  if (typeof stored === "number" && Number.isSafeInteger(stored)) return stored;
  writeSetting(db, SINCE_KEY, nowMs, nowMs);
  return nowMs;
}

/** The per-install key the helper hashes network signatures with (base64 of 32 bytes). */
export function networkKey(db: Database, makeKey: () => string, nowMs: number): string {
  const stored = readSetting(db, NETWORK_KEY);
  if (typeof stored === "string" && stored.length > 0) return stored;
  const key = makeKey();
  writeSetting(db, NETWORK_KEY, key, nowMs);
  return key;
}

// Migration

/**
 * Moves ADR 023's site rules into zones, once (ADR 029, « Migration »): a site
 * the user left out becomes a site zone keeping nothing; the built-in sites
 * the user kept stay switches of « Sites de films, séries et musique »; a
 * rule to keep a site that is kept anyway goes. Behaviour is unchanged.
 * Writes settings only, never the listening intent.
 */
export function migrateSiteRules(db: Database, nowMs: number): void {
  transaction(db, () => {
    if (readSetting(db, MIGRATED_KEY) === true) return;
    const rules = record(readSetting(db, "browser.sites")) ?? {};
    const stored = storedZones(db);
    const zones = [...stored.zones];
    const remaining: Record<string, boolean> = {};
    for (const [site, keep] of Object.entries(rules)) {
      if (typeof keep !== "boolean") continue;
      if (DEFAULT_UNKEPT_SITES.includes(site)) {
        if (keep) remaining[site] = true;
        continue;
      }
      if (keep) continue;
      const situation: ZoneSituation = { kind: "site", site };
      if (zones.some((zone) => sameSituation(zone.situation, situation))) continue;
      zones.push({ id: randomUUID(), on: true, outcome: "nothing", situation, createdAtMs: nowMs });
    }
    if (Object.keys(rules).length > 0) writeSetting(db, "browser.sites", remaining, nowMs);
    if (zones.length !== stored.zones.length) {
      writeSetting(db, ZONES_KEY, { ...stored, zones }, nowMs);
    }
    writeSetting(db, MIGRATED_KEY, true, nowMs);
    syncZoneSpans(db, nowMs);
  });
}

// « Garder l'audio »

/** An episode's audio as ranges of its runs: each slice with its region's roll. */
export function episodeAudioRanges(
  db: Database,
  episodeId: number,
): { readonly trackRunId: number; readonly from: number; readonly to: number }[] {
  return db
    .statement(
      `SELECT r.track_run_id, r.sample_start, r.sample_end, r.wall_start_ms, r.wall_end_ms,
         t.sample_rate, e.slice_sample_start, e.slice_sample_end
       FROM episode_regions e
       JOIN speech_regions r ON r.id = e.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       WHERE e.episode_id = ?`,
    )
    .all(episodeId)
    .map((row) => {
      const rate = int(row, "sample_rate");
      const sampleStart = int(row, "sample_start");
      const wallStart = int(row, "wall_start_ms");
      const wallEnd = intOrNull(row, "wall_end_ms") ?? wallStart;
      const sampleEnd =
        intOrNull(row, "sample_end") ?? sampleStart + msToSamples(wallEnd - wallStart, rate);
      const sliceStart = int(row, "slice_sample_start");
      const sliceEnd = Math.max(intOrNull(row, "slice_sample_end") ?? sampleEnd, sliceStart + 1);
      const pre = sliceStart <= sampleStart ? msToSamples(speechPreRollMs, rate) : 0;
      const post = sliceEnd >= sampleEnd ? msToSamples(speechPostRollMs, rate) : 0;
      return {
        trackRunId: int(row, "track_run_id"),
        from: Math.max(0, sliceStart - pre),
        to: sliceEnd + post,
      };
    });
}

/** « Garder l'audio »: the episode's audio stays past every duration, zone and the disk cap. */
export function keepEpisodeAudio(db: Database, episodeId: number, nowMs: number): boolean {
  return transaction(db, () => {
    const ranges = episodeAudioRanges(db, episodeId);
    if (ranges.length === 0) return false;
    const insert = db.statement(
      `INSERT INTO kept_audio (track_run_id, sample_start, sample_end, created_at_ms)
       VALUES (?, ?, ?, ?)`,
    );
    for (const range of ranges) insert.run(range.trackRunId, range.from, range.to, nowMs);
    db.statement("UPDATE episodes SET updated_at_ms = ? WHERE id = ?").run(nowMs, episodeId);
    return true;
  });
}

/**
 * An episode's speech as ranges of its runs: each slice, without roll. A
 * region still open reaches to the end of its run: what it will hold is
 * speech of this episode, already kept or released with it.
 */
export function episodeSpeechRanges(
  db: Database,
  episodeId: number,
): { readonly trackRunId: number; readonly from: number; readonly to: number }[] {
  return db
    .statement(
      `SELECT r.track_run_id, r.sample_start, r.sample_end, r.wall_start_ms, r.wall_end_ms,
         r.state, t.sample_rate, e.slice_sample_start, e.slice_sample_end
       FROM episode_regions e
       JOIN speech_regions r ON r.id = e.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       WHERE e.episode_id = ?`,
    )
    .all(episodeId)
    .map((row) => {
      const rate = int(row, "sample_rate");
      const sampleStart = int(row, "sample_start");
      const wallStart = int(row, "wall_start_ms");
      const wallEnd = intOrNull(row, "wall_end_ms") ?? wallStart;
      const sampleEnd =
        intOrNull(row, "sample_end") ?? sampleStart + msToSamples(wallEnd - wallStart, rate);
      const from = int(row, "slice_sample_start");
      const sliceEnd = intOrNull(row, "slice_sample_end");
      const open = str(row, "state") === "open" && sliceEnd === null;
      return {
        trackRunId: int(row, "track_run_id"),
        from,
        to: open ? Number.MAX_SAFE_INTEGER : Math.max(sliceEnd ?? sampleEnd, from + 1),
      };
    });
}

/**
 * « Ne plus garder »: the episode's audio follows its durations and zones
 * again. Kept ranges lose the episode's speech only, so a neighbour the user
 * keeps, whose roll reaches into this one, keeps its own.
 */
export function releaseEpisodeAudio(db: Database, episodeId: number, nowMs: number): void {
  transaction(db, () => {
    const overlapping = db.statement(
      `SELECT id, sample_start, sample_end, created_at_ms, origin FROM kept_audio
       WHERE track_run_id = ? AND sample_start < ? AND sample_end > ?`,
    );
    const remove = db.statement("DELETE FROM kept_audio WHERE id = ?");
    const insert = db.statement(
      `INSERT INTO kept_audio (track_run_id, sample_start, sample_end, created_at_ms, origin)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const speech of episodeSpeechRanges(db, episodeId)) {
      for (const row of overlapping.all(speech.trackRunId, speech.to, speech.from)) {
        const start = int(row, "sample_start");
        const end = int(row, "sample_end");
        remove.run(int(row, "id"));
        const created = int(row, "created_at_ms");
        const origin = str(row, "origin");
        if (start < speech.from) insert.run(speech.trackRunId, start, speech.from, created, origin);
        if (end > speech.to) insert.run(speech.trackRunId, speech.to, end, created, origin);
      }
    }
    db.statement("UPDATE episodes SET updated_at_ms = ? WHERE id = ?").run(nowMs, episodeId);
  });
}

/** Whether the user keeps the episode: a kept range reaches its speech. */
export function episodeAudioKept(db: Database, episodeId: number): boolean {
  const kept = db.statement(
    `SELECT 1 AS kept FROM kept_audio WHERE track_run_id = ? AND sample_start < ? AND sample_end > ?
     LIMIT 1`,
  );
  return episodeSpeechRanges(db, episodeId).some(
    (range) => kept.get(range.trackRunId, range.to, range.from) !== undefined,
  );
}
