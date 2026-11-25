import { join } from "node:path";
import { z } from "zod";
import { readRows, readText, remembered } from "./read-history";

// What dictation apps keep of the text they typed (ADR 020), each read from
// its own files. An app says when the user spoke, or only when its text came:
// the microphone's own spans then say when (`place-typed.ts`).

/** A dictation as its app kept it. */
export type Typed =
  | {
      readonly kind: "spoken";
      readonly startMs: number;
      readonly endMs: number;
      readonly text: string;
    }
  | {
      readonly kind: "came";
      /** Between these two: an app may keep only the second. */
      readonly fromMs: number;
      readonly toMs: number;
      /** How long the user spoke, when the app says; its silences may be left out. */
      readonly spokeMs: number | null;
      readonly text: string;
    };

export type DictationHistory = () => readonly Typed[] | null;

const Text = z.string().max(100_000);
const Ms = z.number().finite();

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Hex 3.4 (anomaly.hex): `history.json`, version 1.

const HexEntry = z.object({
  kind: z.literal("dictation"),
  /** When Hex had the text; the user stopped speaking `total_ms` before. */
  timestamp_ms: z.int().positive(),
  total_ms: z.int().nonnegative(),
  audio_ms: z.int().positive(),
  final_text: Text,
});
/** Another version of the file may mean something else by the same names. */
const HexFile = z.object({ version: z.literal(1), entries: z.array(z.unknown()).max(100_000) });

export function parseHex(text: string | null): Typed[] | null {
  const file = HexFile.safeParse(parseJson(text));
  if (!file.success) return null;
  return file.data.entries.flatMap((item): Typed[] => {
    const entry = HexEntry.safeParse(item);
    if (!entry.success) return [];
    const { timestamp_ms, total_ms, audio_ms, final_text } = entry.data;
    const endMs = timestamp_ms - total_ms;
    return [{ kind: "spoken", startMs: endMs - audio_ms, endMs, text: final_text.trim() }];
  });
}

// Parler (app.synapsr.parler): `history.json`, a list whose ids are the time the text came.

const ParlerEntry = z.object({
  id: z.int().positive(),
  text: Text,
  durationMs: z.int().nonnegative(),
});

export function parseParler(text: string | null): Typed[] | null {
  const list = z.array(z.unknown()).max(100_000).safeParse(parseJson(text));
  if (!list.success) return null;
  return list.data.flatMap((item): Typed[] => {
    const entry = ParlerEntry.safeParse(item);
    if (!entry.success) return [];
    const { id, durationMs } = entry.data;
    return [
      { kind: "came", fromMs: id, toMs: id, spokeMs: durationMs, text: entry.data.text.trim() },
    ];
  });
}

// VoiceInk 1 and 2: SwiftData's `default.store`. Its time is the end of speech;
// it types the enhanced text when there is one. An enhancement that failed
// leaves its error there, and no duration: what was typed is then the text.

/** Core Data counts seconds from 2001. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

const VoiceInkRow = z.object({ at: Ms, duration: Ms.positive(), text: Text });

function readVoiceInk(path: string): Typed[] | null {
  const rows = readRows(
    path,
    "ZTRANSCRIPTION",
    `SELECT ZTIMESTAMP AS at, ZDURATION AS duration,
       CASE WHEN ZENHANCEMENTDURATION IS NULL OR trim(coalesce(ZENHANCEDTEXT, '')) = ''
         THEN ZTEXT ELSE ZENHANCEDTEXT END AS text
     FROM ZTRANSCRIPTION WHERE ZTRANSCRIPTIONSTATUS = 'completed' ORDER BY ZTIMESTAMP DESC`,
  );
  return (
    rows?.flatMap((item): Typed[] => {
      const row = VoiceInkRow.safeParse(item);
      if (!row.success) return [];
      const endMs = Math.round(APPLE_EPOCH_MS + row.data.at * 1000);
      const startMs = endMs - Math.round(row.data.duration * 1000);
      return [{ kind: "spoken", startMs, endMs, text: row.data.text.trim() }];
    }) ?? null
  );
}

// Handy 0.10 (com.pais.handy): `history.db`, whose time is the second the text came.

const HandyRow = z.object({ at: z.int().positive(), text: Text });

function readHandy(path: string): Typed[] | null {
  const rows = readRows(
    path,
    "transcription_history",
    // A file the user had transcribed has a source; a dictation has none.
    `SELECT timestamp AS at,
       CASE WHEN trim(coalesce(post_processed_text, '')) = '' THEN transcription_text
         ELSE post_processed_text END AS text
     FROM transcription_history WHERE source_name IS NULL ORDER BY timestamp DESC, id DESC`,
  );
  return (
    rows?.flatMap((item): Typed[] => {
      const row = HandyRow.safeParse(item);
      if (!row.success) return [];
      const fromMs = row.data.at * 1000;
      return [
        {
          kind: "came",
          fromMs,
          toMs: fromMs + 999,
          spokeMs: null,
          text: row.data.text.trim(),
        },
      ];
    }) ?? null
  );
}

/** The histories Sondine can read, by the app's bundle ID. */
export function dictationHistories(home: string): ReadonlyMap<string, DictationHistory> {
  const support = join(home, "Library", "Application Support");
  const hex = join(support, "hex", "history.json");
  const parler = join(support, "app.synapsr.parler", "history.json");
  const voiceInk = join(support, "com.prakashjoshipax.VoiceInk", "default.store");
  const handy = join(support, "com.pais.handy", "history.db");
  return new Map<string, DictationHistory>([
    ["anomaly.hex", remembered([hex], () => parseHex(readText(hex)))],
    ["app.synapsr.parler", remembered([parler], () => parseParler(readText(parler)))],
    [
      "com.prakashjoshipax.VoiceInk",
      remembered([voiceInk, `${voiceInk}-wal`], () => readVoiceInk(voiceInk)),
    ],
    ["com.pais.handy", remembered([handy, `${handy}-wal`], () => readHandy(handy))],
  ]);
}
