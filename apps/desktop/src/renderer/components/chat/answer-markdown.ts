// The small Markdown an agent's answer may use (ADR 027): paragraphs,
// bullet and numbered lists, bold, italic, inline code and links. Nothing is
// ever parsed as HTML. A link opens in Sondine only when it names one of its
// conversations (`sondine://episode/<id>?t=<ms>`); any other link stays text
// with its address beside it, so the window never loads anything.

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly Inline[] }
  | { readonly kind: "em"; readonly children: readonly Inline[] }
  | { readonly kind: "code"; readonly text: string }
  | {
      readonly kind: "episode";
      readonly episodeId: number;
      readonly atMs: number | null;
      readonly children: readonly Inline[];
    }
  | { readonly kind: "link"; readonly url: string; readonly children: readonly Inline[] };

export type Block =
  | { readonly kind: "paragraph"; readonly lines: readonly (readonly Inline[])[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly (readonly Inline[])[];
    };

const EPISODE_LINK = /^sondine:\/\/episode\/(\d{1,12})(?:\?t=(\d{1,15}))?$/u;
const BULLET = /^\s{0,3}[-*•]\s+(.*)$/u;
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/u;
/** A heading's marks; the heading reads as a bold line. */
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/u;

/** A Sondine conversation a link names, or null. */
export function episodeTarget(url: string): { episodeId: number; atMs: number | null } | null {
  const match = EPISODE_LINK.exec(url.trim());
  if (match === null) return null;
  const episodeId = Number(match[1]);
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) return null;
  return { episodeId, atMs: match[2] === undefined ? null : Number(match[2]) };
}

/** Finds the closing `marker` of a span starting at `from`, on the same text. */
function closing(text: string, marker: string, from: number): number {
  const end = text.indexOf(marker, from);
  return end > from ? end : -1;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") out.push({ kind: "text", text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("`")) {
      const end = closing(text, "`", i + 1);
      if (end !== -1) {
        flush();
        out.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      const end = closing(text, marker, i + 2);
      if (end !== -1) {
        flush();
        out.push({ kind: "strong", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((rest.startsWith("*") || rest.startsWith("_")) && !/^[*_]\s/u.test(rest)) {
      const marker = rest[0]!;
      const end = closing(text, marker, i + 1);
      // A lone `_` inside a word (snake_case) is not emphasis.
      const inWord = marker === "_" && i > 0 && /\w/u.test(text[i - 1]!);
      if (end !== -1 && !inWord) {
        flush();
        out.push({ kind: "em", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("[")) {
      const labelEnd = closing(text, "](", i + 1);
      const urlEnd = labelEnd === -1 ? -1 : closing(text, ")", labelEnd + 2);
      if (labelEnd !== -1 && urlEnd !== -1) {
        const label = parseInline(text.slice(i + 1, labelEnd));
        const url = text.slice(labelEnd + 2, urlEnd).trim();
        flush();
        const target = episodeTarget(url);
        out.push(
          target === null
            ? { kind: "link", url, children: label }
            : { kind: "episode", ...target, children: label },
        );
        i = urlEnd + 1;
        continue;
      }
    }
    plain += text[i];
    i += 1;
  }
  flush();
  return out;
}

export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: Inline[][] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const end = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", lines: paragraph });
    if (list !== null) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    paragraph = [];
    list = null;
  };
  for (const raw of text.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      end();
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    const item = bullet ?? numbered;
    if (item !== null) {
      const ordered = numbered !== null;
      if (list === null || list.ordered !== ordered) {
        end();
        list = { ordered, items: [] };
      }
      list.items.push(parseInline(item[1] ?? ""));
      continue;
    }
    if (list !== null) end();
    const heading = HEADING.exec(line);
    paragraph.push(
      heading === null
        ? parseInline(line)
        : [{ kind: "strong", children: parseInline(heading[1] ?? "") }],
    );
  }
  end();
  return blocks;
}
