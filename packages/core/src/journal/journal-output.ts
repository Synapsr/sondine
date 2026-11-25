import {
  COMMITMENT_KINDS,
  MAX_TEXT_CHARS,
  MAX_WHAT_CHARS,
  type CommitmentKind,
  type JournalRequest,
} from "./journal-prompt";

// What a model's answer may become (ADR 028): every item cites lines of its
// request, all of them real; voices are opaque ids (`{P2}`) the window
// resolves to names when it shows them. Anything else is dropped, never
// repaired into a claim the model did not make.

export interface JournalEventDraft {
  readonly kind: "event";
  /** With voices as `{P1}`, `{P2}`. */
  readonly text: string;
  readonly segmentIds: readonly number[];
}

export interface JournalCommitmentDraft {
  readonly kind: "commitment";
  /** The action, with voices as `{P2}` if any. */
  readonly text: string;
  /** Voice refs (`P1`), null when not said. */
  readonly who: string | null;
  readonly to: string | null;
  /** `YYYY-MM-DD`. */
  readonly due: string | null;
  readonly dueText: string | null;
  readonly segmentIds: readonly number[];
}

export type JournalDraft = JournalEventDraft | JournalCommitmentDraft;

/** An entry the model set aside as not a commitment, by its kind. */
export type SetAsideKind = Exclude<CommitmentKind, "promise" | "accepted">;

export type DropReason =
  | "empty"
  | "too-long"
  | "bad-cite"
  | "context-only"
  | "bad-voice"
  | "duplicate"
  | "vague";

export type JournalAnswer =
  | {
      readonly ok: true;
      readonly items: readonly JournalDraft[];
      readonly dropped: Readonly<Partial<Record<DropReason, number>>>;
      /** Entries the model itself sorted out of the commitments, by kind. */
      readonly setAside: Readonly<Partial<Record<SetAsideKind, number>>>;
    }
  | { readonly ok: false; readonly error: "not-json" | "bad-shape" };

interface AnswerShape {
  readonly journal: readonly { readonly text: string; readonly cite: readonly number[] }[];
  readonly commitments: readonly {
    readonly kind: CommitmentKind;
    readonly who: string | null;
    readonly to: string | null;
    readonly what: string;
    readonly due: string | null;
    readonly dueText: string | null;
    readonly cite: readonly number[];
  }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const numbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((n) => typeof n === "number");

/** The answer's shape, members beyond it ignored; null when it is not that. */
function shapeOf(json: unknown): AnswerShape | null {
  if (!isRecord(json) || !Array.isArray(json["journal"]) || !Array.isArray(json["commitments"])) {
    return null;
  }
  const journal: AnswerShape["journal"][number][] = [];
  for (const item of json["journal"]) {
    if (!isRecord(item) || typeof item["text"] !== "string" || !numbers(item["cite"])) return null;
    journal.push({ text: item["text"], cite: item["cite"] });
  }
  const commitments: AnswerShape["commitments"][number][] = [];
  for (const item of json["commitments"]) {
    const kind = isRecord(item)
      ? COMMITMENT_KINDS.find((candidate) => candidate === item["kind"])
      : undefined;
    if (
      !isRecord(item) ||
      kind === undefined ||
      typeof item["what"] !== "string" ||
      !numbers(item["cite"]) ||
      !stringOrNull(item["who"]) ||
      !stringOrNull(item["to"]) ||
      !stringOrNull(item["due"]) ||
      !stringOrNull(item["dueText"])
    ) {
      return null;
    }
    commitments.push({
      kind,
      who: item["who"],
      to: item["to"],
      what: item["what"],
      due: item["due"],
      dueText: item["dueText"],
      cite: item["cite"],
    });
  }
  return { journal, commitments };
}

const PLACEHOLDER = /\{([^{}]*)\}/g;
const BARE_REF = /(?<![{\w])P(\d{1,2})(?![}\w])/g;

/** The text with every voice as a known `{Pn}`, or null when it names one we do not know. */
function voicesIn(text: string, refs: ReadonlyMap<string, string>): string | null {
  // A model that wrote "P2" without braces meant the voice.
  const braced = text.replace(BARE_REF, (match, n: string) =>
    refs.has(`P${n}`) ? `{P${n}}` : match,
  );
  for (const [, inner] of braced.matchAll(PLACEHOLDER)) {
    if (inner === undefined || !refs.has(inner)) return null;
  }
  return braced;
}

function validDate(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
const key = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}{}]+/gu, " ")
    .trim();

/** Objects that name nothing: « quelque chose », « des trucs », "stuff". */
const EMPTY_OBJECTS: ReadonlySet<string> = new Set([
  "quelque",
  "chose",
  "truc",
  "trucs",
  "tache",
  "taches",
  "something",
  "stuff",
  "things",
  "tasks",
]);

/** Words around them that add nothing: articles, pronouns, « demandées ». */
const FILLERS: ReadonlySet<string> = new Set([
  "le",
  "la",
  "les",
  "un",
  "une",
  "des",
  "ca",
  "cela",
  "demandee",
  "demandees",
  "the",
  "some",
  "it",
  "that",
  "this",
  "asked",
]);

/** Verbs that say nothing with only a pronoun after them: « faire ça », "do it". */
const EMPTY_VERBS: ReadonlySet<string> = new Set(["faire", "do"]);

/**
 * An action that says nothing to do: « faire quelque chose », « faire des
 * trucs », « faire ça », "do it". A concrete verb keeps its pronoun
 * (« envoyer ça », « rappeler {P2} »), and a verb alone is an action.
 */
