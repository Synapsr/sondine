import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  audioStates,
  callEndReasons,
  callVias,
  deviceTransports,
  epochReasons,
  gapReasons,
  listenVias,
  selfEchoVerdicts,
  playbackRoutes,
  processEvidence,
  speechRegionEndReasons,
  speechRegionStates,
  spoolFileStates,
  trackRunEndReasons,
  trackRunStates,
  trackSourceKinds,
} from "./enums";
import { oneOf } from "./check";

// Monotonic clocks are stored in microseconds: nanosecond values (wall time,
// or mach_continuous_time after ~104 days of uptime) exceed 2^53, and
// node:sqlite throws when reading such integers as numbers.

/**
 * A raw mach_absolute_time value (up to 2^63 - 1). Stored as INTEGER, bound
 * as a bigint, and read through `cast(... as text)` so node:sqlite never has
 * to return it as a number.
 */
const hostTicks = customType<{ data: bigint; driverData: bigint }>({
  dataType: () => "integer",
  codec: "numeric:bigint",
});

export const devices = sqliteTable(
  "devices",
  {
    id: integer("id").primaryKey(),
    uid: text("uid").notNull().unique(),
    name: text("name").notNull(),
    transport: text("transport", { enum: deviceTransports }).notNull().default("unknown"),
    hasInput: integer("has_input", { mode: "boolean" }).notNull().default(false),
    hasOutput: integer("has_output", { mode: "boolean" }).notNull().default(false),
    firstSeenMs: integer("first_seen_ms").notNull(),
    lastSeenMs: integer("last_seen_ms").notNull(),
  },
  (t) => [check("devices_transport_check", oneOf(t.transport, deviceTransports))],
);

export const apps = sqliteTable("apps", {
  id: integer("id").primaryKey(),
  bundleId: text("bundle_id").notNull().unique(),
  name: text("name"),
  firstSeenMs: integer("first_seen_ms").notNull(),
  lastSeenMs: integer("last_seen_ms").notNull(),
});

export const processIncarnations = sqliteTable(
  "process_incarnations",
  {
    id: integer("id").primaryKey(),
    pid: integer("pid").notNull(),
    startedWallMs: integer("started_wall_ms").notNull(),
    bundleId: text("bundle_id"),
    appId: integer("app_id").references(() => apps.id),
    responsiblePid: integer("responsible_pid"),
    evidence: text("evidence", { enum: processEvidence }),
    confidence: real("confidence"),
    firstSeenMs: integer("first_seen_ms").notNull(),
    lastSeenMs: integer("last_seen_ms").notNull(),
    exitedWallMs: integer("exited_wall_ms"),
  },
  (t) => [
    unique("process_incarnations_pid_start_unique").on(t.pid, t.startedWallMs),
    check("process_incarnations_evidence_check", oneOf(t.evidence, processEvidence)),
    check("process_incarnations_confidence_check", sql`${t.confidence} between 0 and 1`),
  ],
);

