import { randomBytes } from "node:crypto";
import type {
  CaptureHold,
  EpisodePrivacy,
  ListeningStatus,
  PrivacyAddZoneInput,
  PrivacyDurationInput,
  PrivacyDurationResult,
  PrivacyStatus,
  PrivacyUpdateZoneInput,
  PrivacyZone,
  ZoneSituationView,
} from "@sondine/api";
import { ServiceFailure } from "@sondine/api";
import { scheduleEndAt, siteOfInput, type Zone, type ZoneSituation } from "@sondine/core";
import type { ConfigMessage, HelperEvent, HoldOccurrence } from "@sondine/protocol";
import {
  BUILTIN_ZONE_IDS,
  DEFAULT_UNKEPT_SITES,
  ZoneNotFound,
  ZoneRefused,
  addZone,
  audioExpiryDue,
  browserLinkEnabled,
  currentNetworks,
  deleteEpisode,
  durations,
  durationsSince,
  episodePrivacy,
  heardSites,
  keepEpisodeAudio,
  listZones,
  liveTextToRemove,
  mediaSitesLeftOut,
  migrateSiteRules,
  networkKey,
  recordingsToDelete,
  recordSituation,
  recordingsToSilence,
  releaseEpisodeAudio,
  removeLiveText,
  removeZone,
  setDuration,
  setMediaSiteKept,
  takeAudioAfterText,
  takeEpisodeAudio,
  transaction,
  updateZone,
  type Database as CoreDatabase,
  type DroppedEpisodes,
  type TouchingZone,
} from "@sondine/db";
import { Context, Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect";
import { AnalysisQueue } from "../analysis/analysis-layer";
import { Importer } from "../capture/importer";
import { Database } from "../database";
import { HelperClient } from "../helper/helper-client";
import { log } from "../log";
import { ARCHIVE_CAP_BYTES, Retention } from "../retention/retention";
import { CoreState } from "../status/core-state";

// Private zones in core (ADR 029): the settings, what goes to the helper
// (the apps left out), and the pass that applies durations and zones to what
// is already kept: recordings whose time is up go whole, recordings a zone
// keeps the text of lose their audio, and audio past its type's time
// expires. Nothing here touches the user's pause.

const PASS_INTERVAL = "10 minutes";

export interface PrivacyService {
  readonly status: () => PrivacyStatus;
  readonly addZone: (input: PrivacyAddZoneInput) => Effect.Effect<PrivacyStatus, ServiceFailure>;
  readonly updateZone: (
    input: PrivacyUpdateZoneInput,
  ) => Effect.Effect<PrivacyStatus, ServiceFailure>;
  readonly removeZone: (id: string) => Effect.Effect<PrivacyStatus, ServiceFailure>;
  readonly setMediaSite: (
    site: string,
    kept: boolean,
  ) => Effect.Effect<PrivacyStatus, ServiceFailure>;
  readonly setDuration: (
    input: PrivacyDurationInput,
  ) => Effect.Effect<PrivacyDurationResult, ServiceFailure>;
  /** « Écouter quand même »: lifts one hold until it ends. */
  readonly lift: (occurrenceId: string) => Effect.Effect<ListeningStatus, ServiceFailure>;
  /** What zones and retention did to an episode, for its one line. */
  readonly episode: (episodeId: number) => EpisodePrivacy;
  readonly keepAudio: (
    episodeId: number,
    keep: boolean,
  ) => Effect.Effect<EpisodePrivacy, ServiceFailure>;
  /** Recordings a zone or a duration deleted whole: what « Supprimer » owes the rest. */
  readonly onDropped: (listener: (dropped: DroppedEpisodes) => void) => () => void;
  /** Runs the pass now (after a duration change, and in tests). */
  readonly runPass: Effect.Effect<void>;
}

export class Privacy extends Context.Service<Privacy, PrivacyService>()("sondine/core/Privacy") {}

function refused(error: unknown): ServiceFailure {
  if (error instanceof ZoneNotFound) return new ServiceFailure("not-found", error.message);
  if (error instanceof ZoneRefused) return new ServiceFailure("invalid-input", error.message);
  if (error instanceof ServiceFailure) return error;
  throw error;
}

const builtinIds: readonly string[] = BUILTIN_ZONE_IDS;

/** A zone's situation as Settings shows it; `here` for networks the Mac is on now. */
function situationView(
  situation: ZoneSituation,
  here: ReadonlySet<string>,
  leftOut: ReadonlySet<string>,
): ZoneSituationView {
  switch (situation.kind) {
    case "app":
      return { kind: "app", bundleId: situation.bundleId, name: situation.name };
    case "site":
      return { kind: "site", site: situation.site };
    case "media_sites":
      return {
        kind: "media_sites",
        sites: DEFAULT_UNKEPT_SITES.map((site) => ({ site, kept: !leftOut.has(site) })),
      };
    case "network":
      return {
        kind: "network",
        name: situation.name,
        here: situation.hashes.some((hash) => here.has(hash)),
      };
    case "hours":
      return {
        kind: "hours",
        name: situation.name,
        windows: situation.windows.map((window) => ({ ...window, days: [...window.days] })),
      };
    case "calls":
      return { kind: "calls" };
    case "screen":
      return { kind: "screen" };
  }
}

/** The apps left out of capture: app zones on at « Rien ». */
const excludedApps = (zones: readonly Zone[]) =>
  zones.flatMap((zone) =>
    zone.on && zone.outcome === "nothing" && zone.situation.kind === "app"
      ? [zone.situation.bundleId]
      : [],
  );

const zoneView = (
  zone: Zone,
  here: ReadonlySet<string>,
  leftOut: ReadonlySet<string>,
): PrivacyZone => ({
  id: zone.id,
  builtin: builtinIds.includes(zone.id),
  on: zone.on,
  outcome: zone.outcome,
  situation: situationView(zone.situation, here, leftOut),
});

/** What the helper holds itself, from the zones at « Rien » (ADR 029, protocol 5). */
interface HeldZones {
  readonly holds: ConfigMessage["holds"];
  /** The zone of each schedule window, by its index in `holds.schedule`. */
  readonly windowZones: readonly Zone[];
}

function heldZones(zones: readonly Zone[], key: string, lifted: readonly string[]): HeldZones {
  const held = zones.filter((zone) => zone.on && zone.outcome === "nothing");
  const windowZones: Zone[] = [];
  const schedule: ConfigMessage["holds"]["schedule"] = [];
  for (const zone of held) {
    if (zone.situation.kind !== "hours") continue;
    for (const window of zone.situation.windows) {
      if (schedule.length >= 32) break;
      schedule.push({
        days: [...window.days],
        startMinute: window.startMinute,
        endMinute: window.endMinute,
      });
      windowZones.push(zone);
    }
  }
  const networks = [
    ...new Set(
      held.flatMap((zone) => (zone.situation.kind === "network" ? zone.situation.hashes : [])),
    ),
  ].slice(0, 64);
  return {
    holds: {
      calls: held.some((zone) => zone.situation.kind === "calls"),
      screen: held.some((zone) => zone.situation.kind === "screen"),
      schedule,
      networks,
      networkKey: key,
      lifted: lifted.slice(-64),
    },
    windowZones,
  };
}

/** A hold as the menu bar names it: the app, the network or the hours, and when it ends. */
function holdView(
  db: CoreDatabase,
  hold: HoldOccurrence,
  zones: readonly Zone[],
  windowZones: readonly Zone[],
  nowMs: number,
): CaptureHold {
  const base = {
    occurrenceId: hold.occurrenceId,
    reason: hold.reason,
    scope: hold.scope,
    sinceMs: hold.sinceWallMs,
    lifted: hold.lifted,
  };
  switch (hold.reason) {
    case "app": {
      const zone = zones.find(
        (candidate) =>
          candidate.situation.kind === "app" && candidate.situation.bundleId === hold.bundleId,
      );
      const known =
        hold.bundleId === undefined
          ? undefined
          : db
              .statement("SELECT coalesce(name, bundle_id) AS name FROM apps WHERE bundle_id = ?")
              .get(hold.bundleId);
      const name =
        zone?.situation.kind === "app"
          ? zone.situation.name
          : known === undefined
            ? (hold.bundleId ?? null)
            : String(known["name"]);
      return { ...base, name, zoneId: zone?.id ?? null, untilMs: null };
    }
    case "network": {
      const zone = zones.find(
        (candidate) =>
          candidate.situation.kind === "network" &&
          hold.network !== undefined &&
          candidate.situation.hashes.includes(hold.network),
      );
      return {
        ...base,
        name: zone?.situation.kind === "network" ? zone.situation.name : null,
        zoneId: zone?.id ?? null,
        untilMs: null,
      };
    }
    case "schedule": {
      const zone = hold.window === undefined ? undefined : windowZones[hold.window];
      const windows = zone?.situation.kind === "hours" ? zone.situation.windows : [];
      return {
        ...base,
        name: zone?.situation.kind === "hours" ? zone.situation.name : null,
        zoneId: zone?.id ?? null,
        untilMs: scheduleEndAt(windows, nowMs),
      };
    }
    case "calls":
      return { ...base, name: null, zoneId: "calls", untilMs: null };
    case "screen":
      return { ...base, name: null, zoneId: "screen", untilMs: null };
  }
}

/** What zones and retention did to an episode (ADR 029), for its one line and agents. */
export function episodePrivacyView(
  db: CoreDatabase,
  episodeId: number,
  nowMs: number,
): EpisodePrivacy {
  const privacy = episodePrivacy(db, [episodeId], nowMs).get(episodeId);
  const row = db.statement("SELECT audio_gone_at_ms FROM episodes WHERE id = ?").get(episodeId);
  const here = new Set(currentNetworks(db));
  const leftOut = new Set(mediaSitesLeftOut(db));
  const touching: readonly TouchingZone[] = privacy?.zones ?? [];
  return {
    zones: touching.map((zone) => ({
      id: zone.zoneId,
      outcome: zone.outcome,
      situation: situationView(zone.situation, here, leftOut),
    })),
    kept: privacy?.kept ?? false,
    audioGone: row !== undefined && row["audio_gone_at_ms"] !== null,
    noText: privacy !== undefined && !privacy.keeping.text,
  };
}

export const privacyLayer = Layer.effect(
  Privacy,
  Effect.gen(function* () {
    const db = yield* Database;
    const helper = yield* HelperClient;
    const state = yield* CoreState;
    const retention = yield* Retention;
    const queue = yield* AnalysisQueue;
    const importer = yield* Importer;
    const listeners = new Set<(dropped: DroppedEpisodes) => void>();

    // Settings only: never the listening intent (ADR 029, « Migration »).
    const startMs = Date.now();
    migrateSiteRules(db, startMs);
    durationsSince(db, startMs);

    const key = networkKey(db, () => randomBytes(32).toString("base64"), startMs);
    /** Occurrences the user lifted (« Écouter quand même »), until the helper stops listing them. */
    let lifted: readonly string[] = [];
    let windowZones: readonly Zone[] = [];
    const applyToHelper = Effect.suspend(() => {
      const zones = listZones(db);
      const held = heldZones(zones, key, lifted);
      windowZones = held.windowZones;
      return helper.setZonePolicy({ excludedBundleIds: excludedApps(zones), holds: held.holds });
    });
    // Before the connection loop starts: the first `config` already leaves them out.
    yield* applyToHelper;

    const status = (): PrivacyStatus => {
      const zones = listZones(db);
      const here = new Set(currentNetworks(db));
      const leftOut = new Set(mediaSitesLeftOut(db));
      const zoned = new Set(
        zones.flatMap((zone) => (zone.situation.kind === "network" ? zone.situation.hashes : [])),
      );
      const appsHeard = db
        .statement(
          `SELECT bundle_id, coalesce(name, bundle_id) AS name, last_seen_ms FROM apps
           WHERE bundle_id NOT LIKE 'app.sondine%' ORDER BY last_seen_ms DESC, id LIMIT 50`,
        )
        .all()
        .map((row) => ({
          bundleId: String(row["bundle_id"]),
          name: String(row["name"]),
          lastHeardAtMs: Number(row["last_seen_ms"]),
        }));
      const { audioDays, deleteDays } = durations(db);
      return {
        zones: zones.map((zone) => zoneView(zone, here, leftOut)),
        durations: { audioDays: { ...audioDays }, deleteDays: { ...deleteDays } },
        appsHeard,
        sitesHeard: heardSites(db, Date.now())
          .filter((site) => site.lastPlayedAtMs !== null)
          .slice(0, 50)
          .map((site) => ({ site: site.site, lastPlayedAtMs: site.lastPlayedAtMs ?? 0 })),
        networkHere: [...here].some((hash) => !zoned.has(hash)),
        browserLink: browserLinkEnabled(db),
      };
    };

    /** A zone change: settings, then the helper, then the status. */
    const changed = <A>(work: () => A, fields: Record<string, string | number | boolean>) =>
      Effect.try({ try: work, catch: refused }).pipe(
        Effect.tap(() => applyToHelper),
        Effect.tap(() => Effect.sync(() => log.info("privacy.zone-changed", fields))),
        Effect.map(() => status()),
      );

    const toSituation = (input: PrivacyAddZoneInput): ZoneSituation => {
      switch (input.kind) {
        case "app": {
          const known = db
            .statement("SELECT coalesce(name, bundle_id) AS name FROM apps WHERE bundle_id = ?")
            .get(input.bundleId);
          const name = input.name ?? (known === undefined ? input.bundleId : String(known["name"]));
          return { kind: "app", bundleId: input.bundleId, name };
        }
        case "site": {
          const site = siteOfInput(input.site);
          if (site === null) {
            throw new ServiceFailure("invalid-input", "This is not a web site's address.");
          }
          return { kind: "site", site };
        }
        case "network": {
          const zoned = new Set(
            listZones(db).flatMap((zone) =>
              zone.situation.kind === "network" ? zone.situation.hashes : [],
            ),
          );
          // Every signature the Mac reads now (IPv4 and IPv6): any one recognises it later.
          const hashes = currentNetworks(db).filter((candidate) => !zoned.has(candidate));
          if (hashes.length === 0) {
            throw new ServiceFailure("invalid-input", "Sondine cannot recognise this network.");
          }
          return { kind: "network", hashes, name: input.name };
        }
        case "hours":
          return {
            kind: "hours",
            name: input.name,
            windows: input.windows.map((window) => ({
              days: window.days as (0 | 1 | 2 | 3 | 4 | 5 | 6)[],
              startMinute: window.startMinute,
              endMinute: window.endMinute,
            })),
          };
      }
    };

    // The pass: deletions through « Supprimer »'s path, audio a zone takes,
    // then expiry. Bounded per run; the next run takes the rest.
    // Where the bounded scans stopped: the next pass goes on from there.
    const cursors = { delete: 0, silence: 0 };
    const pass = Effect.gen(function* () {
      const nowMs = Date.now();
      const toDelete = recordingsToDelete(db, nowMs, { afterId: cursors.delete });
      cursors.delete = toDelete.next;
      const deleteIds = toDelete.ids;
      if (deleteIds.length > 0) {
        const dropped = transaction(db, () => {
          const episodeIds: number[] = [];
          const chunks: DroppedEpisodes["chunks"][number][] = [];
          for (const id of deleteIds) {
            const removed = deleteEpisode(db, id, { origin: "app", nowMs, checkpoint: false });
            if (!removed.deleted) continue;
            episodeIds.push(id);
            chunks.push(...removed.chunks);
          }
          return { episodeIds, chunks };
        });
        log.info("privacy.deleted", { episodes: dropped.episodeIds.length });
        for (const listener of listeners) listener(dropped);
      }
      const toSilence = recordingsToSilence(db, nowMs, { afterId: cursors.silence });
      cursors.silence = toSilence.next;
      const silenced = toSilence.ids;
      for (const id of silenced) {
        const chunks = takeEpisodeAudio(db, id, nowMs);
        if (chunks.length > 0) yield* retention.scrub(chunks);
      }
      if (silenced.length > 0) log.info("privacy.audio-taken", { episodes: silenced.length });
      const live = liveTextToRemove(db, nowMs).filter((id) => removeLiveText(db, id));
      if (live.length > 0) log.info("privacy.live-text-removed", { episodes: live.length });
      yield* retention.expireAudio;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => log.warn("privacy.pass-failed", { cause: String(cause).slice(0, 200) })),
      ),
      Effect.withSpan("privacy.pass"),
    );

    yield* importer.reconciledOnce.pipe(
      Effect.andThen(pass.pipe(Effect.andThen(Effect.sleep(PASS_INTERVAL)), Effect.forever)),
      Effect.forkScoped,
    );

    // A transcript just published: a zone that keeps the text alone takes the audio now.
    queue.onPublished((episodeId) => {
      const chunks = takeAudioAfterText(db, episodeId, Date.now());
      if (chunks.length === 0) return;
      log.info("privacy.audio-taken", { episodes: 1, after: "transcript" });
      Effect.runFork(retention.scrub(chunks));
    });

    const episode = (episodeId: number) => episodePrivacyView(db, episodeId, Date.now());

    // What the helper sees (ADR 029): situations are stored, holds shown.
    const events = yield* PubSub.subscribe(helper.events);
    const onEvent = (event: HelperEvent) =>
      Effect.gen(function* () {
        if (event.type === "situation") {
          recordSituation(
            db,
            { screenAway: event.screenAway, networks: event.networks },
            Date.now(),
          );
          return;
        }
        if (event.type !== "holds") return;
        const nowMs = Date.now();
        const zones = listZones(db);
        const holds = event.holds.map((hold) => holdView(db, hold, zones, windowZones, nowMs));
        yield* state.update((current) => ({
          ...current,
          listening: { ...current.listening, holds },
        }));
        // A lift whose occurrence ended goes from the next config.
        const listed = new Set(event.holds.map((hold) => hold.occurrenceId));
        const still = lifted.filter((id) => listed.has(id));
        if (still.length !== lifted.length) {
          lifted = still;
          yield* applyToHelper;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.warn("privacy.helper-event", { cause: String(cause).slice(0, 200) }),
          ),
        ),
      );
    yield* PubSub.take(events).pipe(Effect.flatMap(onEvent), Effect.forever, Effect.forkScoped);
    // A helper that is gone holds nothing Sondine can vouch for: its next snapshot says.
    yield* SubscriptionRef.changes(helper.connection).pipe(
      Stream.filter((connection) => connection.state !== "connected"),
      Stream.runForEach(() =>
        state.update((current) => ({ ...current, listening: { ...current.listening, holds: [] } })),
      ),
      Effect.forkScoped,
    );

    return Privacy.of({
      status,
      addZone: (input) =>
        changed(() => addZone(db, toSituation(input), Date.now()), { added: input.kind }),
      updateZone: (input) =>
        changed(
          () =>
            updateZone(
              db,
              input.id,
              {
                ...(input.on === undefined ? {} : { on: input.on }),
                ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.windows === undefined
                  ? {}
                  : {
                      windows: input.windows.map((window) => ({
                        days: window.days as (0 | 1 | 2 | 3 | 4 | 5 | 6)[],
                        startMinute: window.startMinute,
                        endMinute: window.endMinute,
                      })),
                    }),
              },
              Date.now(),
            ),
          { changed: input.outcome ?? (input.on === undefined ? "edit" : String(input.on)) },
        ),
      removeZone: (id) => changed(() => removeZone(db, id, Date.now()), { removed: true }),
      setMediaSite: (site, kept) =>
        changed(() => setMediaSiteKept(db, site, kept, Date.now()), { mediaSiteKept: kept }),
      setDuration: (input) =>
        Effect.gen(function* () {
          const nowMs = Date.now();
          const change = {
            ...(input.audioDays === undefined ? {} : { audioDays: input.audioDays }),
            ...(input.deleteDays === undefined ? {} : { deleteDays: input.deleteDays }),
          };
          // What would go now: counted with the change in place, rolled back unless confirmed.
          const counted = yield* Effect.try({
            try: () => {
              let counts = { deletes: 0, silences: 0 };
              try {
                transaction(db, () => {
                  setDuration(db, input.type, change, nowMs);
                  counts = {
                    deletes: recordingsToDelete(db, nowMs, { limit: 10_000, budget: 100_000 }).ids
                      .length,
                    silences: audioExpiryDue(db, {
                      nowMs,
                      capBytes: ARCHIVE_CAP_BYTES,
                      limit: 10_000,
                    }).episodeIds.length,
                  };
                  throw new RollBack();
                });
              } catch (error) {
                if (!(error instanceof RollBack)) throw error;
              }
              return counts;
            },
            catch: refused,
          });
          const goes = counted.deletes + counted.silences > 0;
          if (goes && !input.confirm) {
            return { applied: false, ...counted, status: status() };
          }
          yield* Effect.try({
            try: () => setDuration(db, input.type, change, nowMs),
            catch: refused,
          });
          log.info("privacy.duration-set", { type: input.type, ...counted });
          if (goes) yield* pass;
          return { applied: true, ...counted, status: status() };
        }),
      lift: (occurrenceId) =>
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state.status);
          if (!current.listening.holds.some((hold) => hold.occurrenceId === occurrenceId)) {
            return yield* Effect.fail(new ServiceFailure("not-found", "This hold has ended."));
          }
          if (!lifted.includes(occurrenceId)) {
            lifted = [...lifted, occurrenceId];
            log.info("privacy.lifted", {});
            yield* applyToHelper;
          }
          // Shown lifted at once; the helper's next `holds` confirms it.
          yield* state.update((now) => ({
            ...now,
            listening: {
              ...now.listening,
              holds: now.listening.holds.map((hold) =>
                hold.occurrenceId === occurrenceId ? { ...hold, lifted: true } : hold,
              ),
            },
          }));
          return (yield* SubscriptionRef.get(state.status)).listening;
        }),
      episode,
      keepAudio: (episodeId, keep) =>
        Effect.try({
          try: () => {
            if (keep) {
              if (!keepEpisodeAudio(db, episodeId, Date.now())) {
                throw new ServiceFailure("not-found", "This recording has no audio left.");
              }
            } else {
              releaseEpisodeAudio(db, episodeId, Date.now());
            }
            log.info("privacy.audio-kept", { episodeId, keep });
            return episode(episodeId);
          },
          catch: refused,
        }),
      onDropped: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      runPass: pass,
    });
  }),
);

class RollBack extends Error {
  override readonly name = "RollBack";
}
