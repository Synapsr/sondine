import { transaction, type Database } from "./database";
import {
  currentSpeakerRun,
  ensureSelf,
  forgetDictationVoices,
  identityRulesAllow,
  namedRuns,
  namingAllowed,
  recognitionEnabled,
  resolveSpeakers,
  selfPersonId,
  type NamedRun,
  type Person,
  type SpeakerChange,
} from "./people";
import { loadRunSpeakers, type SelfSpeaker } from "./episode-sources";
import { int, str, type Row } from "./rows";
import { voicedSegments } from "./voice-speech";

// Recognising voices (architecture §8, ADR 030). Each voice of a transcript
// gets an embedding from its exclusive speech; a person's reference voices
// are the embeddings of the voices the user named as them (one per
// conversation, so a phone call and a room both count), and an unnamed voice
// is compared with the centroid of each person's references: the more voices
// named, the closer that centroid is to the person. Under 80 %, nothing;
// then « Marie ? » to confirm; from 99 %, « Marie* », the person's name marked
// until the user confirms or corrects it. Recognition is derived from the
// evidence at each read and never stored; recognized voices never become
// references. Confirming names a voice; « Non » writes a `speaker_is_not` over
// its speech so that person is not offered again. Before that, the voices of
// one transcript that are one person are linked (`mergeVoices`), in every
// context: within the transcript only. The user's voice read (ADR 034), a
// text they read aloud on purpose, is one more of their references.

/** Trimmed off each end of a stretch of exclusive speech (turn edges blur). */
const EDGE_MS = 250;
/** Shorter stretches are left out. */
const MIN_PIECE_MS = 1_000;
/** At most this much speech per voice is sent (the tool reads 30 s). */
const MAX_SPEECH_MS = 30_000;