export const trackRuns = sqliteTable(
  "track_runs",
  {
    id: integer("id").primaryKey(),
    uid: text("uid").notNull().unique(),
    trackKey: text("track_key").notNull(),
    sourceKind: text("source_kind", { enum: trackSourceKinds }).notNull(),
    deviceId: integer("device_id").references(() => devices.id),
    appId: integer("app_id").references(() => apps.id),
    sampleRate: integer("sample_rate").notNull().default(16000),
    state: text("state", { enum: trackRunStates }).notNull().default("open"),
    endReason: text("end_reason", { enum: trackRunEndReasons }),
    startedWallMs: integer("started_wall_ms").notNull(),
    endedWallMs: integer("ended_wall_ms"),
    sampleEnd: integer("sample_end"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("track_runs_track_key_started_idx").on(t.trackKey, t.startedWallMs),
    index("track_runs_started_idx").on(t.startedWallMs),
    check("track_runs_source_kind_check", oneOf(t.sourceKind, trackSourceKinds)),
    check("track_runs_state_check", oneOf(t.state, trackRunStates)),
    check("track_runs_end_reason_check", oneOf(t.endReason, trackRunEndReasons)),
    check("track_runs_sample_rate_check", sql`${t.sampleRate} > 0`),
    check(
      "track_runs_end_check",
      sql`(${t.state} = 'open' and ${t.endedWallMs} is null) or (${t.state} <> 'open' and ${t.endedWallMs} is not null)`,
    ),
  ],
);

export const epochs = sqliteTable(
  "epochs",
  {
    id: integer("id").primaryKey(),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    seq: integer("seq").notNull(),
    reason: text("reason", { enum: epochReasons }).notNull(),
    sampleStart: integer("sample_start").notNull(),
    measuredRateHz: real("measured_rate_hz"),
    timebaseNumer: integer("timebase_numer").notNull(),
    timebaseDenom: integer("timebase_denom").notNull(),
    anchorHostTicks: hostTicks("anchor_host_ticks").notNull(),
    anchorContinuousUs: integer("anchor_continuous_us").notNull(),
    anchorWallMs: integer("anchor_wall_ms").notNull(),
    driftPpm: real("drift_ppm"),
    alignmentUncertaintyUs: integer("alignment_uncertainty_us"),
  },
  (t) => [
    unique("epochs_run_seq_unique").on(t.trackRunId, t.seq),
    check("epochs_reason_check", oneOf(t.reason, epochReasons)),
    check("epochs_timebase_check", sql`${t.timebaseNumer} > 0 and ${t.timebaseDenom} > 0`),
  ],
);

export const spoolFiles = sqliteTable(
  "spool_files",
  {
    id: integer("id").primaryKey(),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    seq: integer("seq").notNull(),
    relPath: text("rel_path").notNull().unique(),
    sampleStart: integer("sample_start").notNull(),
    committedBytes: integer("committed_bytes").notNull().default(0),
    state: text("state", { enum: spoolFileStates }).notNull().default("open"),
    createdWallMs: integer("created_wall_ms").notNull(),
    closedWallMs: integer("closed_wall_ms"),
  },
  (t) => [
    unique("spool_files_run_seq_unique").on(t.trackRunId, t.seq),
    check("spool_files_state_check", oneOf(t.state, spoolFileStates)),
  ],
);

/** One committed block of a spool file (one manifest commit record). */
export const chunks = sqliteTable(
  "chunks",
  {
    id: integer("id").primaryKey(),
    spoolFileId: integer("spool_file_id")
      .notNull()
      .references(() => spoolFiles.id),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    byteOffset: integer("byte_offset").notNull(),
    byteLength: integer("byte_length").notNull(),
    sampleStart: integer("sample_start").notNull(),
    sampleCount: integer("sample_count").notNull(),
    hostTicks: hostTicks("host_ticks"),
    continuousUs: integer("continuous_us"),
    wallMs: integer("wall_ms").notNull(),
    crc32: integer("crc32").notNull(),
    audioState: text("audio_state", { enum: audioStates }).notNull().default("present"),
    archiveRelPath: text("archive_rel_path"),
    /** Where this chunk's bytes start in its archive file (ADR 016). */
    archiveByteOffset: integer("archive_byte_offset"),
  },
  (t) => [
    unique("chunks_spool_offset_unique").on(t.spoolFileId, t.byteOffset),
    index("chunks_run_sample_idx").on(t.trackRunId, t.sampleStart),
    index("chunks_wall_idx").on(t.wallMs),
    check("chunks_audio_state_check", oneOf(t.audioState, audioStates)),
    check(
      "chunks_pcm16_check",
      sql`${t.sampleCount} > 0 and ${t.byteLength} = ${t.sampleCount} * 2`,
    ),
    check("chunks_offset_check", sql`${t.byteOffset} >= 0`),
    check("chunks_crc32_check", sql`${t.crc32} between 0 and 4294967295`),
    check(
      "chunks_archive_check",
      sql`(${t.archiveRelPath} is null) = (${t.archiveByteOffset} is null) and (${t.archiveByteOffset} is null or ${t.archiveByteOffset} >= 0)`,
    ),
  ],
);

export const speechRegions = sqliteTable(
  "speech_regions",
  {
    id: integer("id").primaryKey(),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    sampleStart: integer("sample_start").notNull(),
    sampleEnd: integer("sample_end"),
    wallStartMs: integer("wall_start_ms").notNull(),
    wallEndMs: integer("wall_end_ms"),
    continuousStartUs: integer("continuous_start_us"),
    continuousEndUs: integer("continuous_end_us"),
    state: text("state", { enum: speechRegionStates }).notNull().default("open"),
    endReason: text("end_reason", { enum: speechRegionEndReasons }),
    /**
     * Samples the VAD heard as speech between the bounds, which also hold
     * pauses shorter than its minimum silence; at most the closed span.
     * Episodes are sized on it. Null while open, and for regions closed
     * before the helper reported it: their span counts instead.
     */
    voicedSamples: integer("voiced_samples"),
    vadVersion: text("vad_version").notNull(),
    /**
     * A `system:other` region: the one app its track's attribution named when
     * the region opened (`single-active`); null when ambiguous or unknown
     * (a region recovered from a manifest). For display and call matching only.
     */
    attributedAppId: integer("attributed_app_id").references(() => apps.id),
  },
  (t) => [
    unique("speech_regions_run_start_unique").on(t.trackRunId, t.sampleStart),
    index("speech_regions_wall_start_idx").on(t.wallStartMs),
    check("speech_regions_state_check", oneOf(t.state, speechRegionStates)),
    check("speech_regions_end_reason_check", oneOf(t.endReason, speechRegionEndReasons)),
    check(
      "speech_regions_end_check",
      sql`(${t.state} = 'open' and ${t.sampleEnd} is null) or (${t.state} = 'closed' and ${t.sampleEnd} is not null and ${t.wallEndMs} is not null and ${t.sampleEnd} > ${t.sampleStart})`,
    ),
  ],
);

/**
 * The app in front on the Mac over part of a speech region (ADR 022), as the
 * helper cut the region at each change: a sentence is said in the app whose
 * span covers most of it. Only speech has spans, never the rest of the day;
 * they go with their region, and a deletion cuts them like the user's
 * assertions. Wall times place them for « forget the last minutes ».
 */
export const foregroundSpans = sqliteTable(
  "foreground_spans",
  {
    id: integer("id").primaryKey(),
    speechRegionId: integer("speech_region_id")
      .notNull()
      .references(() => speechRegions.id, { onDelete: "cascade" }),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    sampleStart: integer("sample_start").notNull(),
    sampleEnd: integer("sample_end").notNull(),
    wallStartMs: integer("wall_start_ms").notNull(),
    wallEndMs: integer("wall_end_ms").notNull(),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id),
  },
  (t) => [
    unique("foreground_spans_region_start_unique").on(t.speechRegionId, t.sampleStart),
    index("foreground_spans_track_run_sample_idx").on(t.trackRunId, t.sampleStart),
    index("foreground_spans_app_idx").on(t.appId, t.wallStartMs),
    index("foreground_spans_wall_start_idx").on(t.wallStartMs),
    check("foreground_spans_samples_check", sql`${t.sampleEnd} > ${t.sampleStart}`),
    check("foreground_spans_wall_check", sql`${t.wallEndMs} >= ${t.wallStartMs}`),
  ],
);

