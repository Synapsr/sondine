import type { TextRange } from "@sondine/api";

// Search highlights come as UTF-16 ranges over the original text (ADR 016,
// Search); this cuts the text into plain and matched parts to render.

export interface TextPart {
  readonly text: string;
  readonly match: boolean;
}

/**
 * A matched word: the accent at 35% reads in both modes (the theme's 20% mix
 * is near black on a dark canvas). The current match is the full accent with
 * black text, legible on that orange in both modes.
 */
export const matchClassName =
  "corner-xs bg-[color-mix(in_srgb,var(--color-1)_35%,transparent)] text-cte-text";
export const currentMatchClassName =
  "corner-xs bg-color-1 text-[color:light-dark(var(--neutral-10),var(--neutral-1))]";

/** `text` in order, matched parts flagged; ranges outside the text are clamped. */
export function highlightParts(text: string, ranges: readonly TextRange[]): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const range of ranges) {
    const start = Math.min(Math.max(range.start, at), text.length);
    const end = Math.min(Math.max(range.end, start), text.length);
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    if (end > start) parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
