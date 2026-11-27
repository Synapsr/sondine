import { cpus, homedir } from "node:os";
import {
  ServiceFailure,
  type ApiServices,
  type CallContext as CallContextOutput,
  type ContextAddResult,
  type ContextItem,
  type DictationApps,
  type EpisodeDetail,
  type EpisodePage,
  type EpisodeSummary,
  type PermissionKind,
  type PersonRef,
  type PersonSummary,
  type SpeakerNameInput,
  type VoiceMatch as ApiVoiceMatch,
  type TranscriptFormat,
  type UndoStep,
} from "@sondine/api";
import { correctionLessons, pageLinkAt, positionAt, siteName, webPageOf } from "@sondine/core";
import {
  analysisRequested,
  browseTag,
  compileSearch,
  currentSpeakerRun,
  deleteEpisode,
  deletePassage,
  durableTransaction,
  deletePerson,
  addVocabularyWord,
  editSegment,
  episodeKindOverride,
  deleteTag,
  episodeTags,
  findTag,
  phoneNotes,
  listTags,
  listVocabulary,
  removeVocabularyWord,
  segmentHeard,
  updateVocabularyWord,
  vocabularyOf,
  type VocabularyChange,
  renameTag,
  setEpisodeTag,
  episodeNeighbours,
  episodePeople,
  episodeRecognized,
  enqueueMissingAnalysis,
  episodesInRange,
  phoneRecordingsInRange,
  forgetRange,
  KEEP_RECENT_MS,
  keepRecentAudio,
  getEpisodeDetail,
  getPerson,
  highlightRanges,
  KNOWN_DICTATION_APPS,
  listImports,
  listeningApps,
  listEpisodes,
  listPeople,
  knownVoices,
  loadEpisodeApps,
  loadEpisodeMarks,
  loadEpisodePages,
  mergePeople,
  mergeVoice,
  type EpisodeApp,
  loadEpisodeDay,
  loadEpisodeSummaries,
  loadSelfSpeakers,
  matchingSegmentIds,
  mergeEpisodes,
  namedRuns,
  nameSpeaker,
  namingAllowed,
  notePlaying,
  noteStopped,
  setDictationApp,
  setDictationText,
  notchOpensOnHover,
  learnsFromDictations,
  recognitionEnabled,
  doubtedNames,
  readsAsPerson,
  recognizedVoices,
  shownSelf,
  refuseSuggestion,
  renamePerson,
  resolveSpeakers,
  restoreSegment,
  listForegroundApps,
  searchEpisodes,
  selfPersonId,
  setEpisodeRecognition,
  setEpisodeKind,
  sameMomentsOf,
  setSameMomentSource,
  setNotchOpensOnHover,
  setLearnFromDictations,
  setRecognition,
  splitEpisode,
  unnameSpeaker,
  unnamedVoices,
  loadDayTotals,
  loadStatistics,
  UndoHistory,
  voiceLikeness,
  voiceMatches,
  type AddContextResult,
  type Database as CoreDatabase,
  endedEpisodeId,
  endOfEpisode,
  redoEnd,
  undoEnd,
  type StoredEnd,
  type UndoOperation,
  type UndoScope,
  type UndoStep as HistoryStep,
  type DayHour,
  type EpisodeCursor,
  type EpisodePageRows,
  type EpisodeSummaryRow,
  type BoundaryRefusal,
  type EditOutcome,
  type KnownVoices,
  type NamedRun,
  type Person,
  type Tag,
  type PersonEpisodes,
  type RecognizedVoice,
  type SelfSpeaker,
  type SpeakerChange,
  type StoredEpisodePage,
  type VoiceMatch,
  addContextItems,
  editContextItem,
  getContextItem,
  linkContextTranscript,
  listContextItems,
  ongoingEpisode,
  planContextAnchor,
  removeContextItem,
  unpinContextItem,
  type ContextItemView,
  type DroppedEpisodes,
  failuresSince,
  jobCounts,
} from "@sondine/db";
import type { PermissionsEvent } from "@sondine/protocol";
import { Context, Effect, Layer, Ref, Stream, SubscriptionRef } from "effect";
import { contextMediaUrl, episodeMediaUrl } from "../shared/media-url";
import { AGENT_DOCUMENT_TYPES, safeFileName } from "./context/context-files";
import {
  AGENT_FILE_BYTES,
  ContextStore,
  newItemOf,
  type ContextRefusal,
} from "./context/context-layer";
import { BrowserLink } from "./browser/browser-link";
import { PhoneSync } from "./phone/phone-layer";
import { AgentAccess } from "./agents/agent-access";
import { Chat } from "./chat/chat-layer";
import { makeAgentServices } from "./agents/agent-services";
import { AnalysisQueue } from "./analysis/analysis-layer";
import { Compute } from "./compute/compute-layer";
import { Journal } from "./journal/journal-layer";
import { makeJournalServices } from "./journal/journal-services";
import { LiveText } from "./live/live-layer";
import { diagnosticText, DIAGNOSTIC_DAYS } from "./diagnostic";
import { GoingOnActions } from "./going-on";
import { Updates } from "./updates/updates-layer";
import { UsageStatistics } from "./usage/usage-layer";
import { Exports } from "./exports";
import { CallContext } from "./voices/call-context-layer";
import type { CallState } from "./voices/call-voices";
import { VoicePass } from "./voices/voice-pass";
import { EpisodeMedia } from "./audio/episode-media";
import { EpisodeBuilder } from "./episodes/episode-builder";
import { CoreConfig } from "./config";
import { Importer } from "./capture/importer";
import { installedApps } from "./installed-apps";
import { Imports, isTranscribable } from "./imports/imports-layer";
import { Database } from "./database";
import { HelperClient, type HelperRequestError } from "./helper/helper-client";
import { Listening, type PauseInPast } from "./listening";
import { log } from "./log";
import { MainChannel } from "./main-channel";
import { ModelRequestError } from "./models/model-manager";
import { Models } from "./models/models-layer";
import { Onboarding } from "./onboarding";
import { readDisplaySettings, updateDisplaySettings } from "./display-settings";
import { VoiceRead } from "./voices/voice-read";
import { Backup } from "./backup/backup-layer";
import { Privacy, episodePrivacyView } from "./privacy/privacy";
import { CallOffers, type CallOfferGone } from "./call-offers/call-offers";
import { Retention } from "./retention/retention";
import { Spans } from "./spans";
import { CoreState } from "./status/core-state";

/** The services behind every oRPC procedure, run on core's Effect runtime. */
export class Api extends Context.Service<Api, ApiServices>()("sondine/core/Api") {}

function toFailure(error: HelperRequestError): ServiceFailure {
  switch (error._tag) {
    case "HelperUnavailable":
      return new ServiceFailure(
        "helper-unavailable",
        `The capture helper is not connected (${error.reason}).`,
      );
    case "HelperRejected":
      return new ServiceFailure(
        "helper-rejected",
        `${error.request}: ${error.message}`,
        error.code,
      );
    case "HelperTimeout":
      return new ServiceFailure(
        "timeout",
        `The capture helper did not answer ${error.request} in time.`,
      );
  }
}

function pauseFailure(error: HelperRequestError | PauseInPast): ServiceFailure {
  return error._tag === "PauseInPast"
    ? new ServiceFailure(
        "invalid-input",
        `The pause would end at ${new Date(error.untilMs).toISOString()}, which has passed.`,
      )
    : toFailure(error);
}

function callOfferFailure(error: HelperRequestError | CallOfferGone): ServiceFailure {
  return error._tag === "CallOfferGone"
    ? new ServiceFailure("not-found", "This call is no longer offered.")
    : toFailure(error);
}

/** Unknown artifacts and missing files become NOT_FOUND; anything else stays an internal error. */
async function modelCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ModelRequestError) throw new ServiceFailure("not-found", error.message);
    throw error;
  }
}