export const gaps = sqliteTable(
  "gaps",
  {
    id: integer("id").primaryKey(),
    trackRunId: integer("track_run_id").references(() => trackRuns.id),
    trackKey: text("track_key"),
    reason: text("reason", { enum: gapReasons }).notNull(),
    wallStartMs: integer("wall_start_ms").notNull(),
    wallEndMs: integer("wall_end_ms").notNull(),
    sampleStart: integer("sample_start"),
    sampleEnd: integer("sample_end"),
    lostBytes: integer("lost_bytes"),
    detail: text("detail"),
  },
  (t) => [
    uniqueIndex("gaps_identity_unique").on(
      sql`coalesce(${t.trackRunId}, 0)`,
      sql`coalesce(${t.trackKey}, '')`,
      t.reason,
      t.wallStartMs,
    ),
    index("gaps_wall_start_idx").on(t.wallStartMs),
    check("gaps_reason_check", oneOf(t.reason, gapReasons)),
    check("gaps_range_check", sql`${t.wallEndMs} >= ${t.wallStartMs}`),
  ],
);

/**
 * One active span of a call app, call daemon, or browser using a microphone,
 * from the helper's `call` events (ADR 016, "Episodes"). Keyed by the
 * helper's call id, so replayed events change nothing. Both clocks are kept:
 * wall time for display, continuous time to place the call on its boot's
 * timeline next to the speech regions. The bundle ID is for display and
 * matching only.
 */
export const calls = sqliteTable(
  "calls",
  {
    id: integer("id").primaryKey(),
    uid: text("uid").notNull().unique(),
    /** The helper launch that reported it: only that helper can end it by an event. */
    sessionId: text("session_id").notNull(),
    bundleId: text("bundle_id").notNull(),
    appId: integer("app_id").references(() => apps.id),
    via: text("via", { enum: callVias }).notNull(),
    inputDeviceUid: text("input_device_uid"),
    startedWallMs: integer("started_wall_ms").notNull(),
    startedContinuousUs: integer("started_continuous_us").notNull(),
    /** Null while the call is active. */
    endedWallMs: integer("ended_wall_ms"),
    endedContinuousUs: integer("ended_continuous_us"),
    endReason: text("end_reason", { enum: callEndReasons }),
    /** The latest helper clock at which the call was still active; a lost call ends there. */
    lastSeenWallMs: integer("last_seen_wall_ms").notNull(),
    lastSeenContinuousUs: integer("last_seen_continuous_us").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("calls_started_idx").on(t.startedWallMs),
    check("calls_via_check", oneOf(t.via, callVias)),
    check("calls_end_reason_check", oneOf(t.endReason, callEndReasons)),
    check(
      "calls_end_check",
      sql`(${t.endedWallMs} is null and ${t.endedContinuousUs} is null and ${t.endReason} is null) or (${t.endedWallMs} is not null and ${t.endedContinuousUs} is not null and ${t.endReason} is not null and ${t.endedContinuousUs} >= ${t.startedContinuousUs})`,
    ),
    check("calls_last_seen_check", sql`${t.lastSeenContinuousUs} >= ${t.startedContinuousUs}`),
  ],
);