/** One stretch of one voice's exclusive speech, in samples of a track run. */
export interface SpeechPiece {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

/** The rate sondine-voice reads; a track at another rate is not embedded. */
const VOICE_RATE = 16_000;

/**
 * Each voice's exclusive speech in a run: its segments without the time any
 * other voice speaks, on any track (in a call the far side also leaks into
 * the microphone), each stretch then trimmed at both ends (a cut is a
 * boundary too), in stretches of at least 1 s, the longest first, cut to
 * 30 s in all. Segments whose words the alignment spread far apart are left
 * out, and tracks not at 16 kHz.
 */
export function exclusiveSpeech(db: Database, runId: number): Map<string, SpeechPiece[]> {
  const spoken = voicedSegments(db, runId).filter((segment) => segment.sampleRate === VOICE_RATE);
  const pieces = new Map<string, { piece: SpeechPiece; ms: number }[]>();
  for (const segment of spoken) {
    let parts: [number, number][] = [[segment.startMs, segment.endMs]];
    for (const other of spoken) {
      if (
        other.label === segment.label ||
        other.endMs <= segment.startMs ||
        other.startMs >= segment.endMs
      )
        continue;
      parts = parts.flatMap(([a, b]): [number, number][] => {
        if (other.endMs <= a || other.startMs >= b) return [[a, b]];
        return [
          ...(other.startMs > a ? [[a, other.startMs] as [number, number]] : []),
          ...(other.endMs < b ? [[other.endMs, b] as [number, number]] : []),
        ];
      });
    }
    const spanMs = segment.endMs - segment.startMs;
    const samples = segment.sampleEnd - segment.sampleStart;
    const toSample = (ms: number) =>
      segment.sampleStart + Math.round(((ms - segment.startMs) * samples) / Math.max(1, spanMs));
    const kept = parts
      .map(([a, b]) => [a + EDGE_MS, b - EDGE_MS] as const)
      .filter(([a, b]) => b - a >= MIN_PIECE_MS)
      .map(([a, b]) => ({
        piece: { trackRunId: segment.trackRunId, sampleStart: toSample(a), sampleEnd: toSample(b) },
        ms: b - a,
      }));
    if (kept.length > 0) pieces.set(segment.label, [...(pieces.get(segment.label) ?? []), ...kept]);
  }
  const out = new Map<string, SpeechPiece[]>();
  for (const [label, list] of pieces) {
    let budgetMs = MAX_SPEECH_MS;
    const taken: SpeechPiece[] = [];
    for (const { piece, ms } of list.toSorted((a, b) => b.ms - a.ms)) {
      if (budgetMs < MIN_PIECE_MS) break;
      const keepMs = Math.min(ms, budgetMs);
      const sampleEnd =
        piece.sampleStart + Math.round(((piece.sampleEnd - piece.sampleStart) * keepMs) / ms);
      taken.push({ ...piece, sampleEnd });
      budgetMs -= keepMs;
    }
    out.set(label, taken);
  }
  return out;
}

/** A voice of a transcript to link, with what tells it apart. */
export interface VoiceOfRun {
  readonly label: string;
  /** The track it was heard on. */
  readonly trackKey: string;
  /** Whom the user named it as, if anyone. */
  readonly personId: number | null;
  readonly pieces: readonly SpeechPiece[];
}

/** A run's voices with their exclusive speech, in the order they first speak. */
export function voicesOfRun(db: Database, runId: number): VoiceOfRun[] {
  const speech = exclusiveSpeech(db, runId);
  const named = resolveSpeakers(db, runId);
  const trackKey = db.statement("SELECT track_key FROM track_runs WHERE id = ?");
  return db
    .statement("SELECT label FROM episode_speakers WHERE run_id = ? ORDER BY ordinal")
    .all(runId)
    .flatMap((row) => {
      const label = str(row, "label");
      const pieces = speech.get(label) ?? [];
      const track = pieces[0] === undefined ? undefined : trackKey.get(pieces[0].trackRunId);
      if (track === undefined) return [];
      return [
        {
          label,
          trackKey: str(track, "track_key"),
          personId: named.get(label)?.id ?? null,
          pieces,
        },
      ];
    });
}

/**
 * Current transcripts with two voices or more whose voices were not linked
 * yet, newest first, in every context: voices are linked within one
 * transcript and never compared with anyone's.
 */
export function runsNeedingLinks(db: Database, limit: number): VoiceRun[] {
  return db
    .statement(
      `SELECT e.id AS episode_id, ea.run_id FROM episode_analysis ea
       JOIN episodes e ON e.id = ea.episode_id
       WHERE ea.stage = 'asr'
         AND (SELECT count(*) FROM episode_speakers s WHERE s.run_id = ea.run_id) >= 2
         AND NOT EXISTS (SELECT 1 FROM voice_links l WHERE l.run_id = ea.run_id)
       ORDER BY e.started_at_ms DESC, e.id DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({ episodeId: int(row, "episode_id"), runId: int(row, "run_id") }));
}

/**
 * Merges each voice into the one `links` gives it (a label to itself stays),
 * in the run's segments, turns and voices, numbered again in the order they
 * first speak, and marks the run linked. Voices whose names differ now (the
 * user named one while the links were computed) stay apart. A run that
 * merged anything loses its embeddings, so the voice pass embeds its voices
 * again. False (nothing changed) when the run is no longer its episode's
 * transcript.
 */
export function mergeVoices(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly runId: number;
    readonly links: ReadonlyMap<string, string>;
    readonly nowMs: number;
  },
): boolean {
  return transaction(db, () => {
    if (currentSpeakerRun(db, input.episodeId) !== input.runId) return false;
    const speakers = new Map(
      db
        .statement("SELECT id, label, voiced_ms FROM episode_speakers WHERE run_id = ?")
        .all(input.runId)
        .map((row) => [str(row, "label"), { id: int(row, "id"), voicedMs: int(row, "voiced_ms") }]),
    );
    const named = resolveSpeakers(db, input.runId);
    const nameOf = (label: string) => named.get(label)?.id ?? null;
    let merged = 0;
    for (const [from, to] of input.links) {
      const source = speakers.get(from);
      const target = speakers.get(to);
      if (from === to || source === undefined || target === undefined) continue;
      if (nameOf(from) !== nameOf(to)) continue;
      joinVoice(db, input.runId, { label: from, ...source }, { label: to, ...target });
      merged += 1;
    }
    if (merged > 0) {
      renumberVoices(db, input.runId);
      db.statement("DELETE FROM speaker_embeddings WHERE run_id = ?").run(input.runId);
      db.statement("DELETE FROM voice_passes WHERE run_id = ?").run(input.runId);
    }
    db.statement(
      "INSERT OR REPLACE INTO voice_links (run_id, merged, finished_at_ms) VALUES (?, ?, ?)",
    ).run(input.runId, merged, input.nowMs);
    return true;
  });
}

/** A run's voices numbered again 1, 2, 3… in their order, as publishing numbers them. */
function renumberVoices(db: Database, runId: number): void {
  const order = db
    .statement("SELECT id FROM episode_speakers WHERE run_id = ? ORDER BY ordinal")
    .all(runId)
    .map((row) => int(row, "id"));
  // Ordinals are unique per run: out of the way first, then 1, 2, 3…
  db.statement("UPDATE episode_speakers SET ordinal = -ordinal WHERE run_id = ?").run(runId);
  const renumber = db.statement("UPDATE episode_speakers SET ordinal = ? WHERE id = ?");
  order.forEach((id, index) => renumber.run(index + 1, id));
}

/**
 * A run's voices as they stand (labels and speaking times): a voice pass reads
 * it before embedding and stores nothing if it changed meanwhile (a merge).
 */
export function voicesPrint(db: Database, runId: number): string {
  return db
    .statement("SELECT label, voiced_ms FROM episode_speakers WHERE run_id = ? ORDER BY ordinal")
    .all(runId)
    .map((row) => `${str(row, "label")}=${int(row, "voiced_ms")}`)
    .join("\n");
}

/** One voice of a run takes another's sentences, turns and speaking time; the other goes. */
function joinVoice(
  db: Database,
  runId: number,
  source: { readonly label: string; readonly id: number; readonly voicedMs: number },
  target: { readonly label: string; readonly id: number },
): void {
  for (const table of ["segments", "speaker_turns"]) {
    db.statement(
      `UPDATE ${table} SET speaker_label = ?, episode_speaker_id = ?
       WHERE run_id = ? AND speaker_label = ?`,
    ).run(target.label, target.id, runId, source.label);
  }
  db.statement("UPDATE episode_speakers SET voiced_ms = voiced_ms + ? WHERE id = ?").run(
    source.voicedMs,
    target.id,
  );
  db.statement("DELETE FROM episode_speakers WHERE id = ?").run(source.id);
}

const voiceRow = (label: string, row: Row) => ({
  label,
  id: int(row, "id"),
  ordinal: int(row, "ordinal"),
  voicedMs: int(row, "voiced_ms"),
});

/**
 * « Fusionner avec… » (ADR 038): the user says two unnamed voices of one
 * transcript are one person. The voice that speaks later joins the one that
 * speaks first, which keeps its label; the voices are numbered again, as
 * linking and publishing number them, so ⌘Z and ⇧⌘Z come back to the same
 * numbers. Both embeddings go and the run is embedded again, so the joined
 * voice is matched from all its speech; the others keep theirs meanwhile.
 * Nothing else is learned: no voice becomes anyone's reference until it is
 * named (ADR 030). A named voice is refused (`named`): naming the other as
 * the same person shows them as one already.
 */
export function mergeVoice(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly runId: number;
    readonly label: string;
    readonly other: string;
    readonly nowMs: number;
  },
): SpeakerChange<{ readonly label: string }> {
  return transaction(db, (): SpeakerChange<{ readonly label: string }> => {
    const runId = currentSpeakerRun(db, input.episodeId);
    if (runId === null) return { ok: false, reason: "not-found" };
    if (runId !== input.runId) return { ok: false, reason: "stale" };
    if (!namingAllowed(db, input.episodeId)) return { ok: false, reason: "not-allowed" };
    const speaker = db.statement(
      "SELECT id, ordinal, voiced_ms FROM episode_speakers WHERE run_id = ? AND label = ?",
    );
    const one = speaker.get(runId, input.label);
    const two = speaker.get(runId, input.other);
    if (one === undefined || two === undefined || input.label === input.other) {
      return { ok: false, reason: "not-found" };
    }
    const named = resolveSpeakers(db, runId);
    if (named.has(input.label) || named.has(input.other)) return { ok: false, reason: "named" };
    const [target, source] = [voiceRow(input.label, one), voiceRow(input.other, two)].toSorted(
      (a, b) => a.ordinal - b.ordinal,
    );
    if (target === undefined || source === undefined) return { ok: false, reason: "not-found" };
    joinVoice(db, runId, source, target);
    renumberVoices(db, runId);
    db.statement("DELETE FROM speaker_embeddings WHERE run_id = ? AND label IN (?, ?)").run(
      runId,
      source.label,
      target.label,
    );
    db.statement("DELETE FROM voice_passes WHERE run_id = ?").run(runId);
    return { ok: true, value: { label: target.label } };
  });
}

export interface VoiceRun {
  readonly episodeId: number;
  readonly runId: number;
}

/**
 * Current transcripts whose voices were not embedded with this embedder yet,
 * newest first: calls, in-person and mixed episodes that may be identified,
 * and the user's dictations while they teach the user's voice (ADR 030),
 * started at or after `sinceMs`.
 */
export function runsNeedingVoices(
  db: Database,
  input: { readonly embedderVersion: string; readonly sinceMs: number; readonly limit: number },
): VoiceRun[] {
  const page = db.statement(
    `SELECT e.id AS episode_id, ea.run_id FROM episode_analysis ea
     JOIN episodes e ON e.id = ea.episode_id
     WHERE ea.stage = 'asr'
       AND (e.context IN ('call', 'in_person', 'mixed') OR (? AND e.context = 'dictation'))
       AND (e.started_at_ms >= ? OR EXISTS (
         -- A named voice is its person's voice whatever its age (ADR 012):
         -- embedded again after recognition comes back on.
         SELECT 1 FROM user_assertions a
         JOIN speech_regions r ON r.track_run_id = a.track_run_id
         JOIN episode_regions m ON m.speech_region_id = r.id AND m.episode_id = e.id
         WHERE a.kind = 'speaker_is' AND a.revoked_at_ms IS NULL
           AND a.sample_start < coalesce(m.slice_sample_end, r.sample_end, a.sample_start + 1)
           AND a.sample_end > m.slice_sample_start))
       AND NOT EXISTS (SELECT 1 FROM voice_passes v
                       WHERE v.run_id = ea.run_id AND v.embedder_version = ?)
     ORDER BY e.started_at_ms DESC, e.id DESC LIMIT ? OFFSET ?`,
  );
  // Episodes that may not be identified are skipped, page after page, so
  // they never hide older ones that may.
  // Dictations are listed only while they may teach the user's voice (ADR 030).
  const dictations = learnsFromDictations(db) && recognitionEnabled(db) && selfHasVoice(db) ? 1 : 0;
  const out: VoiceRun[] = [];
  for (let offset = 0; out.length < input.limit; offset += input.limit) {
    const rows = page.all(dictations, input.sinceMs, input.embedderVersion, input.limit, offset);
    for (const row of rows) {
      const run = { episodeId: int(row, "episode_id"), runId: int(row, "run_id") };
      if (out.length < input.limit && mayEmbed(db, run.episodeId)) out.push(run);
    }
    if (rows.length < input.limit) break;
  }
  return out;
}

/** Where « Apprendre ma voix depuis mes dictées » is kept; off unless the user turned it on. */
const DICTATIONS_KEY = "voices.learnFromDictations";
/** The user's latest dictations that may join their references. */
const DICTATION_REFERENCES = 100;

/** « Apprendre ma voix depuis mes dictées » (ADR 030): off by default. */
export function learnsFromDictations(db: Database): boolean {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(DICTATIONS_KEY);
  return row !== undefined && JSON.parse(str(row, "value")) === true;
}

/** Off deletes every dictation embedding; on lets the voice pass embed them. */
export function setLearnFromDictations(
  db: Database,
  input: { readonly on: boolean; readonly nowMs: number },
): void {
  transaction(db, () => {
    db.statement(
      `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
    ).run(DICTATIONS_KEY, JSON.stringify(input.on), input.nowMs);
    if (!input.on) forgetDictationVoices(db);
  });
}