export function isVagueAction(what: string): boolean {
  const [verb, ...rest] = key(what)
    .split(" ")
    .filter((word) => word !== "");
  if (verb === undefined || rest.length === 0) return false;
  if (!rest.every((word) => EMPTY_OBJECTS.has(word) || FILLERS.has(word))) return false;
  return EMPTY_VERBS.has(verb) || rest.some((word) => EMPTY_OBJECTS.has(word));
}

/** Reads one answer of `request`; its items cite segment ids. */
export function readJournalAnswer(request: JournalRequest, text: string): JournalAnswer {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "not-json" };
  }
  const answer = shapeOf(json);
  if (answer === null) return { ok: false, error: "bad-shape" };
  const dropped: Partial<Record<DropReason, number>> = {};
  const setAside: Partial<Record<SetAsideKind, number>> = {};
  const drop = (reason: DropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const lines = request.lineSegments.length;
  /** Every cited line must exist; one beyond the overlap at least. */
  const cited = (cite: readonly number[]): number[] | DropReason => {
    if (cite.length === 0) return "bad-cite";
    const unique = [...new Set(cite)];
    if (unique.some((n) => !Number.isInteger(n) || n < 1 || n > lines)) return "bad-cite";
    if (unique.every((n) => n <= request.contextLines)) return "context-only";
    return unique.toSorted((a, b) => a - b).map((n) => request.lineSegments[n - 1] ?? -1);
  };
  const items: JournalDraft[] = [];
  const seen = new Set<string>();
  for (const event of answer.journal) {
    const body = tidy(event.text);
    if (body === "") {
      drop("empty");
      continue;
    }
    if (body.length > MAX_TEXT_CHARS) {
      drop("too-long");
      continue;
    }
    const withVoices = voicesIn(body, request.refs);
    if (withVoices === null) {
      drop("bad-voice");
      continue;
    }
    const segments = cited(event.cite);
    if (typeof segments === "string") {
      drop(segments);
      continue;
    }
    const id = `e:${key(withVoices)}`;
    if (seen.has(id)) {
      drop("duplicate");
      continue;
    }
    seen.add(id);
    items.push({ kind: "event", text: withVoices, segmentIds: segments });
  }
  for (const commitment of answer.commitments) {
    // Set aside by the model itself: not a commitment.
    const { kind } = commitment;
    if (kind !== "promise" && kind !== "accepted") {
      setAside[kind] = (setAside[kind] ?? 0) + 1;
      continue;
    }
    const what = tidy(commitment.what);
    if (what === "") {
      drop("empty");
      continue;
    }
    if (isVagueAction(what)) {
      drop("vague");
      continue;
    }
    if (what.length > MAX_WHAT_CHARS) {
      drop("too-long");
      continue;
    }
    const withVoices = voicesIn(what, request.refs);
    const who = commitment.who;
    const to = commitment.to === who ? null : commitment.to;
    if (
      withVoices === null ||
      (who !== null && !request.refs.has(who)) ||
      (to !== null && !request.refs.has(to))
    ) {
      drop("bad-voice");
      continue;
    }
    const segments = cited(commitment.cite);
    if (typeof segments === "string") {
      drop(segments);
      continue;
    }
    const id = `c:${who ?? ""}:${key(withVoices)}`;
    if (seen.has(id)) {
      drop("duplicate");
      continue;
    }
    seen.add(id);
    const dueText = commitment.dueText === null ? null : tidy(commitment.dueText).slice(0, 40);
    items.push({
      kind: "commitment",
      text: withVoices,
      who,
      to,
      due: validDate(commitment.due),
      dueText: dueText === "" ? null : dueText,
      segmentIds: segments,
    });
  }
  return { ok: true, items, dropped, setAside };
}

/**
 * The windows' items as one list: an item a later window repeats is kept
 * once. A repeat has the same kind and voice, and the same words or, for a
 * commitment citing the same first sentence (the windows' overlap), close
 * words. Two commitments of one sentence ("I'll send it and call him") stay.
 */
export function mergeWindowItems(windows: readonly (readonly JournalDraft[])[]): JournalDraft[] {
  const out: JournalDraft[] = [];
  for (const items of windows) {
    for (const item of items) {
      const repeat = out.some((kept) => {
        if (kept.kind !== item.kind) return false;
        if (key(kept.text) === key(item.text)) {
          return kept.kind === "event" || (item.kind === "commitment" && kept.who === item.who);
        }
        return (
          kept.kind === "commitment" &&
          item.kind === "commitment" &&
          kept.who === item.who &&
          kept.segmentIds[0] === item.segmentIds[0] &&
          journalTextSimilarity(kept.text, item.text) >= 0.5
        );
      });
      if (!repeat) out.push(item);
    }
  }
  return out;
}

const wordsOf = (text: string) =>
  new Set(
    key(text)
      .split(" ")
      .filter((word) => word !== ""),
  );

/** A stored text with its voices named: `{P2}` becomes what `name` gives for that ref. */
export function renderVoices(text: string, name: (ref: string) => string): string {
  return text.replace(PLACEHOLDER, (match, inner: string) =>
    /^P\d+$/.test(inner) ? name(inner) : match,
  );
}

/** Shared words over all words (0 to 1), accents, case and punctuation aside. */
export function journalTextSimilarity(a: string, b: string): number {
  const words = wordsOf;
  const left = words(a);
  const right = words(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}