/**
 * One span of an app other than a call listening to a microphone (a
 * dictation app, a browser page, the system's speech recognition), from the
 * helper's `listen` events. Same keys, clocks and replay rules as `calls`
 * (packages/db/src/calls.ts); whether a span is a dictation is the user's
 * rule for its app, decided when episodes are grouped.
 */
export const listens = sqliteTable(
  "listens",
  {
    id: integer("id").primaryKey(),
    uid: text("uid").notNull().unique(),
    sessionId: text("session_id").notNull(),
    bundleId: text("bundle_id").notNull(),
    appId: integer("app_id").references(() => apps.id),
    via: text("via", { enum: listenVias }).notNull(),
    startedWallMs: integer("started_wall_ms").notNull(),
    startedContinuousUs: integer("started_continuous_us").notNull(),
    /** Null while the app listens. */
    endedWallMs: integer("ended_wall_ms"),
    endedContinuousUs: integer("ended_continuous_us"),
    endReason: text("end_reason", { enum: callEndReasons }),
    lastSeenWallMs: integer("last_seen_wall_ms").notNull(),
    lastSeenContinuousUs: integer("last_seen_continuous_us").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("listens_started_idx").on(t.startedWallMs),
    check("listens_via_check", oneOf(t.via, listenVias)),
    check("listens_end_reason_check", oneOf(t.endReason, callEndReasons)),
    check(
      "listens_end_check",
      sql`(${t.endedWallMs} is null and ${t.endedContinuousUs} is null and ${t.endReason} is null) or (${t.endedWallMs} is not null and ${t.endedContinuousUs} is not null and ${t.endReason} is not null and ${t.endedContinuousUs} >= ${t.startedContinuousUs})`,
    ),
    check("listens_last_seen_check", sql`${t.lastSeenContinuousUs} >= ${t.startedContinuousUs}`),
  ],
);

/**
 * Sondine playing a recording back, as the window's player reports it
 * (`player.state`): the microphone hears what the speakers play, and that is
 * no speech of the room's, unless someone spoke over it (`self_echoes`, ADR
 * 033). A row is a lease the player renews every few
 * seconds while it plays, so a window that dies stops it soon. Wall time
 * only: the player knows no capture clock.
 */
export const selfPlaybacks = sqliteTable(
  "self_playbacks",
  {
    id: integer("id").primaryKey(),
    startedWallMs: integer("started_wall_ms").notNull(),
    /** The lease's end while it plays; when it stopped once it did. */
    endedWallMs: integer("ended_wall_ms").notNull(),
    route: text("route", { enum: playbackRoutes }).notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("self_playbacks_started_idx").on(t.startedWallMs),
    check("self_playbacks_route_check", oneOf(t.route, playbackRoutes)),
    check("self_playbacks_span_check", sql`${t.endedWallMs} >= ${t.startedWallMs}`),
  ],
);

/**
 * What a mic region heard while Sondine played on the speakers (ADR 035),
 * judged once against the private `self:playback` reference: echo of the
 * playback (no episode holds the region), someone speaking (it stays, and
 * the echo stretches inside it leave its transcript), or too little
 * reference to tell (ADR 020's rule: left out). Numbers only: the reference
 * itself never reaches the database. Deleting the region deletes the row.
 */
export const selfEchoes = sqliteTable(
  "self_echoes",
  {
    speechRegionId: integer("speech_region_id")
      .primaryKey()
      .references(() => speechRegions.id, { onDelete: "cascade" }),
    /** The detector's id (`envelope-echo/1`): another version judges again. */
    method: text("method").notNull(),
    verdict: text("verdict", { enum: selfEchoVerdicts }).notNull(),
    voicedMs: integer("voiced_ms").notNull(),
    coveredMs: integer("covered_ms").notNull(),
    echoMs: integer("echo_ms").notNull(),
    nearEndMs: integer("near_end_ms").notNull(),
    lagMs: integer("lag_ms"),
    correlation: real("correlation").notNull(),
    /** Echo stretches of a `near_end` region, in run samples: `[[start, end], …]`. */
    spans: text("spans", { mode: "json" }).$type<[number, number][]>().notNull(),
    judgedAtMs: integer("judged_at_ms").notNull(),
  },
  (t) => [
    check("self_echoes_verdict_check", oneOf(t.verdict, selfEchoVerdicts)),
    check(
      "self_echoes_spans_check",
      sql`json_valid(${t.spans}) and json_type(${t.spans}) = 'array'`,
    ),
    check(
      "self_echoes_ms_check",
      sql`${t.voicedMs} >= 0 and ${t.coveredMs} >= 0 and ${t.echoMs} >= 0 and ${t.nearEndMs} >= 0`,
    ),
  ],
);