/** A stream until `signal` aborts. */
function untilAborted(signal: AbortSignal | undefined) {
  return Effect.callback<void>((resume) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

const isGranted = (status: string) => status === "granted" || status === "granted-verified";

/** macOS will not show the prompt again for these; only System Settings can change them. */
const isBlocked = (status: string) => status === "denied" || status === "restricted";

/** The helper answers `request.permissions` once the user has answered the system prompt. */
const PROMPT_TIMEOUT_MS = 120_000;

const FIRST_WORDS_MAX = 120;

/** The start of a transcript, cut at a word boundary. */
export function firstWords(text: string | null): string | null {
  if (text === null) return null;
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= FIRST_WORDS_MAX) return clean;
  const cut = clean.slice(0, FIRST_WORDS_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 40 ? cut.slice(0, space) : cut}…`;
}

/** `apps`: the episode's entry of `loadEpisodeApps`; absent means none (likewise `page`). */
export function toEpisodeSummary(
  row: EpisodeSummaryRow,
  apps: readonly EpisodeApp[] = [],
  people: readonly Person[] = [],
  page?: StoredEpisodePage,
  recognized: readonly Person[] = [],
  tags: readonly Tag[] = [],
  note = false,
): EpisodeSummary {
  return {
    id: row.id,
    // Ended by the user (ADR 044): what is left is importing its last seconds.
    state: row.ending ? "closed" : row.state,
    context: row.context,
    size: row.size,
    sizeProvisional: row.sizeState === "provisional",
    analysisState: row.analysisState,
    startedAtMs: row.startedAtMs,
    endedAtMs: row.endedAtMs,
    voicedMs: row.voicedMs,
    firstWords: firstWords(row.firstText),
    speakerCount: row.speakerCount,
    // macOS may name no app for a page's sound: the browser that played it did.
    apps: (apps.length === 0 && page?.browser != null ? [page.browser] : apps).map((app) => ({
      bundleId: app.bundleId,
      name: app.name,
    })),
    people: people.map((person) => ({ id: person.id, name: person.name, self: person.isSelf })),
    recognized: recognized.map((person) => ({
      id: person.id,
      name: person.name,
      self: person.isSelf,
    })),
    live: row.live,
    page:
      page === undefined
        ? null
        : {
            site: page.site,
            name: siteName(page.site),
            title: page.title,
            url: page.url,
            video: page.video,
          },
    phone: row.phone,
    alsoRecordedBy: row.alsoRecordedBy,
    keptAtMs: row.keptAtMs,
    note,
    tags: tags.map((tag) => tag.name),
  };
}

/**
 * The user's names and everyone's reference voices, read once per request:
 * what recognizing voices needs (ADR 030). Lazy, so a request that shows no
 * voice pays nothing.
 */
export interface VoiceEvidence {
  readonly runs: () => readonly NamedRun[];
  readonly known: () => KnownVoices;
}

export function voiceEvidence(db: CoreDatabase): VoiceEvidence {
  let runs: readonly NamedRun[] | null = null;
  let known: KnownVoices | null = null;
  const readRuns = () => (runs ??= namedRuns(db));
  return {
    runs: readRuns,
    known: () => (known ??= knownVoices(db, readRuns())),
  };
}

/** Summaries with the apps each episode heard, the people named in it and those recognized. */
export function episodeSummaries(
  db: CoreDatabase,
  rows: readonly EpisodeSummaryRow[],
  nowMs = Date.now(),
  evidence: VoiceEvidence = voiceEvidence(db),
): EpisodeSummary[] {
  const apps = loadEpisodeApps(db, rows, nowMs);
  const ids = rows.map((row) => row.id);
  const people = episodePeople(db, ids);
  // Media and dictations have no voice to recognize: nothing read for them.
  const recognized =
    anyoneNamed(db) && anyEmbedded(db, ids)
      ? episodeRecognized(db, ids, { runs: evidence.runs(), known: evidence.known() })
      : new Map<number, Person[]>();
  const pages = loadEpisodePages(db, rows, nowMs);
  const tags = episodeTags(db, ids);
  const notes = phoneNotes(db, rows);
  return rows.map((row) =>
    toEpisodeSummary(
      row,
      apps.get(row.id),
      people.get(row.id),
      pages.get(row.id),
      recognized.get(row.id),
      tags.get(row.id),
      notes.has(row.id),
    ),
  );
}

/** Whether anyone is named at all: until then no voice can be recognized. */
const anyoneNamed = (db: CoreDatabase) =>
  db.statement("SELECT 1 FROM people LIMIT 1").get() !== undefined;

/** Each episode's voice shown as the user (`shownSelf`), from its recognized voices. */
function shownSelves(
  db: CoreDatabase,
  episodeIds: readonly number[],
  recognized: readonly RecognizedVoice[],
): Map<number, SelfSpeaker> {
  const selves = loadSelfSpeakers(db, episodeIds);
  for (const [episodeId, voices] of Map.groupBy(recognized, (voice) => voice.episodeId)) {
    const runId = voices[0]?.runId;
    if (runId === undefined) continue;
    const shown = shownSelf(
      db,
      runId,
      selves.get(episodeId),
      resolveSpeakers(db, runId),
      new Map(voices.map((voice) => [voice.label, voice.match])),
    );
    if (shown === null) selves.delete(episodeId);
    else selves.set(episodeId, shown);
  }
  return selves;
}

/** Whether any of these episodes has an embedded voice. */
const anyEmbedded = (db: CoreDatabase, episodeIds: readonly number[]) =>
  episodeIds.length > 0 &&
  db
    .statement(
      `SELECT 1 FROM speaker_embeddings
       WHERE episode_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .get(JSON.stringify(episodeIds)) !== undefined;

function personRef(person: Person | undefined): PersonRef | null {
  return person === undefined ? null : { id: person.id, name: person.name, self: person.isSelf };
}

/**
 * An episode with its transcript. `self` marks the user's voice: the one the
 * user named as themselves, else the one the sources point to
 * (`loadSelfSpeakers`), on the speaker and on its segments; `person` the
 * name the user gave a voice. Both are derived here at each read.
 */
function matchOf(match: VoiceMatch | null | undefined): ApiVoiceMatch | null {
  if (match === null || match === undefined) return null;
  return {
    person: { id: match.person.id, name: match.person.name, self: match.person.isSelf },
    similarity: Math.max(-1, Math.min(1, match.similarity)),
    confidence: Math.max(0, Math.min(1, match.confidence)),
    references: match.references,
    dictations: match.dictations,
    reads: match.reads,
  };
}

/**
 * Each person's episodes where their voice was recognized and no voice is
 * named as them (ADR 030), newest first.
 */
function recognizedEpisodes(db: CoreDatabase, evidence: VoiceEvidence): Map<number, number[]> {
  const named = new Map<number, Set<number>>();
  for (const run of evidence.runs()) {
    for (const person of run.speakers.values()) {
      named.set(person.id, (named.get(person.id) ?? new Set()).add(run.episodeId));
    }
  }
  const out = new Map<number, number[]>();
  for (const voice of recognizedVoices(db, { runs: evidence.runs(), known: evidence.known() })) {
    const personId = voice.match.person.id;
    if (named.get(personId)?.has(voice.episodeId) === true) continue;
    const list = out.get(personId) ?? [];
    if (!list.includes(voice.episodeId)) list.push(voice.episodeId);
    out.set(personId, list);
  }
  return out;
}

function personSummary(entry: PersonEpisodes, recognized: readonly number[] = []): PersonSummary {
  return {
    person: { id: entry.person.id, name: entry.person.name, self: entry.person.isSelf },
    episodeCount: entry.episodeIds.length,
    lastHeardMs: entry.lastHeardMs,
    recognizedCount: recognized.length,
  };
}

/** « Qui est-ce ? » lists the last 30 days' unnamed voices that spoke 10 s or more. */
const UNNAMED_WINDOW_MS = 30 * 86_400_000;
const UNNAMED_MIN_VOICED_MS = 10_000;
const UNNAMED_LIMIT = 30;
/** « À vérifier » asks about this many names at most; the next come as they are answered. */
const DOUBTS_LIMIT = 10;

const personNotFound = (personId: number) =>
  new ServiceFailure("not-found", `No person ${personId}; they may have been deleted.`);

/** A naming outcome as the API answers it. */
function speakerChange<T, A>(
  change: SpeakerChange<T>,
  episodeId: number,
  toResult: (value: T) => A,
): Effect.Effect<A, ServiceFailure> {
  if (change.ok) return Effect.succeed(toResult(change.value));
  switch (change.reason) {
    case "stale":
      return Effect.fail(
        new ServiceFailure("invalid-input", "This transcript was replaced; read it again."),
      );
    case "not-allowed":
      return Effect.fail(
        new ServiceFailure("invalid-input", "Voices are not identified in this recording."),
      );
    case "not-found":
      return Effect.fail(
        new ServiceFailure("not-found", `No such voice or person in episode ${episodeId}.`),
      );
    case "not-held":
      return Effect.fail(
        new ServiceFailure(
          "invalid-input",
          "This voice would not read as that person; nothing was named.",
        ),
      );
    case "named":
      return Effect.fail(
        new ServiceFailure(
          "invalid-input",
          "Only unnamed voices are merged; name the other voice as the same person instead.",
        ),
      );
  }
}

/** An item as the API gives it (ADR 024): its preview as a `sondine-media:` URL. */
export function contextItemOf(item: ContextItemView): ContextItem {
  return {
    id: item.id,
    kind: item.kind,
    addedAtMs: item.createdAtMs,
    atMs: item.atMs,
    segmentId: item.segmentId,
    pinned: item.span !== null,
    text: item.body,
    title: item.title,
    file:
      item.file === null
        ? null
        : {
            mediaType: item.file.mediaType,
            bytes: item.file.bytes,
            preview:
              item.file.preview === null
                ? null
                : contextMediaUrl({ itemId: item.id, version: item.file.sha256.slice(0, 16) }),
            transcript:
              item.kind === "file" && isTranscribable(item.title ?? "", item.file.mediaType)
                ? { episodeId: item.transcriptEpisodeId }
                : null,
          },
  };
}

export function episodeDetail(
  db: CoreDatabase,
  episodeId: number,
  q?: string,
  nowMs = Date.now(),
): EpisodeDetail | null {
  const detail = getEpisodeDetail(db, episodeId);
  if (detail === null) return null;
  // Highlights only where FTS5 finds the query, like search does.
  const query = q === undefined ? null : compileSearch(db, q);
  const matching = query === null ? new Set<number>() : matchingSegmentIds(db, query, episodeId);
  const people =
    detail.analysis === null
      ? new Map<string, Person>()
      : resolveSpeakers(db, detail.analysis.runId);
  const evidence = voiceEvidence(db);
  const matches =
    detail.analysis === null || !anyoneNamed(db)
      ? new Map<string, VoiceMatch>()
      : voiceMatches(db, detail.analysis.runId, evidence.known());
  const self =
    detail.analysis === null
      ? null
      : (shownSelf(
          db,
          detail.analysis.runId,
          loadSelfSpeakers(db, [episodeId]).get(episodeId),
          people,
          matches,
        )?.label ?? null);
  const [episode] = episodeSummaries(db, [detail.episode], nowMs, evidence);
  if (episode === undefined) return null;
  // Where the page's video was at each sentence (ADR 023).
  const marks = episode.page?.video === true ? loadEpisodeMarks(db, episodeId, nowMs) : [];
  const beside = episodeNeighbours(db, episodeId);
  const rows = loadEpisodeSummaries(
    db,
    [beside.previous, beside.next].filter((id) => id !== null),
  );
  const neighbour = (id: number | null) => {
    const row = id === null ? undefined : rows.get(id);
    return row === undefined
      ? null
      : { id: row.id, startedAtMs: row.startedAtMs, endedAtMs: row.endedAtMs };
  };
  return {
    episode,
    kindOverride: episodeKindOverride(db, episodeId),
    requested: analysisRequested(db, episodeId),
    recognized: namingAllowed(db, episodeId),
    neighbours: { previous: neighbour(beside.previous), next: neighbour(beside.next) },
    tracks: detail.tracks.map((track) => ({
      trackRunId: track.trackRunId,
      trackKey: track.trackKey,
      kind: track.sourceKind,
    })),
    speakers: detail.speakers.map((speaker) => ({
      label: speaker.label,
      ordinal: speaker.ordinal,
      voicedMs: speaker.voicedMs,
      trackKind: speaker.trackKind,
      self: speaker.label === self,
      person: personRef(people.get(speaker.label)),
      recognized: (() => {
        const match = matches.get(speaker.label);
        return match !== undefined && readsAsPerson(match) ? matchOf(match) : null;
      })(),
      suggestion: (() => {
        const match = matches.get(speaker.label);
        return match === undefined || readsAsPerson(match) ? null : matchOf(match);
      })(),
    })),
    segments: detail.segments.map((segment) => ({
      id: segment.id,
      trackRunId: segment.trackRunId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      speakerLabel: segment.speakerLabel,
      self: self !== null && segment.speakerLabel === self,
      text: segment.text,
      lang: segment.lang,
      edited: segment.edited,
      highlights:
        query !== null && matching.has(segment.id)
          ? highlightRanges(segment.text, segment.lang, query)
          : [],
      app: segment.app,
      mediaMs: marks.length === 0 ? null : positionAt(marks, segment.startMs),
    })),
    context: listContextItems(db, episodeId).map(contextItemOf),
    privacy: episodePrivacyView(db, episodeId, nowMs),
    sameMoments: sameMomentsOf(db, episodeId).map((moment) => ({
      episodeId: moment.otherEpisodeId,
      by: moment.by,
      offsetMs: moment.offsetMs,
      driftPpm: moment.driftPpm,
      anchorMs: moment.anchorMs,
      sharedFromMs: moment.sharedFromMs,
      sharedToMs: moment.sharedToMs,
      feedsJournal: moment.feedsJournal,
    })),
    analysis:
      detail.analysis === null
        ? null
        : {
            runId: detail.analysis.runId,
            engineId: detail.analysis.engineId,
            coverage: detail.analysis.coverage,
            publishedAtMs: detail.analysis.publishedAtMs,
          },
  };
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** Local calendar day bounds (the Mac's time zone, daylight saving included). */
export function dayRange(
  day: string | undefined,
  now = new Date(),
): {
  day: string;
  fromMs: number;
  toMs: number;
} {
  const [year, month, date] =
    day === undefined
      ? [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      : day.split("-").map((part) => Number.parseInt(part, 10));
  const y = year ?? now.getFullYear();
  const m = (month ?? 1) - 1;
  const d = date ?? 1;
  return {
    day: `${y}-${pad2(m + 1)}-${pad2(d)}`,
    fromMs: new Date(y, m, d).getTime(),
    toMs: new Date(y, m, d + 1).getTime(),
  };
}

/**
 * The local hours of a day, each as the clock shows it. A daylight saving
 * day has 23 (the skipped hour is left out) or 25 hours of wall time (the
 * repeated hour is one entry of two hours), so `hour` stays unique.
 */
export function localHours(day: string): DayHour[] {
  const { fromMs, toMs } = dayRange(day);
  const [year = 1970, month = 1, date = 1] = day
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const hours: DayHour[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const startMs = Math.max(fromMs, new Date(year, month - 1, date, hour).getTime());
    const endMs = Math.min(toMs, new Date(year, month - 1, date, hour + 1).getTime());
    if (endMs > startMs && new Date(startMs).getHours() === hour)
      hours.push({ hour, startMs, endMs });
  }
  return hours;
}

/** Episodes per lane returned by `episodes.day`; the rest page through `episodes.list`. */
const DAY_PAGE_SIZE = 100;
const IMPORTS_PAGE_SIZE = 50;

export const encodeCursor = (cursor: EpisodeCursor | null): string | null =>
  cursor === null ? null : `${cursor.startedAtMs}:${cursor.id}`;

export function decodeCursor(cursor: string | undefined): EpisodeCursor | undefined {
  if (cursor === undefined) return undefined;
  const [startedAtMs = 0, id = 0] = cursor.split(":").map((part) => Number.parseInt(part, 10));
  return { startedAtMs, id };
}

function toEpisodePage(
  db: CoreDatabase,
  rows: EpisodePageRows,
  evidence: VoiceEvidence = voiceEvidence(db),
): EpisodePage {
  return {
    episodes: episodeSummaries(db, rows.episodes, Date.now(), evidence),
    total: rows.total,
    nextCursor: encodeCursor(rows.next),
  };
}

/** The apps seen listening, then the known dictation apps installed here, as Settings lists them. */
async function dictationAppsOf(db: CoreDatabase): Promise<DictationApps> {
  const installed = await installedApps(KNOWN_DICTATION_APPS.map((app) => app.bundleId));
  return {
    apps: listeningApps(db, installed)
      .slice(0, 200)
      .map((app) => ({
        bundleId: app.bundleId,
        name: (app.name ?? app.bundleId).slice(0, 120),
        via: app.via,
        lastListenedAtMs: app.lastListenedAtMs,
        dictation: app.dictation,
        text: app.text,
      })),
  };
}

const MINUTE_MS = 60_000;

/** Statistics: the days charted, and the window of the other figures (ADR 037). */
const STATISTICS_DAYS = 7;
const STATISTICS_WINDOW_MS = 30 * 86_400_000;

/** The last `count` local days, oldest first, today included, as [start, end) milliseconds. */
function lastDays(nowMs: number, count: number) {
  const today = new Date(nowMs);
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - (count - 1 - index),
    );
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return { day: localDay(start), startMs: start.getTime(), endMs: end.getTime() };
  });
}

/** The local days of a month (`YYYY-MM`), as [start, end) milliseconds; days after today count nothing. */
function monthDays(month: string, nowMs: number) {
  const [year, index] = month.split("-").map(Number);
  if (year === undefined || index === undefined) return [];
  const count = new Date(year, index, 0).getDate();
  return Array.from({ length: count }, (_, offset) => {
    const start = new Date(year, index - 1, offset + 1);
    const end = new Date(year, index - 1, offset + 2);
    // A day to come is empty: [now, now) asks for nothing.
    const until = Math.min(end.getTime(), Math.max(start.getTime(), nowMs));
    return { day: localDay(start), startMs: start.getTime(), endMs: until };
  });
}

const localDay = (at: Date) =>
  `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;

/** « Sondine 2026-11-06 13-05.wav » (or `.md`, `.srt`, `.vtt`, `.json`), on this Mac's clock. */
function exportFileName(startedAtMs: number, extension: "wav" | TranscriptFormat): string {
  const at = new Date(startedAtMs);
  return `Sondine ${localDay(at)} ${pad2(at.getHours())}-${pad2(at.getMinutes())}.${extension}`;
}

/** « Sondine 2026-11-06.md »: a day's transcripts in one file. */
function dayFileName(startedAtMs: number, extension: TranscriptFormat): string {
  return `Sondine ${localDay(new Date(startedAtMs))}.${extension}`;
}
/** How far a forget's confirmed end may sit from now. */
const CLOCK_SLACK_MS = 1_000;
const FORGET_MAX_AGE_MS = 60 * MINUTE_MS;

/** The transcript's segments that overlap `[fromMs, toMs)`; the rest of the episode as is. */
export function excerpt(detail: EpisodeDetail, fromMs: number, toMs: number): EpisodeDetail {
  return {
    ...detail,
    segments: detail.segments.filter((segment) => segment.endMs > fromMs && segment.startMs < toMs),
  };
}

/** What a window edit may change, for ⌘Z (undo.ts). */
const episodeScope = (
  level: UndoScope["level"],
  episodeIds: readonly number[],
  personIds: readonly number[] = [],
): UndoScope => ({ level, episodeIds, personIds });

/** Why a split or a merge was refused, as the API says it. */
function boundaryFailure(reason: BoundaryRefusal, episodeId: number): ServiceFailure {
  switch (reason) {
    case "missing":
      return new ServiceFailure("not-found", `No closed episode ${episodeId}.`);
    case "outside":
      return new ServiceFailure(
        "invalid-input",
        "This cut is not inside the recording, or one side would hold no speech.",
      );
    case "apart":
      return new ServiceFailure("invalid-input", "These recordings are not next to each other.");
    case "kept-whole":
      return new ServiceFailure(
        "invalid-input",
        "A phone recording or an imported file is kept whole.",
      );
  }
}

const contextRefusal = (refusal: ContextRefusal) => ({
  name: refusal.name,
  problem: refusal.problem,
});

/** Files an agent gets as text rather than as they are (ADR 024). */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/octet-stream",
]);

/** A phone's note refused inside its transaction, so its claim rolls back. */
class ContextRefused extends Error {
  override readonly name = "ContextRefused";
}

const notFound = (episodeId: number) =>
  new ServiceFailure("not-found", `No episode ${episodeId}; it may have been deleted.`);

const TAG_NAME_REFUSED = "A tag is 1 to 40 characters, on one line.";

export const apiLayer = Layer.effect(
  Api,
  Effect.gen(function* () {
    const state = yield* CoreState;
    const listening = yield* Listening;
    const spans = yield* Spans;
    const main = yield* MainChannel;
    const access = yield* AgentAccess;
    const config = yield* CoreConfig;
    const helper = yield* HelperClient;
    const db = yield* Database;
    const queue = yield* AnalysisQueue;
    const live = yield* LiveText;
    const capture = yield* Importer;
    const imports = yield* Imports;
    const updates = yield* Updates;
    const actions = yield* GoingOnActions;
    const usage = yield* UsageStatistics;
    const media = yield* EpisodeMedia;
    const models = yield* Models;
    const compute = yield* Compute;
    const onboarding = yield* Onboarding;
    const voiceRead = yield* VoiceRead;
    const backup = yield* Backup;
    const retention = yield* Retention;
    const builder = yield* EpisodeBuilder;
    const exports = yield* Exports;
    const voices = yield* VoicePass;
    const calls = yield* CallContext;
    const browserLink = yield* BrowserLink;
    const phone = yield* PhoneSync;
    const privacy = yield* Privacy;
    const callOffers = yield* CallOffers;
    const store = yield* ContextStore;
    const chat = yield* Chat;
    /** The episodes a person is heard in (ADR 027: a discussion that read them holds the name). */
    /** Where the person's name reaches, and where Sondine only recognized their voice (ADR 030). */
    const episodesOfPerson = (personId: number): number[] => [
      ...new Set([
        ...(listPeople(db).find((entry) => entry.person.id === personId)?.episodeIds ?? []),
        ...recognizedVoices(db)
          .filter((voice) => voice.match.person.id === personId)
          .map((voice) => voice.episodeId),
      ]),
    ];
    const journal = yield* Journal;
    // Captures the runtime's services, the recording tracer included.
    const context = yield* Effect.context<CoreState | Listening | Spans | MainChannel>();
    const run = Effect.runPromiseWith(context);
    const agents = makeAgentServices({ db, access, config, home: homedir() });
    /** Every window reads its recordings, searches and tags again (`Status.changes`, ADR 039). */
    const changed = () =>
      void run(
        state.update((status, updatedAtMs) => ({
          ...status,
          changes: status.changes + 1,
          updatedAtMs,
        })),
      );
    /**
     * A tag put on or taken off a recording (ADR 039), from the window or the
     * phone. Taking one off moves the agents' content generation: an answer
     * read before still carries it. Names are the user's: never logged.
     */
    const setTag = (
      database: CoreDatabase,
      input: { readonly episodeId: number; readonly name: string; readonly on: boolean },
      origin: "app" | "phone",
    ):
      | { readonly ok: true; readonly tags: string[] }
      | { readonly ok: false; readonly failure: ServiceFailure } => {
      const outcome = setEpisodeTag(database, { ...input, origin, nowMs: Date.now() });
      if (!outcome.ok) {
        return {
          ok: false,
          failure:
            outcome.reason === "missing"
              ? notFound(input.episodeId)
              : outcome.reason === "too-many"
                ? new ServiceFailure("invalid-input", "A recording has 20 tags at most.")
                : new ServiceFailure("invalid-input", TAG_NAME_REFUSED),
        };
      }
      if (!input.on) access.contentChanged();
      changed();
      log.info("tags.set", { episodeId: input.episodeId, on: input.on, origin });
      return { ok: true, tags: outcome.tags.map((tag) => tag.name) };
    };
    /**
     * ⌘Z: the edits made in the window this session (undo.ts); a deletion
     * forgets them. A context file a step held may go once the step does.
     */
    const history = new UndoHistory(db, { onRelease: () => void store.collect() });
    store.holdWith(() => history.heldFiles());
    /** The person a naming reaches, when they exist already (the user's row may not yet). */
    const namedBefore = (person: SpeakerNameInput["person"]): number[] => {
      const id =
        person.kind === "existing"
          ? person.personId
          : person.kind === "self"
            ? selfPersonId(db)
            : null;
      return id === null ? [] : [id];
    };
    /** An episode's audio, type or transcript changed: what is now due gets its job. */
    const catchUp = () => {
      const enqueued = enqueueMissingAnalysis(db, Date.now());
      if (enqueued.length > 0) log.info("analysis.enqueued", { episodes: enqueued.length });
      queue.wake();
    };
    /**
     * Episodes were split or merged: agent answers read before must not leave,
     * a part may be due for analysis, the voice pass embeds the new runs.
     */
    const moved = (episodeId: number) => {
      access.contentChanged();
      catchUp();
      voices.wake();
      log.info("episodes.boundaries", { episodeId });
    };
    /** ⌘Z on « Terminer » (ADR 044): what was heard since joins it again, in the same turn. */
    const endOperation = (end: StoredEnd): UndoOperation => {
      const regroup = () => Effect.runSyncWith(context)(builder.pass)?.deleted ?? [];
      return {
        action: "end",
        undo: (nowMs) => {
          const undone = undoEnd(db, end, nowMs);
          if (!undone.ok) return undone;
          const removed = [...(undone.mergedId === null ? [] : [undone.mergedId]), ...regroup()];
          return { ok: true, removed, kept: [endedEpisodeId(db, end) ?? undone.episodeId] };
        },
        redo: (nowMs) => {
          const redone = redoEnd(db, end, nowMs);
          if (!redone.ok) return redone;
          const removed = regroup();
          void run(builder.follow(redone.episodeId));
          const kept = [redone.episodeId, redone.newEpisodeId].filter((id) => id !== null);
          return { ok: true, removed, kept };
        },
      };
    };
    builder.onEnded(changed);
    /**
     * An edit was undone or redone: agent answers read before must not leave,
     * a part may be due for analysis, a transcript published again needs its voices.
     */
    const stepped = (step: HistoryStep): UndoStep => {
      log.info("history.step", {
        outcome: step.outcome,
        action: step.outcome === "nothing" ? null : step.action,
      });
      if (step.outcome === "nothing" || step.outcome === "refused") return step;
      access.contentChanged();
      catchUp();
      voices.wake();
      if (step.action === "end") changed();
      const { action, removed, kept, removedPeople, keptPeople } = step;
      return {
        outcome: step.outcome,
        action,
        removed: [...removed],
        kept: [...kept],
        removedPeople: [...removedPeople],
        keptPeople: [...keptPeople],
      };
    };
    /** A segment's text changed, or the edit was refused. */
    const corrected = (outcome: EditOutcome, segmentId: number) => {
      if (outcome === "ok") {
        access.contentChanged();
        return Effect.succeed({});
      }
      return Effect.fail(
        outcome === "stale"
          ? new ServiceFailure("invalid-input", "This transcript was replaced; read it again.")
          : new ServiceFailure("not-found", `No segment ${segmentId} in this transcript.`),
      );
    };
    /** A change of the Vocabulary list, or why it was refused. */
    const vocabularyChanged = (
      change: VocabularyChange,
    ): Effect.Effect<{ readonly id: number }, ServiceFailure> =>
      typeof change !== "string"
        ? Effect.succeed(change)
        : Effect.fail(
            change === "missing"
              ? new ServiceFailure("not-found", "This word is no longer in the list.")
              : change === "exists"
                ? new ServiceFailure("invalid-input", "This word is already in the list.")
                : new ServiceFailure("invalid-input", "The list is full."),
          );
    /** A voice's name changed: an agent answer read before must not carry the old one. */
    const named = <T extends { readonly ok: boolean }>(change: T): T => {
      if (change.ok) access.contentChanged();
      return change;
    };

    /**
     * The call going on as the API shows it: each person suggested, still
     * there, with their last three conversations before this call (ADR 025).
     */
    const callContextOf = (state: CallState | null): CallContextOutput => {
      const notch = { openOnHover: notchOpensOnHover(db) };
      if (state === null) return { call: null, notch };
      const named = state.dismissed || state.suggestions.length === 0 ? [] : listPeople(db);
      const evidence = voiceEvidence(db);
      const people = state.suggestions.flatMap((suggestion) => {
        const entry = named.find((item) => item.person.id === suggestion.personId);
        if (entry === undefined) return [];
        // Newest first: the call's own episodes (one per 3 h) come first and go.
        const ids = entry.episodeIds.slice(0, 8);
        const rows = loadEpisodeSummaries(db, ids);
        const ordered = ids
          .flatMap((id) => {
            const row = rows.get(id);
            return row === undefined ? [] : [row];
          })
          .filter((row) => row.id !== state.episodeId && row.startedAtMs < state.startedAtMs)
          .slice(0, 3);
        return [
          {
            person: { id: entry.person.id, name: entry.person.name, self: entry.person.isSelf },
            similarity: suggestion.similarity,
            confidence: suggestion.confidence,
            recognizedAtMs: suggestion.recognizedAtMs,
            conversations: episodeSummaries(db, ordered, Date.now(), evidence),
          },
        ];
      });
      return {
        call: {
          callId: state.callId,
          episodeId: state.episodeId,
          people,
          dismissed: state.dismissed,
        },
        notch,
      };
    };

    /** Tells every window something was deleted (`Status.deletions`). */
    const deleted = state.update((status, nowMs) => ({
      ...status,
      deletions: status.deletions + 1,
      updatedAtMs: nowMs,
    }));

    /**
     * The context changed (ADR 024): an agent answer or a pending export read
     * before must not carry a removed or edited item.
     */
    const contextChanged = Effect.gen(function* () {
      access.contentChanged();
      yield* deleted;
    });
    /** A ⌘Z step over context: what it took away must not leave, and its files may go. */
    const contextStep = (step: UndoStep) =>
      Effect.gen(function* () {
        if (step.outcome !== "nothing" && step.action === "context") {
          if (step.outcome !== "refused") yield* contextChanged;
          void store.collect();
        }
        return step;
      });
    const itemOrFail = (itemId: number) => {
      const item = getContextItem(db, itemId);
      return item === null
        ? Effect.fail(
            new ServiceFailure("not-found", `No item ${itemId}; it may have been removed.`),
          )
        : Effect.succeed(item);
    };
    /**
     * Adds what the user gave to an episode, or a sentence of it: the anchor
     * first, then the files copied, then one transaction that checks the
     * anchor still holds (a deletion meanwhile refuses it all).
     */
    const addContext = async (
      target: { readonly episodeId: number; readonly segmentId?: number | undefined },
      sources: Parameters<typeof store.prepare>[0],
      origin: "app" | "tray" | "phone" = "app",
      /**
       * A phone's note: claims its operation in the same durable transaction,
       * before the note is written; false when a retry claimed it first (ADR 008).
       */
      claim?: () => boolean,
    ): Promise<ContextAddResult> => {
      const anchor = planContextAnchor(db, target.episodeId, target.segmentId);
      if (anchor === "missing") throw notFound(target.episodeId);
      if (anchor === "no-sentence") {
        throw new ServiceFailure("not-found", "This sentence is no longer in the transcript.");
      }
      const { items, refused } = await store.prepare(sources);
      if (items.length === 0) return { itemIds: [], refused: refused.map(contextRefusal) };
      const add = () =>
        addContextItems(db, { anchor, items: items.map(newItemOf), origin, nowMs: Date.now() });
      const written = await store
        .commit(items, () =>
          claim === undefined
            ? history.track("context", episodeScope("assertions", [anchor.episodeId]), add)
            : // Not the window's ⌘Z: the phone that sent it drops its operation on this commit.
              durableTransaction(db, (): AddContextResult => {
                if (!claim()) return { ok: true, itemIds: [] };
                const result = add();
                // Refused: the claim is rolled back with it, so a retry can add the note.
                if (!result.ok) throw new ContextRefused();
                return result;
              }),
        )
        .catch((error: unknown): AddContextResult => {
          if (error instanceof ContextRefused) return { ok: false };
          throw error;
        });
      if (!written.ok) {
        throw new ServiceFailure(
          "not-found",
          "This conversation was deleted or changed meanwhile; nothing was added.",
        );
      }
      log.info("context.added", {
        episodeId: anchor.episodeId,
        items: written.itemIds.length,
        refused: refused.length,
        pinned: anchor.span !== null,
        origin,
      });
      return { itemIds: [...written.itemIds], refused: refused.map(contextRefusal) };
    };

    // A pass deleted recordings a private zone keeps nothing of, at their end
    // (ADR 023, ADR 029), or whose time was up: what « Supprimer » owes the
    // rest, in the same turn, then the audio's scrub.
    const onDropped = (dropped: DroppedEpisodes) => {
      history.clear();
      access.contentChanged();
      void store.collect();
      void run(
        Effect.gen(function* () {
          yield* deleted;
          const report = yield* retention.scrub(dropped.chunks);
          log.info("episodes.dropped-scrubbed", {
            episodes: dropped.episodeIds.length,
            zeroed: report.zeroed,
            deferred: report.deferred.length,
          });
          queue.wake();
        }),
      ).catch((error: unknown) =>
        log.warn("episodes.dropped-scrub-failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    };
    builder.onDropped(onDropped);
    privacy.onDropped(onDropped);

    /**
     * « Supprimer » (or a phone's deletion of a recording it made, ADR 008):
     * one transaction erases the rows and text, then the audio bytes go.
     */
    const deleteWhole = (episodeId: number, origin: "app" | "phone") =>
      Effect.gen(function* () {
        const result = deleteEpisode(db, episodeId, { origin });
        if (!result.deleted) return false;
        // ⌘Z keeps no text of it, and its id may come back as another episode.
        history.clear();
        // No agent answer, and no export waiting for its save panel, read
        // before this commit leaves now: before the scrub, which may wait.
        access.contentChanged();
        yield* deleted;
        // Its context's files, and their open copies (ADR 024).
        void store.collect();
        const report = yield* retention.scrub(result.chunks);
        log.info("episodes.deleted", {
          episodeId,
          origin,
          chunks: result.chunks.length,
          segments: result.segmentCount,
          zeroed: report.zeroed,
          deferred: report.deferred.length,
        });
        // Its jobs are cancelled: the scheduler looks again.
        queue.wake();
        return true;
      });
    phone.useApi({
      deleteEpisode: async (episodeId) => {
        await run(deleteWhole(episodeId, "phone"));
      },
      addNote: async (episodeId, text, claim) => {
        const added = await addContext({ episodeId }, { text }, "phone", claim);
        return added.itemIds.length > 0;
      },
      setTag: async (episodeId, tag, claim) =>
        durableTransaction(db, () => {
          if (!claim()) return false;
          // A name the Mac refuses is dropped with its operation: the phone cannot fix it.
          setTag(db, { episodeId, ...tag }, "phone");
          return true;
        }),
      confirmSelf: async (episodeId, { ordinal, sentenceId }, claim) => {
        const done = durableTransaction(db, () => {
          if (!claim()) return false;
          const self = selfPersonId(db);
          const runId = currentSpeakerRun(db, episodeId);
          if (self === null || runId === null) return false;
          const speaker = db
            .statement("SELECT label FROM episode_speakers WHERE run_id = ? AND ordinal = ?")
            .get(runId, ordinal);
          if (speaker === undefined) return false;
          const label = String(speaker["label"]);
          // The sentence the phone read must still be this voice's: a transcript made since leaves it.
          const said = db
            .statement(
              "SELECT 1 AS hit FROM segments WHERE id = ? AND run_id = ? AND speaker_label = ?",
            )
            .get(sentenceId, runId, label);
          if (said === undefined) return false;
          // Named since, on the Mac or by a transcript that changed: left as it is.
          if (resolveSpeakers(db, runId).has(label)) return false;
          return nameSpeaker(db, {
            episodeId,
            runId,
            label,
            person: { kind: "existing", personId: self },
            nowMs: Date.now(),
          }).ok;
        });
        if (done) {
          access.contentChanged();
          changed();
          log.info("phone.self-confirmed", { episodeId });
        }
        return done;
      },
      // Filled below: the phone reads results through the app's own procedures.
      services: () => services,
    });

    const call = <A, E>(
      procedure: string,
      effect: Effect.Effect<A, E>,
      toError?: (error: E) => Error,
    ) => {
      log.info("api.call", { procedure });
      return actions.track(
        run(
          effect.pipe(
            Effect.mapError((error) => (toError === undefined ? error : toError(error))),
            Effect.withSpan(`api.${procedure}`),
          ),
        ),
      );
    };

    const requestPermission = (kind: PermissionKind) =>
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.get(state.status);
        const permissions = status.permissions;
        if (permissions !== null && isGranted(permissions[kind].status)) {
          return { outcome: "already-granted" as const, permissions };
        }
        // The helper is the process macOS credits, so it shows the prompt. When
        // the prompt cannot appear or the user declines it, main opens System
        // Settings at the right pane.
        if (permissions === null || !isBlocked(permissions[kind].status)) {
          const answer = yield* promptThroughHelper(kind);
          if (answer !== null && isGranted(answer[kind].status)) {
            return { outcome: "requested" as const, permissions: answer };
          }
        }
        main.post({
          type: "open-privacy-settings",
          pane: kind === "microphone" ? "microphone" : "system-audio",
        });
        return {
          outcome: "opened-settings" as const,
          permissions: (yield* SubscriptionRef.get(state.status)).permissions,
        };
      });

    /** Sends `request.permissions`; returns the state in the helper's reply, or null. */
    const promptThroughHelper = (kind: PermissionKind) =>
      Effect.gen(function* () {
        // The `permissions` reply arrives before the `ack`, with the request's id.
        const { replies } = yield* helper.request(
          {
            type: "request.permissions",
            scope: kind === "microphone" ? "microphone" : "system-audio",
          },
          { timeoutMs: PROMPT_TIMEOUT_MS },
        );
        const reply = replies.findLast(
          (event): event is PermissionsEvent => event.type === "permissions",
        );
        return reply === undefined
          ? null
          : { microphone: reply.microphone, systemAudio: reply.systemAudio };
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn("permissions.request", { kind, error: error._tag });
            return null;
          }),
        ),
      );

    const services: ApiServices = {
      status: {
        get: () => call("status.get", SubscriptionRef.get(state.status)),
        watch: (signal) => {
          log.info("api.call", { procedure: "status.watch" });
          return Stream.toAsyncIterableWith(
            SubscriptionRef.changes(state.status).pipe(Stream.interruptWhen(untilAborted(signal))),
            context,
          );
        },
      },
      calls: {
        context: () =>
          call("calls.context", SubscriptionRef.get(calls.state).pipe(Effect.map(callContextOf))),
        watch: (signal) => {
          log.info("api.call", { procedure: "calls.watch" });
          return Stream.toAsyncIterableWith(
            SubscriptionRef.changes(calls.state).pipe(
              Stream.map(callContextOf),
              Stream.interruptWhen(untilAborted(signal)),
            ),
            context,
          );
        },
        dismiss: (input) =>
          call(
            "calls.dismiss",
            Effect.sync(() => {
              const state = calls.dismiss(input.callId);
              log.info("calls.dismissed", { done: state?.dismissed === true });
              return callContextOf(state);
            }),
          ),
        notch: () =>
          call(
            "calls.notch",
            Effect.sync(() => ({ openOnHover: notchOpensOnHover(db) })),
          ),
        setNotch: (input) =>
          call(
            "calls.setNotch",
            Effect.sync(() => {
              setNotchOpensOnHover(db, input.openOnHover, Date.now());
              log.info("calls.notch", { openOnHover: input.openOnHover });
              // A call going on shows it the new way at once.
              calls.refresh();
              return { openOnHover: notchOpensOnHover(db) };
            }),
          ),
      },
      listening: {
        pause: (input) =>
          call("listening.pause", listening.pause(input.scope, input.untilMs), pauseFailure),
        resume: (input) => call("listening.resume", listening.resume(input.scope), toFailure),
      },
      callOffers: {
        listen: (input) =>
          call("callOffers.listen", callOffers.listen(input.callId), callOfferFailure),
        skip: (input) => call("callOffers.skip", callOffers.skip(input.callId), callOfferFailure),
        decline: (input) =>
          call("callOffers.decline", callOffers.decline(input.callId, input.forApp)),
        settings: () => call("callOffers.settings", callOffers.settings),
        setEnabled: (input) => call("callOffers.setEnabled", callOffers.setEnabled(input.enabled)),
        allowApp: (input) => call("callOffers.allowApp", callOffers.allowApp(input.bundleId)),
      },
      permissions: {
        request: (input) => call("permissions.request", requestPermission(input.kind)),
      },
      episodes: {
        day: (input) =>
          call(
            "episodes.day",
            Effect.sync(() => {
              const range = dayRange(input.day);
              const rows = loadEpisodeDay(db, {
                fromMs: range.fromMs,
                toMs: range.toMs,
                hours: localHours(range.day),
                pageSize: DAY_PAGE_SIZE,
                nowMs: Date.now(),
              });
              // One read of the names for every lane (ADR 030).
              const evidence = voiceEvidence(db);
              return {
                day: range.day,
                revision: rows.revision,
                conversations: toEpisodePage(db, rows.conversations, evidence),
                momentHours: rows.momentHours.map((hour) => ({
                  hour: hour.hour,
                  startMs: hour.startMs,
                  moments: hour.moments,
                  untranscribed: hour.untranscribed,
                  previews: hour.previews.map((preview) => ({
                    episodeId: preview.episodeId,
                    firstWords: firstWords(preview.text) ?? "",
                  })),
                  apps: [...hour.apps],
                })),
                media: toEpisodePage(db, rows.media, evidence),
                dictations: toEpisodePage(db, rows.dictations, evidence),
                traces: rows.traces,
                ongoing: episodeSummaries(db, rows.ongoing, Date.now(), evidence),
              };
            }),
          ),
        list: (input) =>
          call(
            "episodes.list",
            Effect.sync(() => {
              const range = dayRange(input.day);
              const hour =
                input.hour === undefined
                  ? undefined
                  : localHours(range.day).find((entry) => entry.hour === input.hour);
              const after = decodeCursor(input.cursor);
              const page = listEpisodes(db, {
                // A skipped hour (daylight saving) is empty.
                fromMs: hour?.startMs ?? range.fromMs,
                toMs: input.hour === undefined ? range.toMs : (hour?.endMs ?? range.fromMs),
                limit: input.limit,
                ...(input.lane === undefined ? {} : { lane: input.lane }),
                ...(after === undefined ? {} : { after }),
              });
              return {
                day: range.day,
                episodes: episodeSummaries(db, page.episodes),
                nextCursor: encodeCursor(page.next),
              };
            }),
          ),
        get: (input) =>
          call(
            "episodes.get",
            Effect.suspend(() => {
              const detail = episodeDetail(db, input.episodeId, input.q);
              if (detail === null) return Effect.fail(notFound(input.episodeId));
              return Effect.succeed(
                input.fromMs === undefined || input.toMs === undefined
                  ? detail
                  : excerpt(detail, input.fromMs, input.toMs),
              );
            }),
          ),
        playback: (input) =>
          call(
            "episodes.playback",
            Effect.suspend(() => {
              const plan = media.playback(input.episodeId);
              if (plan === null) return Effect.fail(notFound(input.episodeId));
              return Effect.succeed({
                src: episodeMediaUrl({ episodeId: input.episodeId, generation: plan.generation }),
                ...plan,
                speech: [...plan.speech],
              });
            }),
          ),
        exportAudio: (input) =>
          call(
            "episodes.exportAudio",
            Effect.gen(function* () {
              const plan = media.playback(input.episodeId);
              if (plan === null) return yield* Effect.fail(notFound(input.episodeId));
              if (plan.startedAtMs === null) return { outcome: "empty" as const };
              const outcome = yield* Effect.promise(() =>
                exports.audio({
                  episodeId: input.episodeId,
                  generation: plan.generation,
                  fileName: exportFileName(plan.startedAtMs ?? 0, "wav"),
                }),
              );
              log.info("episodes.exported", { episodeId: input.episodeId, outcome });
              return { outcome };
            }),
          ),
        openPage: (input) =>
          call(
            "episodes.openPage",
            Effect.gen(function* () {
              const nowMs = Date.now();
              const [episode] = episodeSummaries(
                db,
                [...loadEpisodeSummaries(db, [input.episodeId]).values()],
                nowMs,
              );
              if (episode === undefined) return yield* Effect.fail(notFound(input.episodeId));
              if (episode.page === null) return { opened: false };
              const page = webPageOf(episode.page.url);
              let positionMs: number | null = null;
              if (input.segmentId !== undefined) {
                const segment = getEpisodeDetail(db, input.episodeId)?.segments.find(
                  (candidate) => candidate.id === input.segmentId,
                );
                if (segment === undefined) {
                  return yield* Effect.fail(
                    new ServiceFailure(
                      "not-found",
                      `No segment ${input.segmentId} in this episode.`,
                    ),
                  );
                }
                if (episode.page.video) {
                  positionMs = positionAt(
                    loadEpisodeMarks(db, input.episodeId, nowMs),
                    segment.startMs,
                  );
                }
              }
              const url =
                page === null ? episode.page.url : pageLinkAt(page, episode.page.url, positionMs);
              main.post({ type: "open-page", url });
              log.info("episodes.page-opened", {
                episodeId: input.episodeId,
                at: positionMs !== null,
              });
              return { opened: true };
            }),
          ),
        exportText: (input) =>
          call(
            "episodes.exportText",
            Effect.gen(function* () {
              const ids = [...new Set(input.episodeIds)];
              const exist = () => loadEpisodeSummaries(db, ids);
              const found = exist();
              const missing = ids.find((id) => !found.has(id));
              if (missing !== undefined) return yield* Effect.fail(notFound(missing));
              const first = Math.min(...[...found.values()].map((row) => row.startedAtMs));
              // Deleted text must not leave, even from a window that still shows
              // it: the text stands only while nothing was deleted since the
              // window read it and every episode is still there, checked now and
              // again right before main writes.
              const unchanged = SubscriptionRef.get(state.status).pipe(
                Effect.map(
                  (status) =>
                    status.deletions === input.deletionsSeen && exist().size === ids.length,
                ),
              );
              if (!(yield* unchanged)) return { outcome: "stale" as const };
              const outcome = yield* Effect.promise(() =>
                exports.text({
                  destination: input.destination,
                  fileName:
                    ids.length === 1
                      ? exportFileName(first, input.format)
                      : dayFileName(first, input.format),
                  text: input.text,
                  stillCurrent: () => run(unchanged),
                }),
              );
              log.info("episodes.text-exported", {
                episodes: ids.length,
                format: input.format,
                outcome,
              });
              return { outcome };
            }),
          ),
        end: (input) =>
          call(
            "episodes.end",
            Effect.gen(function* () {
              const result = yield* builder.end(input.episodeId);
              switch (result.outcome) {
                case "missing":
                  return yield* Effect.fail(notFound(input.episodeId));
                case "failed":
                  return yield* Effect.die(
                    new Error(`Episode ${input.episodeId} could not be ended.`),
                  );
                case "over":
                  return { ended: false };
                case "ended":
                  history.record(endOperation(result.end));
                  changed();
                  yield* callOffers.refresh;
                  return { ended: true };
              }
            }),
          ),
        split: (input) =>
          call(
            "episodes.split",
            Effect.suspend(() => {
              const outcome = history.track(
                "split",
                episodeScope("structure", [input.episodeId]),
                () => splitEpisode(db, { ...input, nowMs: Date.now() }),
                (result) => ({ episodeIds: result.ok ? [result.value.newEpisodeId] : [] }),
              );
              if (!outcome.ok) return Effect.fail(boundaryFailure(outcome.reason, input.episodeId));
              moved(outcome.value.episodeId);
              return Effect.succeed(outcome.value);
            }),
          ),
        keepAudio: (input) =>
          call("episodes.keepAudio", privacy.keepAudio(input.episodeId, input.keep)),
        setKind: (input) =>
          call(
            "episodes.setKind",
            Effect.suspend(() => {
              const set = history.track("kind", episodeScope("kind", [input.episodeId]), () =>
                setEpisodeKind(db, { ...input, nowMs: Date.now() }),
              );
              if (!set) {
                return Effect.fail(boundaryFailure("missing", input.episodeId));
              }
              log.info("episodes.kind-set", { episodeId: input.episodeId, kind: input.kind });
              // Now a conversation, it may need its transcript.
              catchUp();
              return Effect.succeed({});
            }),
          ),
        setJournalSource: (input) =>
          call(
            "episodes.setJournalSource",
            Effect.suspend(() => {
              if (!setSameMomentSource(db, input)) return Effect.fail(notFound(input.episodeId));
              log.info("episodes.journal-source-set", {
                episodeId: input.episodeId,
                otherEpisodeId: input.otherEpisodeId,
              });
              // Its journal is written again: the other's lines over the shared time go.
              catchUp();
              return Effect.succeed({});
            }),
          ),
        merge: (input) =>
          call(
            "episodes.merge",
            Effect.suspend(() => {
              const outcome = history.track(
                "merge",
                episodeScope("structure", [input.episodeId, input.otherId]),
                () => mergeEpisodes(db, { ...input, nowMs: Date.now() }),
              );
              if (!outcome.ok) return Effect.fail(boundaryFailure(outcome.reason, input.episodeId));
              moved(outcome.value.episodeId);
              return Effect.succeed(outcome.value);
            }),
          ),
        delete: (input) =>
          call(
            "episodes.delete",
            Effect.map(deleteWhole(input.episodeId, "app"), (done) => ({ deleted: done })),
          ),
        setRecognition: (input) =>
          call(
            "episodes.setRecognition",
            Effect.gen(function* () {
              if (!setEpisodeRecognition(db, { ...input, nowMs: Date.now() })) {
                return yield* Effect.fail(notFound(input.episodeId));
              }
              // Names stop or start being read: answers read before must not leave.
              access.contentChanged();
              log.info("episodes.recognition", {
                episodeId: input.episodeId,
                allowed: input.allowed,
              });
              if (input.allowed) voices.wake();
              // Off takes names away like a deletion: a pending export and
              // every window read again.
              else yield* deleted;
              return {};
            }),
          ),
        deletePassage: (input) =>
          call(
            "episodes.deletePassage",
            Effect.gen(function* () {
              // One transaction erases the text and marks the audio; the bytes go right after.
              const result = deletePassage(db, { ...input, origin: "app", nowMs: Date.now() });
              if (!result.deleted) {
                return yield* Effect.fail(
                  result.reason === "missing"
                    ? notFound(input.episodeId)
                    : new ServiceFailure(
                        "invalid-input",
                        "This passage is not inside the recording.",
                      ),
                );
              }
              history.clear();
              access.contentChanged();
              yield* deleted;
              void store.collect();
              const report = yield* retention.scrub(result.chunks);
              log.info("episodes.passage-deleted", {
                episodeId: input.episodeId,
                whole: result.episodeDeleted,
                chunks: result.chunks.length,
                segments: result.segmentCount,
                zeroed: report.zeroed,
                deferred: report.deferred.length,
              });
              // The rest was published again: its voices are embedded anew.
              catchUp();
              voices.wake();
              return { episodeDeleted: result.episodeDeleted };
            }),
          ),
        forgetPreview: (input) =>
          call(
            "episodes.forgetPreview",
            Effect.sync(() => {
              const toMs = builder.now();
              const fromMs = toMs - input.minutes * MINUTE_MS;
              return {
                fromMs,
                toMs,
                episodes: episodesInRange(db, fromMs, toMs),
                phoneRecordings: phoneRecordingsInRange(db, fromMs, toMs),
              };
            }),
          ),
        forget: (input) =>
          call(
            "episodes.forget",
            Effect.gen(function* () {
              const nowMs = builder.now();
              // The range the user confirmed, not one that moved on while the dialog was open.
              const toWallMs = input.untilMs;
              if (toWallMs > nowMs + CLOCK_SLACK_MS || toWallMs < nowMs - FORGET_MAX_AGE_MS) {
                return yield* Effect.fail(
                  new ServiceFailure("invalid-input", "This erase is out of date; ask again."),
                );
              }
              const result = forgetRange(db, {
                fromWallMs: toWallMs - input.minutes * MINUTE_MS,
                toWallMs,
                origin: "app",
                nowMs,
              });
              history.clear();
              access.contentChanged();
              yield* deleted;
              void store.collect();
              const report = yield* retention.scrub(result.chunks);
              log.info("episodes.forgotten", {
                minutes: input.minutes,
                episodes: result.episodeIds.length,
                chunks: result.chunks.length,
                zeroed: report.zeroed,
                deferred: report.deferred.length,
              });
              queue.wake();
              return { episodeIds: [...result.episodeIds] };
            }),
          ),
        keepRecent: () =>
          call(
            "episodes.keepRecent",
            Effect.gen(function* () {
              const nowMs = builder.now();
              const result = keepRecentAudio(db, {
                fromWallMs: nowMs - KEEP_RECENT_MS,
                toWallMs: nowMs,
                nowMs,
              });
              log.info("episodes.recent-kept", {
                outcome: result.outcome,
                ...(result.outcome === "kept"
                  ? { keptMs: result.keptMs, episodes: result.episodeIds.length }
                  : {}),
              });
              // Every window reads its recordings again (`Status.kept`).
              if (result.outcome === "kept") {
                yield* state.update((status, updatedAtMs) => ({
                  ...status,
                  kept: status.kept + 1,
                  updatedAtMs,
                }));
              }
              return result.outcome === "kept"
                ? {
                    outcome: "kept" as const,
                    atMs: nowMs,
                    keptMs: result.keptMs,
                    episodeIds: [...result.episodeIds],
                  }
                : { outcome: "nothing" as const };
            }),
          ),
      },
      search: {
        query: (input) =>
          call(
            "search.query",
            Effect.sync(() => {
              // A tag by its name (ADR 039); one no tag has matches nothing.
              const tag = input.tag === undefined ? null : findTag(db, input.tag);
              if (input.tag !== undefined && tag === null) {
                return { episodes: [], total: 0, untranscribed: 0 };
              }
              const options = {
                limit: input.limit,
                offset: input.offset,
                ...(input.from === undefined ? {} : { fromMs: dayRange(input.from).fromMs }),
                ...(input.to === undefined ? {} : { toMs: dayRange(input.to).toMs }),
                ...(input.sizes === undefined ? {} : { sizes: input.sizes }),
                ...(input.contexts === undefined ? {} : { contexts: input.contexts }),
                ...(input.foregroundApp === undefined
                  ? {}
                  : { foregroundApp: input.foregroundApp }),
                ...(tag === null ? {} : { tagId: tag.id }),
              };
              const result =
                input.text === undefined
                  ? browseTag(db, { ...options, tagId: tag?.id ?? 0 })
                  : searchEpisodes(db, input.text, options);
              const ids = result.episodes.map((match) => match.episode.id);
              const evidence = voiceEvidence(db);
              // Recognized voices of the hits' transcripts, by episode and label (ADR 030).
              const recognizedHere = anyoneNamed(db)
                ? recognizedVoices(db, {
                    episodeIds: ids,
                    runs: evidence.runs(),
                    known: evidence.known(),
                  })
                : [];
              const recognized = new Map(
                recognizedHere.map((voice) => [
                  `${voice.episodeId}\n${voice.label}`,
                  voice.match.person,
                ]),
              );
              // One resolution per episode's current transcript, which the hits come from.
              const named = new Map<number, Map<string, Person>>();
              const namedIn = (episodeId: number) => {
                let people = named.get(episodeId);
                if (people === undefined) {
                  const runId = currentSpeakerRun(db, episodeId);
                  people = runId === null ? new Map() : resolveSpeakers(db, runId);
                  named.set(episodeId, people);
                }
                return people;
              };
              const personOfHit = (episodeId: number, speakerLabel: string | null) =>
                speakerLabel === null ? null : personRef(namedIn(episodeId).get(speakerLabel));
              const selves = shownSelves(db, ids, recognizedHere);
              const summaries = episodeSummaries(
                db,
                result.episodes.map((match) => match.episode),
                Date.now(),
                evidence,
              );
              return {
                episodes: result.episodes.map((match, index) => ({
                  episode: summaries[index] ?? toEpisodeSummary(match.episode),
                  selfOrdinal: selves.get(match.episode.id)?.ordinal ?? null,
                  hitCount: match.hitCount,
                  hits: match.hits.map((hit) => ({
                    segmentId: hit.segmentId,
                    startMs: hit.startMs,
                    endMs: hit.endMs,
                    text: hit.text,
                    speakerLabel: hit.speakerLabel,
                    speakerOrdinal: hit.speakerOrdinal,
                    self:
                      hit.speakerLabel !== null &&
                      selves.get(match.episode.id)?.label === hit.speakerLabel,
                    person: personOfHit(match.episode.id, hit.speakerLabel),
                    recognized:
                      hit.speakerLabel === null
                        ? null
                        : personRef(recognized.get(`${match.episode.id}\n${hit.speakerLabel}`)),
                    highlights: [...hit.highlights],
                    app: hit.app,
                  })),
                  contextHits: match.contextHits.map((hit) => ({
                    itemId: hit.itemId,
                    kind: hit.kind,
                    text: hit.text,
                    highlights: [...hit.highlights],
                  })),
                })),
                total: result.total,
                untranscribed: result.untranscribed,
              };
            }),
          ),
        foregroundApps: () =>
          call(
            "search.foregroundApps",
            Effect.sync(() => ({ apps: listForegroundApps(db) })),
          ),
      },
      people: {
        list: () =>
          call(
            "people.list",
            Effect.sync(() => {
              const evidence = voiceEvidence(db);
              const recognized = recognizedEpisodes(db, evidence);
              return {
                people: listPeople(db, evidence.runs()).map((entry) =>
                  personSummary(entry, recognized.get(entry.person.id)),
                ),
              };
            }),
          ),
        get: (input) =>
          call(
            "people.get",
            Effect.suspend(() => {
              const evidence = voiceEvidence(db);
              const entry = listPeople(db, evidence.runs()).find(
                (item) => item.person.id === input.personId,
              );
              if (entry === undefined) return Effect.fail(personNotFound(input.personId));
              const recognized = recognizedEpisodes(db, evidence).get(input.personId) ?? [];
              const rows = loadEpisodeSummaries(db, [...entry.episodeIds, ...recognized]);
              // Named and recognized together, newest first.
              const ordered = [...rows.values()]
                .toSorted((a, b) => b.startedAtMs - a.startedAtMs || b.id - a.id)
                .slice(0, input.limit);
              return Effect.succeed({
                summary: personSummary(entry, recognized),
                episodes: episodeSummaries(db, ordered, Date.now(), evidence),
              });
            }),
          ),
        rename: (input) =>
          call(
            "people.rename",
            Effect.suspend(() => {
              const renamed = history.track(
                "name",
                episodeScope("assertions", [], [input.personId]),
                () => renamePerson(db, { ...input, nowMs: Date.now() }),
              );
              if (renamed) {
                access.contentChanged();
                calls.refresh();
              }
              const person = renamed ? personRef(getPerson(db, input.personId) ?? undefined) : null;
              return person === null
                ? Effect.fail(personNotFound(input.personId))
                : Effect.succeed(person);
            }),
          ),
        merge: (input) =>
          call(
            "people.merge",
            Effect.suspend(() => {
              // The name merged away is in these; discussions that read them go (ADR 027).
              const episodeIds = episodesOfPerson(input.otherId);
              const merged = history.track(
                "people-merge",
                episodeScope("people", [], [input.personId, input.otherId]),
                () => mergePeople(db, { ...input, nowMs: Date.now() }),
              );
              log.info("people.merged", { ok: merged.ok });
              if (merged.ok) {
                // An agent answer read before must not carry the name that went.
                access.contentChanged();
                calls.refresh();
                chat.peopleRemoved(episodeIds);
                return Effect.succeed({
                  id: merged.value.id,
                  name: merged.value.name,
                  self: merged.value.isSelf,
                });
              }
              return Effect.fail(
                merged.reason === "same"
                  ? new ServiceFailure(
                      "invalid-input",
                      "A person cannot be merged with themselves.",
                    )
                  : personNotFound(input.otherId),
              );
            }),
          ),
        delete: (input) =>
          call(
            "people.delete",
            Effect.sync(() => {
              // Read before the person goes: discussions that read these hold the name.
              const episodeIds = episodesOfPerson(input.personId);
              const removed = deletePerson(db, input.personId);
              if (removed) {
                backup.noteRemoval();
                history.clear();
                access.contentChanged();
                calls.refresh();
                chat.peopleRemoved(episodeIds);
              }
              log.info("people.deleted", { personId: input.personId, removed });
              return { deleted: removed };
            }),
          ),
        unnamed: () =>
          call(
            "people.unnamed",
            Effect.sync(() => {
              const voices = unnamedVoices(db, {
                sinceMs: Date.now() - UNNAMED_WINDOW_MS,
                minVoicedMs: UNNAMED_MIN_VOICED_MS,
                limit: UNNAMED_LIMIT,
              });
              const ids = [...new Set(voices.map((voice) => voice.episodeId))];
              const rows = loadEpisodeSummaries(db, ids);
              const evidence = voiceEvidence(db);
              const summaries = new Map(
                episodeSummaries(db, [...rows.values()], Date.now(), evidence).map((summary) => [
                  summary.id,
                  summary,
                ]),
              );
              // Numbered as the episode numbers them: a voice recognized as the user counts.
              const selves = shownSelves(
                db,
                ids,
                recognizedVoices(db, {
                  episodeIds: ids,
                  runs: evidence.runs(),
                  known: evidence.known(),
                }),
              );
              return {
                voices: voices.flatMap((voice) => {
                  const episode = summaries.get(voice.episodeId);
                  if (episode === undefined) return [];
                  const self = selves.get(voice.episodeId);
                  return [
                    {
                      episode,
                      runId: voice.runId,
                      label: voice.label,
                      ordinal: voice.ordinal,
                      voicedMs: voice.voicedMs,
                      self: self?.label === voice.label,
                      selfOrdinal: self?.ordinal ?? null,
                      recognized:
                        voice.match !== null && readsAsPerson(voice.match)
                          ? matchOf(voice.match)
                          : null,
                      suggestion:
                        voice.match === null || readsAsPerson(voice.match)
                          ? null
                          : matchOf(voice.match),
                    },
                  ];
                }),
              };
            }),
          ),
        doubts: () =>
          call(
            "people.doubts",
            Effect.sync(() => {
              const evidence = voiceEvidence(db);
              const doubts = doubtedNames(db, {
                limit: DOUBTS_LIMIT,
                runs: evidence.runs(),
                known: evidence.known(),
              });
              const rows = loadEpisodeSummaries(db, [
                ...new Set(doubts.map((voice) => voice.episodeId)),
              ]);
              const summaries = new Map(
                episodeSummaries(db, [...rows.values()], Date.now(), evidence).map((summary) => [
                  summary.id,
                  summary,
                ]),
              );
              return {
                voices: doubts.flatMap((voice) => {
                  const episode = summaries.get(voice.episodeId);
                  const person = personRef(voice.person);
                  const match = matchOf(voice.match);
                  if (episode === undefined || person === null || match === null) return [];
                  return [
                    {
                      episode,
                      runId: voice.runId,
                      label: voice.label,
                      voicedMs: voice.voicedMs,
                      startMs: voice.startMs,
                      person,
                      confidence:
                        voice.confidence === null
                          ? null
                          : Math.max(0, Math.min(1, voice.confidence)),
                      match,
                    },
                  ];
                }),
              };
            }),
          ),
        recognition: () =>
          call(
            "people.recognition",
            Effect.sync(() => ({ on: recognitionEnabled(db) })),
          ),
        setRecognition: (input) =>
          call(
            "people.setRecognition",
            Effect.gen(function* () {
              // A voice read under way keeps nothing (ADR 034).
              if (!input.on) voiceRead.abandon();
              // A voice read under way keeps nothing (ADR 034).
              if (!input.on) voiceRead.abandon();
              setRecognition(db, { on: input.on, nowMs: Date.now() });
              log.info("people.recognition", { on: input.on });
              if (input.on) voices.wake();
              else {
                // Names stop being read: no answer or pending export that
                // carries them leaves, and every window reads again.
                access.contentChanged();
                yield* deleted;
              }
              return { on: recognitionEnabled(db) };
            }),
          ),
        dictationLearning: () =>
          call(
            "people.dictationLearning",
            Effect.sync(() => ({ on: learnsFromDictations(db) })),
          ),
        setDictationLearning: (input) =>
          call(
            "people.setDictationLearning",
            Effect.gen(function* () {
              setLearnFromDictations(db, { on: input.on, nowMs: Date.now() });
              log.info("people.dictation-learning", { on: input.on });
              if (input.on) voices.wake();
              else {
                // Recognitions resting on the dictations go: no answer read before
                // leaves, and a call's matching drops what it read of them.
                access.contentChanged();
                yield* deleted;
              }
              return { on: learnsFromDictations(db) };
            }),
          ),
      },
      speakers: {
        name: (input) =>
          call(
            "speakers.name",
            Effect.suspend(() =>
              speakerChange(
                named(
                  history.track(
                    "name",
                    episodeScope("assertions", [input.episodeId], namedBefore(input.person)),
                    () => nameSpeaker(db, { ...input, nowMs: Date.now() }),
                    (change) => ({ personIds: change.ok ? [change.value.id] : [] }),
                  ),
                ),
                input.episodeId,
                (person) => ({ person: { id: person.id, name: person.name, self: person.isSelf } }),
              ),
            ),
          ),
        refuse: (input) =>
          call(
            "speakers.refuse",
            Effect.suspend(() => {
              const outcome = history.track(
                "refusal",
                episodeScope("assertions", [input.episodeId]),
                () => refuseSuggestion(db, { ...input, nowMs: Date.now() }),
              );
              return outcome === "ok"
                ? Effect.succeed({})
                : speakerChange({ ok: false, reason: outcome }, input.episodeId, () => ({}));
            }),
          ),
        unname: (input) =>
          call(
            "speakers.unname",
            Effect.suspend(() =>
              speakerChange(
                named(
                  history.track("name", episodeScope("assertions", [input.episodeId]), () =>
                    unnameSpeaker(db, { ...input, nowMs: Date.now() }),
                  ),
                ),
                input.episodeId,
                () => ({}),
              ),
            ),
          ),
        likeness: (input) =>
          call(
            "speakers.likeness",
            Effect.sync(() => ({
              people: (anyoneNamed(db) ? voiceLikeness(db, input) : []).map((entry) => ({
                person: {
                  id: entry.person.id,
                  name: entry.person.name,
                  self: entry.person.isSelf,
                },
                confidence: Math.max(0, Math.min(1, entry.confidence)),
                references: entry.references,
                dictations: entry.dictations,
                reads: entry.reads,
              })),
            })),
          ),
        merge: (input) =>
          call(
            "speakers.merge",
            Effect.suspend(() => {
              // The structure level keeps the transcript as it was: ⌘Z gives each voice its sentences back.
              const merged = history.track(
                "voice-merge",
                episodeScope("structure", [input.episodeId]),
                () =>
                  mergeVoice(db, {
                    episodeId: input.episodeId,
                    runId: input.runId,
                    label: input.label,
                    other: input.other,
                    nowMs: Date.now(),
                  }),
              );
              log.info("voices.merged", { episodeId: input.episodeId, ok: merged.ok });
              // The joined voice is embedded again from all its speech.
              if (merged.ok) voices.wake();
              return speakerChange(merged, input.episodeId, (value) => ({ label: value.label }));
            }),
          ),
      },
      analysis: {
        request: (input) =>
          call(
            "analysis.request",
            Effect.gen(function* () {
              // Just ended (ADR 044): it closes within seconds, then it can be asked for.
              if (endOfEpisode(db, input.episodeId) !== null) {
                yield* builder.settled(input.episodeId);
              }
              const result = queue.request(input.episodeId);
              return yield* result === null
                ? Effect.fail(notFound(input.episodeId))
                : Effect.succeed(result);
            }),
          ),
        check: () =>
          call(
            "analysis.check",
            Effect.promise(() => queue.check()),
          ),
        setWaitFor: (input) =>
          call(
            "analysis.setWaitFor",
            Effect.promise(() => {
              queue.setWaitFor(input.condition, input.wait);
              return queue.check();
            }),
          ),
      },
      compute: {
        get: () => Promise.resolve(compute.status()),
        choose: (input) =>
          call(
            "compute.choose",
            Effect.suspend(() =>
              compute.choose(input.destination)
                ? Effect.succeed(compute.status())
                : Effect.fail(
                    new ServiceFailure("invalid-input", "This destination is not set up."),
                  ),
            ),
          ),
        connect: (input) =>
          call(
            "compute.connect",
            Effect.promise(async () => ({
              outcome: await compute.connect(input.link),
              status: compute.status(),
            })),
          ),
        disconnect: () =>
          call(
            "compute.disconnect",
            Effect.sync(() => {
              compute.disconnect();
              return compute.status();
            }),
          ),
        joinBeta: (input) =>
          call(
            "compute.joinBeta",
            Effect.promise(async () => ({
              outcome: await compute.joinBeta(input.link),
              status: compute.status(),
            })),
          ),
        leaveBeta: () =>
          call(
            "compute.leaveBeta",
            Effect.promise(async () => {
              await compute.leaveBeta();
              return compute.status();
            }),
          ),
        quota: () =>
          call(
            "compute.quota",
            Effect.promise(() => compute.quota()),
          ),
        wave: () =>
          call(
            "compute.wave",
            Effect.promise(() => compute.wave()),
          ),
        openBilling: (input) =>
          call(
            "compute.openBilling",
            Effect.promise(async () => {
              const page = await compute.billing(input);
              if ("outcome" in page) return page;
              // Only Stripe's own pages (checked in billingPage), in the browser, never the window.
              main.post({ type: "open-page", url: page.url });
              return { outcome: "opened" as const };
            }),
          ),
      },
      live: {
        setEnabled: (input) =>
          call(
            "live.setEnabled",
            Effect.sync(() => live.setEnabled(input.enabled)),
          ),
        // Asked every second while a conversation is on screen: not logged per call.
        partial: (input) => Promise.resolve(live.partial(input.episodeId)),
      },
      imports: {
        pick: () =>
          call(
            "imports.pick",
            Effect.promise(() => imports.pick()),
          ),
        add: (input) =>
          call(
            "imports.add",
            Effect.promise(async () => ({ results: await imports.add(input.paths) })),
          ),
        list: (input) =>
          call(
            "imports.list",
            Effect.sync(() => {
              const [importedAtMs = 0, episodeId = 0] = (input.cursor ?? "")
                .split(":")
                .map((part) => Number.parseInt(part, 10));
              const page = listImports(db, {
                limit: IMPORTS_PAGE_SIZE,
                ...(input.cursor === undefined ? {} : { after: { importedAtMs, episodeId } }),
              });
              const rows = loadEpisodeSummaries(
                db,
                page.imports.map((item) => item.episodeId),
              );
              const summaries = new Map(
                episodeSummaries(db, [...rows.values()]).map((summary) => [summary.id, summary]),
              );
              return {
                imports: page.imports.flatMap((item) => {
                  const episode = summaries.get(item.episodeId);
                  return episode === undefined
                    ? []
                    : [{ episode, fileName: item.fileName, importedAtMs: item.importedAtMs }];
                }),
                nextCursor:
                  page.next === null ? null : `${page.next.importedAtMs}:${page.next.episodeId}`,
              };
            }),
          ),
      },
      context: {
        add: (input) =>
          call(
            "context.add",
            Effect.promise(() =>
              addContext(input, {
                ...(input.text === undefined ? {} : { text: input.text }),
                ...(input.paths === undefined ? {} : { paths: input.paths }),
              }),
            ),
          ),
        paste: (input) =>
          call(
            "context.paste",
            Effect.promise(() => addContext(input, { clipboard: true })),
          ),
        pick: (input) =>
          call(
            "context.pick",
            Effect.promise(() => addContext(input, { pick: true })),
          ),
        edit: (input) =>
          call(
            "context.edit",
            Effect.gen(function* () {
              const item = yield* itemOrFail(input.itemId);
              const edited = history.track(
                "context",
                episodeScope("assertions", [item.episodeId]),
                () =>
                  editContextItem(db, {
                    itemId: input.itemId,
                    edit:
                      input.kind === "note"
                        ? { kind: "note", text: input.text }
                        : {
                            kind: "link",
                            url: input.url,
                            title: input.title === null || input.title === "" ? null : input.title,
                          },
                    nowMs: Date.now(),
                  }),
              );
              if (!edited) {
                return yield* Effect.fail(
                  new ServiceFailure("invalid-input", "This item is not a note or a link."),
                );
              }
              yield* contextChanged;
              return {};
            }),
          ),
        unpin: (input) =>
          call(
            "context.unpin",
            Effect.gen(function* () {
              const item = yield* itemOrFail(input.itemId);
              history.track("context", episodeScope("assertions", [item.episodeId]), () =>
                unpinContextItem(db, { itemId: input.itemId, nowMs: Date.now() }),
              );
              yield* contextChanged;
              return {};
            }),
          ),
        remove: (input) =>
          call(
            "context.remove",
            Effect.gen(function* () {
              const item = yield* itemOrFail(input.itemId);
              history.track("context", episodeScope("assertions", [item.episodeId]), () =>
                removeContextItem(db, input.itemId),
              );
              backup.noteRemoval();
              yield* contextChanged;
              // Its file stays while ⌘Z can bring it back; its open copies go now.
              void store.collect();
              log.info("context.removed", { episodeId: item.episodeId, kind: item.kind });
              return {};
            }),
          ),
        open: (input) =>
          call(
            "context.open",
            Effect.gen(function* () {
              const item = yield* itemOrFail(input.itemId);
              if (item.kind === "note") return { opened: false };
              if (item.kind === "link") {
                if (!/^https?:\/\//iu.test(item.body)) return { opened: false };
                main.post({ type: "open-page", url: item.body });
                log.info("context.opened", { kind: item.kind });
                return { opened: true };
              }
              const path = yield* Effect.tryPromise({
                try: () => store.openCopy(item),
                catch: () => new ServiceFailure("not-found", "This file is no longer kept."),
              });
              main.post({ type: "open-file", path });
              log.info("context.opened", { kind: item.kind });
              return { opened: true };
            }),
          ),
        transcribe: (input) =>
          call(
            "context.transcribe",
            Effect.gen(function* () {
              const item = yield* itemOrFail(input.itemId);
              const file = item.file;
              if (
                item.kind !== "file" ||
                file === null ||
                !isTranscribable(item.title ?? "", file.mediaType)
              ) {
                return yield* Effect.fail(
                  new ServiceFailure("invalid-input", "Only an audio file can be transcribed."),
                );
              }
              if (item.transcriptEpisodeId !== null) {
                return { outcome: "imported" as const, episodeId: item.transcriptEpisodeId };
              }
              const result = yield* Effect.promise(() =>
                imports.transcribe({
                  name: safeFileName(item.title ?? "audio"),
                  copyTo: (path) => store.copyFile(item, path),
                  // In the import's transaction: removed or transcribed meanwhile, nothing stays.
                  link: (trackRunId) => {
                    const refusal = linkContextTranscript(db, {
                      itemId: item.id,
                      sha256: file.sha256,
                      trackRunId,
                    });
                    if (refusal !== null) throw new Error(`not linked: ${refusal}`);
                  },
                }),
              );
              log.info("context.transcribed", {
                itemId: item.id,
                outcome: result.outcome,
                ...(result.outcome === "failed" ? { problem: result.problem } : {}),
              });
              return result;
            }),
          ),
        pasteOngoing: () =>
          call(
            "context.pasteOngoing",
            Effect.promise(async () => {
              const episodeId = ongoingEpisode(db, Date.now());
              if (episodeId === null) return { outcome: "none" as const };
              const added = await addContext({ episodeId }, { clipboard: true }, "tray");
              return { outcome: "added" as const, episodeId, ...added };
            }),
          ),
        get: (input) =>
          call(
            "context.get",
            Effect.gen(function* () {
              const item = yield* itemOrFail(input.itemId);
              const preview =
                item.kind === "image"
                  ? yield* Effect.promise(() => store.previewBytes(item))
                  : null;
              const audiovisual =
                item.file !== null &&
                (isTranscribable(item.title ?? "", item.file.mediaType) ||
                  item.file.mediaType.startsWith("video/"));
              // Text as text (a type unknown to Sondine too, when it reads as UTF-8).
              const textual =
                item.file !== null &&
                (item.file.mediaType.startsWith("text/") || TEXT_TYPES.has(item.file.mediaType));
              const content =
                item.kind === "file" && textual && !audiovisual
                  ? yield* Effect.promise(() => store.textOf(item))
                  : null;
              // A document goes as it is (a PDF, an office file): agents read them.
              const bytes =
                item.kind === "file" &&
                item.file !== null &&
                AGENT_DOCUMENT_TYPES.has(item.file.mediaType)
                  ? yield* Effect.promise(() => store.fileBytes(item, AGENT_FILE_BYTES))
                  : null;
              return {
                episodeId: item.episodeId,
                item: contextItemOf(item),
                content,
                file:
                  bytes === null || item.file === null
                    ? null
                    : {
                        mediaType: item.file.mediaType,
                        data: Buffer.from(bytes).toString("base64"),
                      },
                image:
                  preview === null || item.file?.preview == null
                    ? null
                    : {
                        mediaType:
                          item.file.preview === "jpeg"
                            ? ("image/jpeg" as const)
                            : ("image/png" as const),
                        data: Buffer.from(preview).toString("base64"),
                      },
              };
            }),
          ),
      },
      journal: makeJournalServices({
        db,
        work: journal.work,
        claudeStatus: () => journal.claudeStatus(),
        dayRange: (day) => dayRange(day),
        wake: () => queue.wake(),
        contentChanged: () => access.contentChanged(),
      }),
      player: {
        // Renewed every few seconds while something plays: not logged per call.
        state: (input) => {
          const nowMs = Date.now();
          if (!input.playing) {
            noteStopped(db, nowMs);
            return Promise.resolve({ route: null });
          }
          const route = capture.importer.outputRoute();
          notePlaying(db, { route, nowMs });
          return Promise.resolve({ route });
        },
      },
      phone: {
        status: () =>
          call(
            "phone.status",
            Effect.sync(() => phone.status()),
          ),
        setEnabled: (input) =>
          call(
            "phone.setEnabled",
            Effect.promise(() => phone.setEnabled(input.enabled)),
          ),
        setTailnet: (input) =>
          call(
            "phone.setTailnet",
            Effect.promise(() => phone.setTailnet(input.enabled)),
          ),
        pair: () =>
          call(
            "phone.pair",
            Effect.tryPromise({ try: () => phone.pair(), catch: (error) => error }),
          ),
        answer: (input) =>
          call(
            "phone.answer",
            Effect.promise(() => phone.answer(input.accept)),
          ),
        revoke: (input) =>
          call(
            "phone.revoke",
            Effect.tryPromise({ try: () => phone.revoke(input.deviceId), catch: (error) => error }),
          ),
        reset: () =>
          call(
            "phone.reset",
            Effect.promise(() => phone.reset()),
          ),
      },
      browser: {
        status: () =>
          call(
            "browser.status",
            Effect.sync(() => browserLink.status()),
          ),
        setEnabled: (input) =>
          call(
            "browser.setEnabled",
            Effect.promise(() => browserLink.setEnabled(input.enabled)),
          ),
        showExtension: () =>
          call(
            "browser.showExtension",
            Effect.sync(() => ({ shown: browserLink.showExtension() })),
          ),
      },
      privacy: {
        status: () =>
          call(
            "privacy.status",
            Effect.sync(() => privacy.status()),
          ),
        addZone: (input) => call("privacy.addZone", privacy.addZone(input)),
        updateZone: (input) => call("privacy.updateZone", privacy.updateZone(input)),
        removeZone: (input) => call("privacy.removeZone", privacy.removeZone(input.id)),
        setMediaSite: (input) =>
          call("privacy.setMediaSite", privacy.setMediaSite(input.site, input.kept)),
        setDuration: (input) => call("privacy.setDuration", privacy.setDuration(input)),
        lift: (input) => call("privacy.lift", privacy.lift(input.occurrenceId)),
      },
      dictation: {
        apps: () =>
          call(
            "dictation.apps",
            Effect.promise(() => dictationAppsOf(db)),
          ),
        setApp: (input) =>
          call(
            "dictation.setApp",
            Effect.promise(() => {
              setDictationApp(db, input.bundleId, input.dictation, Date.now(), input.name);
              return dictationAppsOf(db);
            }),
          ),
        setText: (input) =>
          call(
            "dictation.setText",
            Effect.promise(() => {
              setDictationText(db, input.bundleId, input.on, Date.now());
              if (input.on) queue.takePastDictations();
              return dictationAppsOf(db);
            }),
          ),
      },
      updates: {
        setAutomatic: (input) =>
          call(
            "updates.setAutomatic",
            Effect.sync(() => updates.setAutomatic(input.automatic)),
          ),
        check: () =>
          call(
            "updates.check",
            Effect.promise(() => updates.check()),
          ),
        install: () =>
          call(
            "updates.install",
            Effect.sync(() => updates.install()),
          ),
        closeNote: () =>
          call(
            "updates.closeNote",
            Effect.sync(() => updates.closeNote()),
          ),
      },
      models: {
        status: () =>
          call(
            "models.status",
            Effect.promise(() => models.refresh()),
          ),
        watch: (signal) => {
          log.info("api.call", { procedure: "models.watch" });
          // Found files and kept downloads may have changed since the last look.
          void models.refresh().catch(() => undefined);
          return Stream.toAsyncIterableWith(
            SubscriptionRef.changes(models.status).pipe(Stream.interruptWhen(untilAborted(signal))),
            context,
          );
        },
        import: (input) => {
          log.info("api.call", { procedure: "models.import" });
          return modelCall(() => models.import(input.artifactId, input.path));
        },
        pick: (input) => {
          log.info("api.call", { procedure: "models.pick" });
          return modelCall(() => models.pick(input.artifactId));
        },
        download: (input) => {
          log.info("api.call", { procedure: "models.download" });
          return modelCall(() => models.download(input.artifactId));
        },
        cancel: (input) => {
          log.info("api.call", { procedure: "models.cancel" });
          return modelCall(() => models.cancel(input.artifactId, input.discard));
        },
      },
      backup: {
        status: () =>
          call(
            "backup.status",
            Effect.sync(() => backup.status()),
          ),
        watch: (signal) => {
          log.info("api.call", { procedure: "backup.watch" });
          return Stream.toAsyncIterableWith(
            backup.changes.pipe(Stream.interruptWhen(untilAborted(signal))),
            context,
          );
        },
        // Neither the passphrase nor a path is logged.
        export: (input) =>
          call(
            "backup.export",
            Effect.promise(() => backup.export(input)),
          ),
        choose: () =>
          call(
            "backup.choose",
            Effect.promise(() => backup.choose()),
          ),
        inspect: (input) =>
          call(
            "backup.inspect",
            Effect.promise(() => backup.inspect(input.passphrase)),
          ),
        restore: (input) =>
          call(
            "backup.restore",
            Effect.promise(() => backup.restore(input.passphrase)),
          ),
        cancel: () =>
          call(
            "backup.cancel",
            Effect.sync(() => {
              backup.cancel();
              return {};
            }),
          ),
        deletePrevious: () =>
          call(
            "backup.deletePrevious",
            Effect.sync(() => backup.deletePrevious()),
          ),
        closeNote: () =>
          call(
            "backup.closeNote",
            Effect.sync(() => backup.closeNote()),
          ),
      },
      voiceRead: {
        get: () =>
          call(
            "voiceRead.get",
            Effect.sync(() => voiceRead.get()),
          ),
        watch: (signal) => {
          log.info("api.call", { procedure: "voiceRead.watch" });
          return Stream.toAsyncIterableWith(
            voiceRead.changes.pipe(Stream.interruptWhen(untilAborted(signal))),
            context,
          );
        },
        start: (input) => call("voiceRead.start", voiceRead.start(input.selfName)),
        finish: () => call("voiceRead.finish", voiceRead.finish),
        cancel: () => call("voiceRead.cancel", voiceRead.cancel),
        forget: () =>
          call(
            "voiceRead.forget",
            Effect.andThen(
              Effect.sync(() => backup.noteRemoval()),
              voiceRead.forget,
            ),
          ),
      },
      onboarding: {
        get: () =>
          call(
            "onboarding.get",
            Effect.sync(() => onboarding.get()),
          ),
        advance: (input) =>
          call(
            "onboarding.advance",
            Effect.sync(() => onboarding.advance(input)),
          ),
        complete: (input) =>
          call("onboarding.complete", onboarding.complete(input.startListening), toFailure),
      },
      display: {
        get: () =>
          call(
            "display.get",
            Effect.sync(() => readDisplaySettings(db)),
          ),
        update: (input) =>
          call(
            "display.update",
            Effect.sync(() => updateDisplaySettings(db, input, Date.now())),
          ),
      },
      vocabulary: {
        list: () =>
          call(
            "vocabulary.list",
            Effect.sync(() => {
              const { words, people } = listVocabulary(db);
              return {
                words: [...words],
                people: [...people],
                modelReads: journal.work.readsVocabulary(),
              };
            }),
          ),
        add: (input) =>
          call(
            "vocabulary.add",
            Effect.suspend(() => {
              const note = input.note ?? null;
              return vocabularyChanged(
                addVocabularyWord(db, { word: input.word, note, nowMs: Date.now() }),
              ).pipe(
                Effect.map(({ id }) => ({ id, word: input.word, note: note === "" ? null : note })),
              );
            }),
          ),
        update: (input) =>
          call(
            "vocabulary.update",
            Effect.suspend(() => {
              const note = input.note ?? null;
              return vocabularyChanged(
                updateVocabularyWord(db, { ...input, note, nowMs: Date.now() }),
              ).pipe(
                Effect.map(({ id }) => ({ id, word: input.word, note: note === "" ? null : note })),
              );
            }),
          ),
        remove: (input) =>
          call(
            "vocabulary.remove",
            Effect.suspend(() =>
              removeVocabularyWord(db, input.id)
                ? Effect.sync(() => {
                    backup.noteRemoval();
                    return {};
                  })
                : Effect.fail(new ServiceFailure("not-found", `No word ${input.id} in the list.`)),
            ),
          ),
      },
      tags: {
        list: () =>
          call(
            "tags.list",
            Effect.sync(() => ({
              tags: listTags(db).map((tag) => ({
                id: tag.id,
                name: tag.name,
                recordings: tag.recordings,
                usedAtMs: tag.usedAtMs,
              })),
            })),
          ),
        set: (input) =>
          call(
            "tags.set",
            Effect.suspend(() => {
              const outcome = setTag(db, input, "app");
              if (!outcome.ok) return Effect.fail(outcome.failure);
              return Effect.succeed({ tags: outcome.tags });
            }),
          ),
        rename: (input) =>
          call(
            "tags.rename",
            Effect.suspend(() => {
              const outcome = renameTag(db, { ...input, nowMs: Date.now() });
              if (!outcome.ok) {
                return Effect.fail(
                  outcome.reason === "missing"
                    ? new ServiceFailure(
                        "not-found",
                        `No tag ${input.tagId}; it may have been deleted.`,
                      )
                    : new ServiceFailure("invalid-input", TAG_NAME_REFUSED),
                );
              }
              // An agent's answer read before carries the old name.
              access.contentChanged();
              changed();
              log.info("tags.renamed", { tagId: input.tagId, merged: outcome.merged });
              return Effect.succeed({ tag: outcome.tag, merged: outcome.merged });
            }),
          ),
        delete: (input) =>
          call(
            "tags.delete",
            Effect.suspend(() => {
              const recordings = deleteTag(db, input.tagId);
              if (recordings === null) {
                return Effect.fail(
                  new ServiceFailure(
                    "not-found",
                    `No tag ${input.tagId}; it may have been deleted.`,
                  ),
                );
              }
              backup.noteRemoval();
              access.contentChanged();
              changed();
              log.info("tags.deleted", { tagId: input.tagId, recordings });
              return Effect.succeed({ recordings });
            }),
          ),
      },
      transcript: {
        edit: (input) =>
          call(
            "transcript.edit",
            Effect.suspend(() => {
              const original = segmentHeard(db, input.segmentId);
              const edited: Effect.Effect<unknown, ServiceFailure> = corrected(
                history.track("text", episodeScope("text", [input.episodeId]), () =>
                  editSegment(db, { ...input, nowMs: Date.now() }),
                ),
                input.segmentId,
              );
              // What the Vocabulary learned, read with the correction counted (ADR 046).
              return edited.pipe(
                Effect.map(() => {
                  if (original === null) return { learned: [], unheard: [] };
                  const { learned, unheard } = correctionLessons({
                    original,
                    text: input.text,
                    vocabulary: vocabularyOf(db),
                  });
                  return { learned: [...learned], unheard: [...unheard] };
                }),
              );
            }),
          ),
        restore: (input) =>
          call(
            "transcript.restore",
            Effect.suspend(() =>
              corrected(
                history.track("text", episodeScope("text", [input.episodeId]), () =>
                  restoreSegment(db, { ...input, nowMs: Date.now() }),
                ),
                input.segmentId,
              ),
            ),
          ),
      },
      history: {
        undo: () =>
          call(
            "history.undo",
            Effect.suspend(() => contextStep(stepped(history.undo(Date.now())))),
          ),
        redo: () =>
          call(
            "history.redo",
            Effect.suspend(() => contextStep(stepped(history.redo(Date.now())))),
          ),
      },
      chat: {
        status: (input) =>
          call(
            "chat.status",
            Effect.promise(() => chat.status(input)),
          ),
        setEnabled: (input) =>
          call(
            "chat.setEnabled",
            Effect.promise(() => chat.setEnabled(input.enabled)),
          ),
        watch: (input, signal) => chat.watch(input.discussionId, signal),
        send: (input) =>
          call(
            "chat.send",
            Effect.tryPromise({ try: () => chat.send(input), catch: (error) => error }),
          ),
        stop: (input) =>
          call(
            "chat.stop",
            Effect.tryPromise({
              try: () => chat.stop(input.discussionId),
              catch: (error) => error,
            }),
          ),
        remove: (input) =>
          call(
            "chat.remove",
            Effect.tryPromise({
              try: () => {
                // Counted before: an export that read it stops either way.
                backup.noteRemoval();
                return chat.remove(input.discussionId);
              },
              catch: (error) => error,
            }),
          ),
        setLimited: (input) =>
          call(
            "chat.setLimited",
            Effect.try({
              try: () => {
                chat.setLimited(input.discussionId, input.limited);
                return {};
              },
              catch: (error) => error,
            }),
          ),
      },
      agents: {
        status: () => call("agents.status", Effect.sync(agents.status)),
        setEnabled: (input) =>
          call(
            "agents.setEnabled",
            Effect.sync(() => agents.setEnabled(input.enabled)),
          ),
        create: (input) =>
          call(
            "agents.create",
            Effect.sync(() => agents.create(input.name)),
          ),
        connectApp: (input) =>
          call(
            "agents.connectApp",
            Effect.try({
              try: () => agents.connectApp(input.app),
              catch: (error) => error,
            }),
          ),
        revoke: (input) =>
          call(
            "agents.revoke",
            Effect.try({
              try: () => agents.revoke(input.agentId),
              catch: (error) => error,
            }),
          ),
        remove: (input) =>
          call(
            "agents.remove",
            Effect.try({
              try: () => {
                backup.noteRemoval();
                return agents.remove(input.agentId);
              },
              catch: (error) => error,
            }),
          ),
      },
      statistics: {
        get: () =>
          call(
            "statistics.get",
            Effect.sync(() => {
              const nowMs = Date.now();
              return loadStatistics(db, {
                days: lastDays(nowMs, STATISTICS_DAYS),
                sinceMs: nowMs - STATISTICS_WINDOW_MS,
                untilMs: nowMs,
                agentsSinceMs: lastDays(nowMs, STATISTICS_DAYS)[0]?.startMs ?? nowMs,
              });
            }),
          ),
        month: (input) =>
          call(
            "statistics.month",
            Effect.sync(() => ({
              month: input.month,
              days: loadDayTotals(db, monthDays(input.month, Date.now())),
            })),
          ),
      },
      // Not traced: a span would keep what the statistics may not (ADR 042).
      usage: {
        get: async () => usage.status(),
        setSharing: async ({ share }) => usage.setSharing(share),
        processCrashed: async ({ process }) => {
          usage.error(process === "core" ? "core_crashed" : "renderer_crashed");
          return {};
        },
      },
      diagnostics: {
        report: () =>
          call(
            "diagnostics.report",
            Effect.gen(function* () {
              const status = yield* SubscriptionRef.get(state.status);
              const artifacts = yield* Effect.promise(() => models.refresh());
              return {
                text: diagnosticText({
                  status,
                  models: artifacts,
                  queue: jobCounts(db),
                  failures: failuresSince(db, Date.now() - DIAGNOSTIC_DAYS * 86_400_000),
                  appVersion: config.appVersion,
                  macosVersion: config.macosVersion,
                  processor: cpus()[0]?.model ?? "",
                }),
              };
            }),
          ),
        health: (input) =>
          call(
            "diagnostics.health",
            Effect.map(Ref.get(state.health), (windows) => ({
              windows: windows.slice(0, input.limit),
            })),
          ),
        spans: (input) =>
          call(
            "diagnostics.spans",
            Effect.sync(() => spans.recent(input)),
          ),
      },
    };
    return Api.of(services);
  }),
);
