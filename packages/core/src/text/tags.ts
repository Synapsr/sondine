// A tag's name and key (ADR 039), the same rule in Swift (`TagName` in
// native/Sources/SondinePhone), checked by both against
// packages/protocol/fixtures/vectors/tag-names.jsonl. A name is the user's spelling,
// cleaned; its key is what makes two names one tag: « Idées » and « idees ».

/** Longest name, in characters as people count them (grapheme clusters)… */
export const TAG_NAME_MAX = 40;
/** …and in UTF-16 code units, what the wire and zod count (a family emoji is 11). */
export const TAG_NAME_MAX_UNITS = 200;
/** Most tags on one recording. */
export const TAGS_PER_RECORDING_MAX = 20;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The name as kept: Unicode NFC, control characters and leading « # »
 * removed, spaces trimmed and collapsed (JavaScript's `\s`, the byte order
 * mark included). Null when nothing is left, or it is longer than
 * `TAG_NAME_MAX` characters or `TAG_NAME_MAX_UNITS` code units.
 */
export function tagName(typed: string): string | null {
  const name = typed
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^#+\s*/u, "");
  if (name === "" || name.length > TAG_NAME_MAX_UNITS) return null;
  let count = 0;
  for (const _ of segmenter.segment(name)) {
    count += 1;
    if (count > TAG_NAME_MAX) return null;
  }
  return name;
}

/** Two names with the same key are one tag: lower case, without accents. */
export function tagKey(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}