/**
 * Whether some voice is named as the user now, or they read a text for Sondine
 * (ADR 034): what their dictations are checked against.
 */
const selfHasVoice = (db: Database) =>
  db
    .statement(
      `SELECT 1 FROM user_assertions a JOIN people p ON p.id = a.person_id
       WHERE p.is_self = 1 AND a.kind = 'speaker_is' AND a.revoked_at_ms IS NULL
       UNION ALL
       SELECT 1 FROM voice_reads r JOIN people p ON p.id = r.person_id WHERE p.is_self = 1
       LIMIT 1`,
    )
    .get() !== undefined;

/**
 * Whether a dictation may teach the user's voice (ADR 030): the setting is
 * on, voices are recognized, a voice is named as the user or they read a
 * text (ADR 034), and no « do not
 * identify » rule holds. A dictation never names anyone.
 */
function dictationTeaches(db: Database, episodeId: number): boolean {
  const episode = db.statement("SELECT context FROM episodes WHERE id = ?").get(episodeId);
  return (
    episode !== undefined &&
    str(episode, "context") === "dictation" &&
    learnsFromDictations(db) &&
    recognitionEnabled(db) &&
    selfHasVoice(db) &&
    identityRulesAllow(db, episodeId)
  );
}

/** Whether the voice pass may embed an episode's voices. */
const mayEmbed = (db: Database, episodeId: number) =>
  namingAllowed(db, episodeId) || dictationTeaches(db, episodeId);

const toBlob = (vector: readonly number[]) => {
  const buffer = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
};

const fromBlob = (blob: Uint8Array): Float32Array => {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return Float32Array.from({ length: blob.byteLength / 4 }, (_, index) =>
    view.getFloat32(index * 4, true),
  );
};

/**
 * Stores a run's voice embeddings and marks the run done for this embedder.
 * False (nothing stored) when the run is no longer its episode's transcript,
 * or voices may no longer be identified there.
 */
export function storeVoicePass(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly runId: number;
    readonly embedderVersion: string;
    readonly voices: readonly {
      readonly label: string;
      readonly vector: readonly number[];
      readonly speechMs: number;
    }[];
    readonly nowMs: number;
    /** `voicesPrint` when the pass read the voices: their voices merged since, nothing is kept. */
    readonly print?: string;
  },
): boolean {
  return transaction(db, () => {
    // A transcript replaced, or a rule set, while the tool ran: nothing is kept.
    if (currentSpeakerRun(db, input.episodeId) !== input.runId) return false;
    if (input.print !== undefined && voicesPrint(db, input.runId) !== input.print) return false;
    if (!mayEmbed(db, input.episodeId)) return false;
    const insert = db.statement(
      `INSERT OR REPLACE INTO speaker_embeddings
         (run_id, episode_id, label, embedder_version, vector, speech_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const voice of input.voices) {
      if (voice.vector.length !== 256) throw new RangeError("a voice embedding has 256 values");
      insert.run(
        input.runId,
        input.episodeId,
        voice.label,
        input.embedderVersion,
        toBlob(voice.vector),
        Math.round(voice.speechMs),
        input.nowMs,
      );
    }
    db.statement(
      `INSERT OR REPLACE INTO voice_passes (run_id, embedder_version, finished_at_ms) VALUES (?, ?, ?)`,
    ).run(input.runId, input.embedderVersion, input.nowMs);
    return true;
  });
}

interface StoredEmbedding {
  readonly version: string;
  readonly vector: Float32Array;
  readonly speechMs: number;
}

/** A run's embeddings by label, every embedder version kept apart. */
function runEmbeddings(db: Database, runId: number): Map<string, StoredEmbedding[]> {
  const out = new Map<string, StoredEmbedding[]>();
  for (const row of db
    .statement(
      "SELECT label, embedder_version, vector, speech_ms FROM speaker_embeddings WHERE run_id = ?",
    )
    .all(runId)) {
    const label = str(row, "label");
    out.set(label, [...(out.get(label) ?? []), storedEmbedding(row)]);
  }
  return out;
}

const storedEmbedding = (row: Row): StoredEmbedding => ({
  version: str(row, "embedder_version"),
  vector: fromBlob(row["vector"] as Uint8Array),
  speechMs: int(row, "speech_ms"),
});

/** The user's voice read (ADR 034), as Settings ▸ Voix shows it. */
export interface VoiceRead {
  readonly person: Person;
  readonly embedderVersion: string;
  readonly speechMs: number;
  readonly createdAtMs: number;
}

/** The user's voice read, or null when they have none. */
export function voiceRead(db: Database): VoiceRead | null {
  const row = db
    .statement(
      `SELECT r.embedder_version, r.speech_ms, r.created_at_ms,
              p.id AS p_id, p.name AS p_name
       FROM voice_reads r JOIN people p ON p.id = r.person_id
       WHERE p.is_self = 1 ORDER BY r.id DESC LIMIT 1`,
    )
    .get();
  return row === undefined
    ? null
    : {
        person: { id: int(row, "p_id"), name: str(row, "p_name"), isSelf: true },
        embedderVersion: str(row, "embedder_version"),
        speechMs: int(row, "speech_ms"),
        createdAtMs: int(row, "created_at_ms"),
      };
}

/**
 * What a voice read was started under (ADR 034): the user's row and the last
 * change of « Reconnaître les voix ». A read is kept only if both are still
 * the same, so deleting the user, merging them, or turning recognition off
 * (even back on) while it records or embeds leaves nothing.
 */
export interface VoiceReadConsent {
  readonly selfId: number | null;
  readonly recognitionChangedAtMs: number | null;
}

export function voiceReadConsent(db: Database): VoiceReadConsent {
  const rule = db
    .statement("SELECT updated_at_ms FROM identity_rules WHERE scope = 'global'")
    .get();
  return {
    selfId: selfPersonId(db),
    recognitionChangedAtMs: rule === undefined ? null : int(rule, "updated_at_ms"),
  };
}

/**
 * Keeps the embedding of a text the user read aloud (ADR 034) as their voice
 * read, replacing any earlier one, for the user's row (made as `selfName`
 * when there is none). Refused while « Reconnaître les voix » is off, and
 * when the user's row or that setting changed since `consent` was taken at
 * the start: the read must never outlive the user's no.
 */
export function storeVoiceRead(
  db: Database,
  input: {
    readonly consent: VoiceReadConsent;
    readonly selfName: string;
    readonly embedderVersion: string;
    readonly vector: readonly number[];
    readonly speechMs: number;
    readonly nowMs: number;
  },
):
  | { readonly ok: true; readonly person: Person }
  | { readonly ok: false; readonly reason: "recognition-off" | "changed" } {
  if (input.vector.length !== 256) throw new RangeError("a voice embedding has 256 values");
  return transaction(db, () => {
    if (!recognitionEnabled(db)) return { ok: false, reason: "recognition-off" } as const;
    const now = voiceReadConsent(db);
    if (
      now.selfId !== input.consent.selfId ||
      now.recognitionChangedAtMs !== input.consent.recognitionChangedAtMs
    ) {
      return { ok: false, reason: "changed" } as const;
    }
    const person = ensureSelf(db, input.selfName, input.nowMs);
    if (person === null) throw new RangeError("the user's name is empty");
    // One read at a time: reading again replaces it, whoever held it.
    db.statement("DELETE FROM voice_reads").run();
    db.statement(
      `INSERT INTO voice_reads (person_id, embedder_version, vector, speech_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      person.id,
      input.embedderVersion,
      toBlob(input.vector),
      Math.round(input.speechMs),
      input.nowMs,
    );
    return { ok: true, person } as const;
  });
}

/**
 * The read belongs to the user (ADR 034): after people change under it (a
 * merge undone or redone), it follows whoever is the user. With nobody the
 * user it stays where it is, and the undo that would leave it so is refused
 * (its row is not the one the undo restores).
 */
export function settleVoiceRead(db: Database): void {
  const self = selfPersonId(db);
  if (self !== null) {
    db.statement("UPDATE voice_reads SET person_id = ? WHERE person_id <> ?").run(self, self);
  }
}

/** « Oublier ma voix lue » (ADR 034): true when there was one. */
export function forgetVoiceRead(db: Database): boolean {
  return db.statement("DELETE FROM voice_reads").run().changes > 0;
}

/**
 * How a voice was heard, from its track key or its label
 * (`<trackKey>/<request>/<n>`): a microphone, the Mac's own sound (a call's
 * far side, an app), or the phone. A voice is compared with references heard
 * the same way when the person has some (ADR 030).
 */
export type VoiceChannel = "microphone" | "computer" | "phone" | "other";

export function voiceChannel(trackKeyOrLabel: string): VoiceChannel {
  switch (trackKeyOrLabel.slice(0, Math.max(0, trackKeyOrLabel.indexOf(":")))) {
    case "input":
      return "microphone";
    case "app":
    case "system":
      return "computer";
    case "phone":
      return "phone";
    default:
      return "other";
  }
}

/**
 * ADR 030: a logistic fit of the cosine between a voice and the centroid of a
 * person's reference voices, on Téo's microphone voices and SUMM-RE room
 * mixes (2026-11-10), at even odds. 80 % is a cosine of 0.486, 99 % of 0.607.
 */
const CALIBRATION = { slope: 26.6, intercept: -11.55 } as const;

/** The confidence, 0 to 1, that a voice is the person whose references it scores `similarity` against. */
export function voiceConfidence(similarity: number): number {
  return 1 / (1 + Math.exp(-(CALIBRATION.slope * similarity + CALIBRATION.intercept)));
}

/** Below this nothing is shown; from it, « Marie ? ». */
export const SUGGEST_CONFIDENCE = 0.8;
/**
 * From this a voice reads as the person, marked to confirm (« Marie* »); one
 * compared with references heard another way, or on a channel not measured,
 * is nothing below it.
 */
export const RECOGNIZE_CONFIDENCE = 0.99;
/** How much closer (cosine) the person must be than the next one. */
export const SUGGEST_MARGIN = 0.1;
/** Recognized, it waits for no answer: this many reference voices heard the same way… */
export const RECOGNIZE_REFERENCES = 3;
/** …on this many days at least (one conversation cut in three is one sitting)… */
export const RECOGNIZE_DAYS = 2;
/** …and this much speech in the voice (architecture §8). */
const RECOGNIZE_SPEECH_MS = 3_000;
/**
 * Whether a phone voice may be recognized against the person's phone
 * references (ADR 032, M5.8). Off until `sondine-bench voices phone`, held
 * out by day, recognizes no stranger on enough people and days
 * (`bench/results/voices-phone-*.md`); until then a phone voice is only
 * suggested, from 99 %, like any channel not measured. Set by that report,
 * never by hand.
 */
export const PHONE_VOICES_MEASURED = false;

/**
 * The channels where a voice may be recognized against references heard the
 * same way: the microphone (ADR 030), and the phone once measured. Across
 * channels a voice is only suggested, whatever this says.
 */
export function measuredChannels(phone: boolean): ReadonlySet<VoiceChannel> {
  return new Set<VoiceChannel>(phone ? ["microphone", "phone"] : ["microphone"]);
}

const MEASURED = measuredChannels(PHONE_VOICES_MEASURED);

const EMBEDDING_SIZE = 256;

/**
 * Unit vectors summed, with each episode's share, so the centroid without
 * one episode's voices (a voice never counts as its own reference) costs one
 * pass. Also counts the days the voices were heard on.
 */
class Pool {
  readonly #sum = new Float64Array(EMBEDDING_SIZE);
  #count = 0;
  #dictations = 0;
  #reads = 0;
  readonly #days = new Map<string, number>();
  readonly #episodes = new Map<
    number,
    {
      readonly sum: Float64Array;
      count: number;
      dictations: number;
      reads: number;
      readonly days: Map<string, number>;
    }
  >();

  add(
    vector: Float32Array,
    episodeId: number,
    day: string,
    source: "named" | "dictation" | "read" = "named",
  ): void {
    const own = this.#episodes.get(episodeId) ?? {
      sum: new Float64Array(EMBEDDING_SIZE),
      count: 0,
      dictations: 0,
      reads: 0,
      days: new Map<string, number>(),
    };
    this.#episodes.set(episodeId, own);
    for (let index = 0; index < EMBEDDING_SIZE; index++) {
      const value = vector[index] ?? 0;
      this.#sum[index] = (this.#sum[index] ?? 0) + value;
      own.sum[index] = (own.sum[index] ?? 0) + value;
    }
    this.#count += 1;
    own.count += 1;
    if (source === "dictation") {
      this.#dictations += 1;
      own.dictations += 1;
    }
    if (source === "read") {
      this.#reads += 1;
      own.reads += 1;
    }
    this.#days.set(day, (this.#days.get(day) ?? 0) + 1);
    own.days.set(day, (own.days.get(day) ?? 0) + 1);
  }

  /**
   * Cosine with the centroid of the voices outside `episodeId`, with how many
   * voices (dictations and the read among them) and days that leaves.
   */
  score(
    vector: Float32Array,
    episodeId: number,
  ): {
    similarity: number;
    references: number;
    dictations: number;
    reads: number;
    days: number;
  } | null {
    const own = this.#episodes.get(episodeId);
    const references = this.#count - (own?.count ?? 0);
    if (references === 0) return null;
    let product = 0;
    let centroid = 0;
    let length = 0;
    for (let index = 0; index < EMBEDDING_SIZE; index++) {
      const sum = (this.#sum[index] ?? 0) - (own?.sum[index] ?? 0);
      const value = vector[index] ?? 0;
      product += sum * value;
      centroid += sum * sum;
      length += value * value;
    }
    if (centroid === 0 || length === 0) return null;
    let days = 0;
    for (const [day, count] of this.#days) if (count > (own?.days.get(day) ?? 0)) days += 1;
    return {
      similarity: product / Math.sqrt(centroid * length),
      references,
      dictations: this.#dictations - (own?.dictations ?? 0),
      reads: this.#reads - (own?.reads ?? 0),
      days,
    };
  }
}

/** One person's reference voices: the voices named as them, by embedder version and channel. */
interface PersonReferences {
  readonly person: Person;
  readonly byChannel: Map<string, Pool>;
  readonly byVersion: Map<string, Pool>;
}

/** Everyone's reference voices (`knownVoices`): read once, then matched against many voices. */
export type KnownVoices = ReadonlyMap<number, PersonReferences>;

const poolOf = (pools: Map<string, Pool>, key: string) => {
  const pool = pools.get(key) ?? new Pool();
  pools.set(key, pool);
  return pool;
};

/**
 * Every person's reference voices: the embeddings of the voices the user
 * named as them, in current transcripts; for the user, their voice read
 * (ADR 034) and, when they turned it on, their latest dictations that sound
 * like the voices they named as themselves or read. Recognized voices are
 * never references (ADR 030): only the user's names, their read and their own
 * dictations are.
 */
export function knownVoices(db: Database, runs: readonly NamedRun[] = namedRuns(db)): KnownVoices {
  const known = new Map<number, PersonReferences>();
  for (const run of runs) {
    const embeddings = runEmbeddings(db, run.runId);
    const day = new Date(run.startedAtMs).toDateString();
    for (const [label, person] of run.speakers) {
      for (const embedding of embeddings.get(label) ?? []) {
        const entry = known.get(person.id) ?? {
          person,
          byChannel: new Map(),
          byVersion: new Map(),
        };
        known.set(person.id, entry);
        const channel = voiceChannel(label);
        poolOf(entry.byChannel, `${embedding.version}\n${channel}`).add(
          embedding.vector,
          run.episodeId,
          day,
        );
        poolOf(entry.byVersion, embedding.version).add(embedding.vector, run.episodeId, day);
      }
    }
  }
  addVoiceRead(db, known);
  const self = [...known.values()].find(({ person }) => person.isSelf);
  if (self !== undefined && learnsFromDictations(db)) addDictations(db, self);
  return known;
}

/**
 * Where the read sits among the episodes a pool counts: no episode has this
 * id, so a voice of any episode is scored against it, and it is one sitting.
 */
const READ_EPISODE = 0;

/**
 * The user's voice read (ADR 034) as one reference: heard on a microphone, on
 * the day it was read, one sitting like one conversation. It never stands for
 * three: recognition still needs three references on two days (ADR 030).
 */
function addVoiceRead(db: Database, known: Map<number, PersonReferences>): void {
  const row = db
    .statement(
      `SELECT r.embedder_version, r.vector, r.speech_ms, r.created_at_ms,
              p.id AS p_id, p.name AS p_name, p.is_self AS p_is_self
       FROM voice_reads r JOIN people p ON p.id = r.person_id
       WHERE p.is_self = 1 ORDER BY r.id DESC LIMIT 1`,
    )
    .get();
  if (row === undefined) return;
  const person: Person = { id: int(row, "p_id"), name: str(row, "p_name"), isSelf: true };
  const entry = known.get(person.id) ?? { person, byChannel: new Map(), byVersion: new Map() };
  known.set(person.id, entry);
  const embedding = storedEmbedding(row);
  const day = new Date(int(row, "created_at_ms")).toDateString();
  const microphone: VoiceChannel = "microphone";
  poolOf(entry.byChannel, `${embedding.version}\n${microphone}`).add(
    embedding.vector,
    READ_EPISODE,
    day,
    "read",
  );
  poolOf(entry.byVersion, embedding.version).add(embedding.vector, READ_EPISODE, day, "read");
}

/** Cosine at which `voiceConfidence` reaches `confidence`. */
const similarityAt = (confidence: number) =>
  (Math.log(confidence / (1 - confidence)) - CALIBRATION.intercept) / CALIBRATION.slope;

/**
 * The user's dictations as references (ADR 030): the latest ones the rules
 * let through, each kept only when it sounds like the voices the user named
 * as themselves or their read (80 % or more), so a dictation said by someone
 * else, or drowned in other voices, stays out.
 */
function addDictations(db: Database, self: PersonReferences): void {
  const gate = similarityAt(SUGGEST_CONFIDENCE);
  const allowed = new Map<number, boolean>();
  const kept: { episodeId: number; label: string; day: string; embedding: StoredEmbedding }[] = [];
  // Newest first, page after page, until 100 pass: those left out never crowd out older ones.
  const page = db.statement(
    `SELECT v.episode_id, v.label, v.embedder_version, v.vector, v.speech_ms, e.started_at_ms
     FROM episodes e
     JOIN episode_analysis ea ON ea.episode_id = e.id AND ea.stage = 'asr'
     JOIN speaker_embeddings v ON v.run_id = ea.run_id
     WHERE e.context = 'dictation'
     ORDER BY e.started_at_ms DESC, v.id DESC LIMIT ? OFFSET ?`,
  );
  for (let offset = 0; kept.length < DICTATION_REFERENCES; offset += DICTATION_REFERENCES) {
    const rows = page.all(DICTATION_REFERENCES, offset);
    for (const row of rows) {
      if (kept.length >= DICTATION_REFERENCES) break;
      const episodeId = int(row, "episode_id");
      let may = allowed.get(episodeId);
      if (may === undefined) {
        may = identityRulesAllow(db, episodeId);
        allowed.set(episodeId, may);
      }
      if (!may) continue;
      const embedding = storedEmbedding(row);
      // Against the named voices and the read only: dictations never vouch for each other.
      const named = self.byVersion.get(embedding.version)?.score(embedding.vector, episodeId);
      if (named === undefined || named === null || named.similarity < gate) continue;
      kept.push({
        episodeId,
        label: str(row, "label"),
        day: new Date(int(row, "started_at_ms")).toDateString(),
        embedding,
      });
    }
    if (rows.length < DICTATION_REFERENCES) break;
  }
  for (const { episodeId, label, day, embedding } of kept) {
    poolOf(self.byChannel, `${embedding.version}\n${voiceChannel(label)}`).add(
      embedding.vector,
      episodeId,
      day,
      "dictation",
    );
    poolOf(self.byVersion, embedding.version).add(embedding.vector, episodeId, day, "dictation");
  }
}

/** Who a voice may be (ADR 030). */
export interface VoiceMatch {
  readonly person: Person;
  /** Cosine with the centroid of the person's reference voices. */
  readonly similarity: number;
  /** Calibrated confidence that the voice is this person, 0 to 1 (`voiceConfidence`). */
  readonly confidence: number;
  /** How many reference voices it was compared with… */
  readonly references: number;
  /** …of which the user's dictations (ADR 030)… */
  readonly dictations: number;
  /** …and their voice read (ADR 034), 0 or 1. */
  readonly reads: number;
  /**
   * `recognized` and `likely`, at 99 % or more: « Marie* », the person's name
   * marked until the user confirms or corrects it. `recognized` also has the
   * references and the measured channel it takes to leave « Qui est-ce ? »;
   * `likely` waits there. `suggested`: « Marie ? ».
   */
  readonly zone: "recognized" | "likely" | "suggested";
}

/** The voice reads as the person, marked: 99 % or more (ADR 030). */
export const readsAsPerson = (match: VoiceMatch): boolean => match.zone !== "suggested";

interface HeardVoice {
  readonly episodeId: number;
  readonly channel: VoiceChannel;
  readonly embeddings: readonly StoredEmbedding[];
}

/** One person's score against a voice: the best embedder version that has references. */
export interface PersonScore {
  readonly person: Person;
  readonly similarity: number;
  readonly references: number;
  readonly dictations: number;
  readonly reads: number;
  readonly days: number;
  /** Compared with references heard the same way. */
  readonly same: boolean;
  /** Speech in the embedding that scored. */
  readonly speechMs: number;
}

/** Every person's score against a voice, best first. */
function scoreVoice(known: KnownVoices, voice: HeardVoice): PersonScore[] {
  return [...known.values()]
    .flatMap(({ person, byChannel, byVersion }) => {
      let best: PersonScore | null = null;
      for (const { version, vector, speechMs } of voice.embeddings) {
        const same = byChannel.get(`${version}\n${voice.channel}`)?.score(vector, voice.episodeId);
        const any =
          same === undefined || same === null
            ? byVersion.get(version)?.score(vector, voice.episodeId)
            : null;
        const scored =
          same !== undefined && same !== null
            ? { person, ...same, same: true, speechMs }
            : any !== undefined && any !== null
              ? { person, ...any, same: false, speechMs }
              : null;
        if (scored !== null && (best === null || scored.similarity > best.similarity)) {
          best = scored;
        }
      }
      return best === null ? [] : [best];
    })
    .toSorted((a, b) => b.similarity - a.similarity);
}

/** Heard the same way as the person's references, on a channel recognition was measured on. */
const measuredFor = (
  score: PersonScore,
  channel: VoiceChannel,
  measured: ReadonlySet<VoiceChannel> = MEASURED,
) => score.same && measured.has(channel);

/** Whether a score alone could make a recognition, whoever else competes. */
function mayRecognize(
  score: PersonScore,
  channel: VoiceChannel,
  measured: ReadonlySet<VoiceChannel> = MEASURED,
): boolean {
  return (
    measuredFor(score, channel, measured) &&
    voiceConfidence(score.similarity) >= RECOGNIZE_CONFIDENCE &&
    score.references >= RECOGNIZE_REFERENCES &&
    score.days >= RECOGNIZE_DAYS &&
    score.speechMs >= RECOGNIZE_SPEECH_MS
  );
}

/**
 * The person a voice is closest to, by the centroid of each person's
 * references of the same embedder version from other episodes (heard the
 * same way when they have some), 0.10 ahead of the next. Likely at 99 %, and
 * recognized with three references on two days, heard the same way on a
 * measured channel, and 3 s of speech; otherwise suggested from 80 % on a
 * measured channel. Null below.
 */
export function decideVoice(
  scores: readonly PersonScore[],
  channel: VoiceChannel,
  options: {
    /** People the user said this voice is not. */
    readonly skip?: (person: Person) => boolean;
    /** `measuredChannels(…)`; the bench asks what a channel not measured yet would do. */
    readonly measured?: ReadonlySet<VoiceChannel>;
  } = {},
): VoiceMatch | null {
  const { skip = () => false, measured: channels = MEASURED } = options;
  const [best, next] = scores
    .filter((score) => !skip(score.person))
    .toSorted((a, b) => b.similarity - a.similarity);
  if (best === undefined || best.similarity - (next?.similarity ?? -1) < SUGGEST_MARGIN) {
    return null;
  }
  const confidence = voiceConfidence(best.similarity);
  const measured = measuredFor(best, channel, channels);
  if (confidence < (measured ? SUGGEST_CONFIDENCE : RECOGNIZE_CONFIDENCE)) return null;
  return {
    person: best.person,
    similarity: best.similarity,
    confidence,
    references: best.references,
    dictations: best.dictations,
    reads: best.reads,
    zone: mayRecognize(best, channel, channels)
      ? "recognized"
      : confidence >= RECOGNIZE_CONFIDENCE
        ? "likely"
        : "suggested",
  };
}

function matchVoice(
  known: KnownVoices,
  voice: HeardVoice,
  skip: (person: Person) => boolean,
): VoiceMatch | null {
  return decideVoice(scoreVoice(known, voice), voice.channel, { skip });
}

/**
 * Who each unnamed voice of a run may be, by label (ADR 030). A person the user said a voice is not is skipped. Nothing where
 * voices may not be identified.
 */
export function voiceMatches(
  db: Database,
  runId: number,
  known?: KnownVoices,
): Map<string, VoiceMatch> {
  const out = new Map<string, VoiceMatch>();
  const run = db.statement("SELECT episode_id FROM analysis_runs WHERE id = ?").get(runId);
  if (run === undefined) return out;
  const episodeId = int(run, "episode_id");
  if (!namingAllowed(db, episodeId)) return out;
  const named = resolveSpeakers(db, runId);
  const unnamed = [...runEmbeddings(db, runId)].filter(([label]) => !named.has(label));
  if (unnamed.length === 0) return out;
  const voices = known ?? knownVoices(db);
  const refused = refusals(db, runId);
  for (const [label, embeddings] of unnamed) {
    const match = matchVoice(
      voices,
      { episodeId, channel: voiceChannel(label), embeddings },
      (person) => refused.get(label)?.has(person.id) ?? false,
    );
    if (match !== null) out.set(label, match);
  }
  return out;
}

/**
 * The voice shown as the user (ADR 030): the one named as them, else one
 * recognized as them, else the sources' guess unless that voice reads as
 * someone else. A voice only likely them reads « Moi* » without becoming it:
 * exports, which hold no guess, call this one « Moi ».
 */
export function shownSelf(
  db: Database,
  runId: number,
  base: SelfSpeaker | undefined,
  named: ReadonlyMap<string, Person>,
  matches: ReadonlyMap<string, VoiceMatch>,
): SelfSpeaker | null {
  if (matches.size === 0 || (base !== undefined && named.get(base.label)?.isSelf === true)) {
    return base ?? null;
  }
  const label = [...matches].find(
    ([, match]) => match.zone === "recognized" && match.person.isSelf,
  )?.[0];
  if (label !== undefined) {
    const row = db
      .statement("SELECT ordinal FROM episode_speakers WHERE run_id = ? AND label = ?")
      .get(runId, label);
    return row === undefined ? null : { label, ordinal: Number(row["ordinal"]) };
  }
  if (base === undefined) return null;
  const match = matches.get(base.label);
  return match !== undefined && readsAsPerson(match) && !match.person.isSelf ? null : base;
}

/** How much a voice sounds like one person (ADR 030), whatever the zone. */
export interface VoiceLikeness {
  readonly person: Person;
  readonly similarity: number;
  readonly confidence: number;
  readonly references: number;
  readonly dictations: number;
  readonly reads: number;
}

/**
 * How much one voice of a run sounds like each person with reference voices,
 * likeliest first: what « Qui est-ce ? » shows beside each name. Empty when
 * the voice has no embedding or voices may not be identified there.
 */
export function voiceLikeness(
  db: Database,
  input: { readonly runId: number; readonly label: string },
  known?: KnownVoices,
): VoiceLikeness[] {
  const run = db.statement("SELECT episode_id FROM analysis_runs WHERE id = ?").get(input.runId);
  if (run === undefined) return [];
  const episodeId = int(run, "episode_id");
  if (!namingAllowed(db, episodeId)) return [];
  const embeddings = runEmbeddings(db, input.runId).get(input.label);
  if (embeddings === undefined) return [];
  return scoreVoice(known ?? knownVoices(db), {
    episodeId,
    channel: voiceChannel(input.label),
    embeddings,
  }).map((score) => ({
    person: score.person,
    similarity: score.similarity,
    confidence: voiceConfidence(score.similarity),
    references: score.references,
    dictations: score.dictations,
    reads: score.reads,
  }));
}

/** A voice that reads as someone the user did not name it as (`readsAsPerson`). */
export interface RecognizedVoice {
  readonly episodeId: number;
  readonly runId: number;
  readonly label: string;
  readonly startedAtMs: number;
  readonly match: VoiceMatch;
}

/**
 * The voices that read as someone in current transcripts (all, or those of
 * `episodeIds`), newest first. Derived from the evidence at each read
 * (ADR 030): a name the user gives, takes back or corrects anywhere moves
 * them at once, and nothing of them is stored. The vectors are matched first;
 * only a voice at 99 % is checked against the rules and its « Non ».
 */
export function recognizedVoices(
  db: Database,
  input: {
    readonly episodeIds?: readonly number[];
    readonly runs?: readonly NamedRun[];
    readonly known?: KnownVoices;
  } = {},
): RecognizedVoice[] {
  const runs = input.runs ?? namedRuns(db);
  const known = input.known ?? knownVoices(db, runs);
  if (known.size === 0) return [];
  const named = new Map(runs.map((run) => [run.runId, run.speakers]));
  const rows = db
    .statement(
      `SELECT v.run_id, v.episode_id, v.label, v.embedder_version, v.vector, v.speech_ms,
              e.started_at_ms
       FROM speaker_embeddings v
       JOIN episode_analysis ea ON ea.run_id = v.run_id AND ea.stage = 'asr'
       JOIN episodes e ON e.id = v.episode_id
       WHERE e.context IN ('call', 'in_person', 'mixed')
         AND (? IS NULL OR v.episode_id IN (SELECT value FROM json_each(?)))
       ORDER BY e.started_at_ms DESC, v.episode_id DESC, v.label`,
    )
    .all(input.episodeIds === undefined ? null : 1, JSON.stringify(input.episodeIds ?? []));
  const voices = new Map<
    string,
    {
      episodeId: number;
      runId: number;
      label: string;
      startedAtMs: number;
      embeddings: StoredEmbedding[];
    }
  >();
  for (const row of rows) {
    const runId = int(row, "run_id");
    const label = str(row, "label");
    if (named.get(runId)?.has(label) === true) continue;
    const key = `${runId}\n${label}`;
    const voice = voices.get(key) ?? {
      episodeId: int(row, "episode_id"),
      runId,
      label,
      startedAtMs: int(row, "started_at_ms"),
      embeddings: [],
    };
    voice.embeddings.push(storedEmbedding(row));
    voices.set(key, voice);
  }
  const allowed = new Map<number, boolean>();
  const refused = new Map<number, Map<string, Set<number>>>();
  const out: RecognizedVoice[] = [];
  for (const voice of voices.values()) {
    const channel = voiceChannel(voice.label);
    const scores = scoreVoice(known, { ...voice, channel });
    // Only a voice that could read as someone goes on to the rules and its « Non »:
    // a refusal only takes people out, so it may let the next one through.
    if (!scores.some((score) => voiceConfidence(score.similarity) >= RECOGNIZE_CONFIDENCE)) {
      continue;
    }
    let may = allowed.get(voice.episodeId);
    if (may === undefined) {
      may = namingAllowed(db, voice.episodeId);
      allowed.set(voice.episodeId, may);
    }
    if (!may) continue;
    let byLabel = refused.get(voice.runId);
    if (byLabel === undefined) {
      byLabel = refusals(db, voice.runId);
      refused.set(voice.runId, byLabel);
    }
    const no = byLabel.get(voice.label);
    const match = decideVoice(scores, channel, { skip: (person) => no?.has(person.id) ?? false });
    if (match === null || !readsAsPerson(match)) continue;
    out.push({
      episodeId: voice.episodeId,
      runId: voice.runId,
      label: voice.label,
      startedAtMs: voice.startedAtMs,
      match,
    });
  }
  return out;
}

/**
 * The people each episode's voices read as and not named in it,
 * in the order their voices first speak; episodes without any are absent.
 */
export function episodeRecognized(
  db: Database,
  episodeIds: readonly number[],
  input: { readonly runs?: readonly NamedRun[]; readonly known?: KnownVoices } = {},
): Map<number, Person[]> {
  const out = new Map<number, Person[]>();
  if (episodeIds.length === 0) return out;
  const runs = input.runs ?? namedRuns(db);
  const recognized = recognizedVoices(db, {
    episodeIds,
    runs,
    ...(input.known === undefined ? {} : { known: input.known }),
  });
  const named = new Map(
    runs.map((run) => [run.episodeId, new Set([...run.speakers.values()].map((p) => p.id))]),
  );
  const ordinals = db.statement("SELECT label, ordinal FROM episode_speakers WHERE run_id = ?");
  const byEpisode = Map.groupBy(recognized, (voice) => voice.episodeId);
  for (const [episodeId, voices] of byEpisode) {
    const runId = voices[0]?.runId;
    if (runId === undefined) continue;
    const order = new Map(
      ordinals.all(runId).map((row) => [str(row, "label"), int(row, "ordinal")]),
    );
    const people: Person[] = [];
    for (const voice of voices.toSorted(
      (a, b) => (order.get(a.label) ?? 0) - (order.get(b.label) ?? 0),
    )) {
      const person = voice.match.person;
      if (named.get(episodeId)?.has(person.id) === true) continue;
      if (!people.some((known) => known.id === person.id)) people.push(person);
    }
    if (people.length > 0) out.set(episodeId, people);
  }
  return out;
}

/**
 * Whether a voice heard now could be recognized at all: someone other than
 * the user is named and some voice is embedded. Two cheap reads, for every
 * commit of a call (ADR 025).
 */
export function anyoneToRecognize(db: Database): boolean {
  return (
    db.statement("SELECT 1 FROM people WHERE is_self = 0 LIMIT 1").get() !== undefined &&
    db.statement("SELECT 1 FROM speaker_embeddings LIMIT 1").get() !== undefined
  );
}

/**
 * Who a voice heard live in a call may be (ADR 025, 030): its embedding,
 * never stored, against everyone's reference voices, matched as any voice is,
 * the far side being heard by the Mac (`computer`). The user competes too: a
 * voice closest to theirs (their own voice coming back on the far side) is
 * no one's. Null below the thresholds, or where voices may not be identified.
 */
export function recognizeVoice(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly embedderVersion: string;
    readonly vector: readonly number[];
    readonly speechMs: number;
    readonly channel: VoiceChannel;
    readonly voices?: KnownVoices;
  },
): VoiceMatch | null {
  if (!namingAllowed(db, input.episodeId)) return null;
  const best = matchVoice(
    input.voices ?? knownVoices(db),
    {
      episodeId: input.episodeId,
      channel: input.channel,
      embeddings: [
        {
          version: input.embedderVersion,
          vector: Float32Array.from(input.vector),
          speechMs: input.speechMs,
        },
      ],
    },
    () => false,
  );
  return best === null || best.person.isSelf ? null : best;
}

export interface UnnamedVoice {
  readonly episodeId: number;
  readonly runId: number;
  readonly label: string;
  readonly ordinal: number;
  readonly voicedMs: number;
  readonly match: VoiceMatch | null;
}

/**
 * « Qui est-ce ? »: the voices of recent calls, in-person and mixed episodes
 * where voices may be identified that nobody named and Sondine did not
 * recognize for sure (`likely` waits here), that spoke at least `minVoicedMs`.
 * Those Sondine takes for someone come first, likeliest first, then the ones
 * that spoke most.
 */
export function unnamedVoices(
  db: Database,
  input: { readonly sinceMs: number; readonly minVoicedMs: number; readonly limit: number },
): UnnamedVoice[] {
  const runs = db
    .statement(
      `SELECT e.id AS episode_id, ea.run_id FROM episode_analysis ea
       JOIN episodes e ON e.id = ea.episode_id
       WHERE ea.stage = 'asr' AND e.context IN ('call', 'in_person', 'mixed')
         AND e.started_at_ms >= ?
       ORDER BY e.started_at_ms DESC LIMIT 200`,
    )
    .all(input.sinceMs)
    .map((row) => ({ episodeId: int(row, "episode_id"), runId: int(row, "run_id") }))
    .filter((run) => namingAllowed(db, run.episodeId));
  const known = knownVoices(db);
  const out: UnnamedVoice[] = [];
  for (const run of runs) {
    const named = resolveSpeakers(db, run.runId);
    const matches = voiceMatches(db, run.runId, known);
    for (const speaker of loadRunSpeakers(db, run.runId)) {
      if (named.has(speaker.label) || speaker.voicedMs < input.minVoicedMs) continue;
      const match = matches.get(speaker.label) ?? null;
      if (match?.zone === "recognized") continue;
      out.push({
        ...run,
        label: speaker.label,
        ordinal: speaker.ordinal,
        voicedMs: speaker.voicedMs,
        match,
      });
    }
  }
  return out
    .toSorted(
      (a, b) =>
        (b.match?.confidence ?? -1) - (a.match?.confidence ?? -1) || b.voicedMs - a.voicedMs,
    )
    .slice(0, input.limit);
}

/** A voice the user named that sounds like someone else. */
export interface DoubtedName {
  readonly episodeId: number;
  readonly runId: number;
  readonly label: string;
  readonly voicedMs: number;
  /** Where its longest sentence starts: what to hear first. */
  readonly startMs: number;
  /** Whom the user named it as… */
  readonly person: Person;
  /** …the confidence it has against their other voices; null when they have none elsewhere… */
  readonly confidence: number | null;
  /** …and whom it sounds like, at 99 % or more. */
  readonly match: VoiceMatch;
}

/**
 * « À vérifier »: the voices the user named, newest first, that sound like
 * someone else at 99 % or more and 0.10 closer to them than to the person
 * named, with 3 s of speech. Each is compared as if unnamed: never with its
 * own episode's voices. Derived at each read (ADR 030): the user's name holds
 * until they change it; keeping it is a « Non » to the other person.
 */
export function doubtedNames(
  db: Database,
  input: {
    readonly limit: number;
    readonly runs?: readonly NamedRun[];
    readonly known?: KnownVoices;
  },
): DoubtedName[] {
  const runs = input.runs ?? namedRuns(db);
  const known = input.known ?? knownVoices(db, runs);
  const out: DoubtedName[] = [];
  for (const run of runs) {
    const embedded = runEmbeddings(db, run.runId);
    let refused: Map<string, Set<number>> | null = null;
    for (const [label, person] of run.speakers) {
      const embeddings = embedded.get(label);
      if (embeddings === undefined) continue;
      const channel = voiceChannel(label);
      const scores = scoreVoice(known, { episodeId: run.episodeId, channel, embeddings });
      if (decideVoice(scores, channel)?.person.id === person.id) continue;
      refused ??= refusals(db, run.runId);
      const no = refused.get(label);
      // The person named always competes: an older « Non » to them went with the name.
      const match = decideVoice(scores, channel, {
        skip: (other) => other.id !== person.id && (no?.has(other.id) ?? false),
      });
      if (match === null || match.person.id === person.id || !readsAsPerson(match)) continue;
      const heard = scores.find((score) => score.person.id === match.person.id);
      if (heard === undefined || heard.speechMs < RECOGNIZE_SPEECH_MS) continue;
      const sentences = voicedSegments(db, run.runId).filter((segment) => segment.label === label);
      const longest = sentences.toSorted(
        (a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs,
      )[0];
      if (longest === undefined) continue;
      const own = scores.find((score) => score.person.id === person.id);
      out.push({
        episodeId: run.episodeId,
        runId: run.runId,
        label,
        voicedMs:
          loadRunSpeakers(db, run.runId).find((speaker) => speaker.label === label)?.voicedMs ?? 0,
        startMs: longest.startMs,
        person,
        confidence: own === undefined ? null : voiceConfidence(own.similarity),
        match,
      });
      if (out.length >= input.limit) return out;
    }
  }
  return out;
}

/** The people each voice of a run was said not to be (`speaker_is_not` over most of its speech). */
function refusals(db: Database, runId: number): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  // Most transcripts have none: one probe over the run's extent per track first.
  const any = db
    .statement(
      `SELECT 1 FROM user_assertions a
       JOIN (SELECT track_run_id, min(sample_start) AS lo, max(sample_end) AS hi
             FROM segments WHERE run_id = ? GROUP BY track_run_id) x
         ON x.track_run_id = a.track_run_id
       WHERE a.kind = 'speaker_is_not' AND a.revoked_at_ms IS NULL
         AND a.sample_start < x.hi AND a.sample_end > x.lo
       LIMIT 1`,
    )
    .get(runId);
  if (any === undefined) return out;
  const anchors = db.statement(
    `SELECT person_id, sum(min(sample_end, ?) - max(sample_start, ?)) AS covered FROM user_assertions
     WHERE kind = 'speaker_is_not' AND revoked_at_ms IS NULL AND track_run_id = ?
       AND sample_start < ? AND sample_end > ? GROUP BY person_id`,
  );
  const covered = new Map<string, Map<number, number>>();
  const lengths = new Map<string, number>();
  for (const segment of voicedSegments(db, runId)) {
    lengths.set(
      segment.label,
      (lengths.get(segment.label) ?? 0) + segment.sampleEnd - segment.sampleStart,
    );
    for (const row of anchors.all(
      segment.sampleEnd,
      segment.sampleStart,
      segment.trackRunId,
      segment.sampleEnd,
      segment.sampleStart,
    )) {
      const people = covered.get(segment.label) ?? new Map<number, number>();
      const personId = int(row, "person_id");
      people.set(personId, (people.get(personId) ?? 0) + int(row, "covered"));
      covered.set(segment.label, people);
    }
  }
  for (const [label, people] of covered) {
    const total = lengths.get(label) ?? 0;
    const refused = new Set(
      [...people].filter(([, samples]) => samples * 2 >= total).map(([id]) => id),
    );
    if (refused.size > 0) out.set(label, refused);
  }
  return out;
}

/** « Non »: this voice is not that person; the suggestion does not come back. */
export function refuseSuggestion(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly runId: number;
    readonly label: string;
    readonly personId: number;
    readonly nowMs: number;
  },
): "ok" | "stale" | "not-found" {
  return transaction(db, () => {
    const current = currentSpeakerRun(db, input.episodeId);
    if (current === null) return "not-found";
    if (current !== input.runId) return "stale";
    const segments = voicedSegments(db, input.runId).filter(
      (segment) => segment.label === input.label,
    );
    const person = db.statement("SELECT id FROM people WHERE id = ?").get(input.personId);
    if (segments.length === 0 || person === undefined) return "not-found";
    const insert = db.statement(
      `INSERT INTO user_assertions
         (kind, track_run_id, sample_start, sample_end, origin, created_at_ms, person_id)
       VALUES ('speaker_is_not', ?, ?, ?, 'app', ?, ?)`,
    );
    for (const segment of segments) {
      insert.run(
        segment.trackRunId,
        segment.sampleStart,
        segment.sampleEnd,
        input.nowMs,
        input.personId,
      );
    }
    return "ok";
  });
}

/**
 * ADR 012: the embeddings of voices nobody named, from episodes that started
 * before `beforeMs` (90 days), are deleted; named voices stay, they are their
 * person's voice. Returns how many were deleted.
 */
export function forgetUnnamedVoices(db: Database, beforeMs: number): number {
  const runs = db
    .statement(
      `SELECT DISTINCT v.run_id FROM speaker_embeddings v JOIN episodes e ON e.id = v.episode_id
       WHERE e.started_at_ms < ?`,
    )
    .all(beforeMs)
    .map((row) => int(row, "run_id"));
  const remove = db.statement("DELETE FROM speaker_embeddings WHERE run_id = ? AND label = ?");
  let deleted = 0;
  for (const runId of runs) {
    const named = resolveSpeakers(db, runId);
    for (const label of runEmbeddings(db, runId).keys()) {
      if (!named.has(label)) deleted += Number(remove.run(runId, label).changes);
    }
  }
  return deleted;
}
