import { describe, expect, it } from "vitest";
import { episodeTarget, parseAnswer, parseInline } from "./answer-markdown";

describe("answer markdown", () => {
  it("reads bold, italic, code and plain text, never HTML", () => {
    expect(parseInline("Un **devis** à *revoir* avec `curl` <img src=x>")).toEqual([
      { kind: "text", text: "Un " },
      { kind: "strong", children: [{ kind: "text", text: "devis" }] },
      { kind: "text", text: " à " },
      { kind: "em", children: [{ kind: "text", text: "revoir" }] },
      { kind: "text", text: " avec " },
      { kind: "code", text: "curl" },
      { kind: "text", text: " <img src=x>" },
    ]);
    // snake_case stays a word.
    expect(parseInline("search_transcripts")).toEqual([
      { kind: "text", text: "search_transcripts" },
    ]);
  });

  it("opens only Sondine's conversations; any other link stays text", () => {
    expect(parseInline("[10:05](sondine://episode/42?t=1794222300000)")).toEqual([
      {
        kind: "episode",
        episodeId: 42,
        atMs: 1794222300000,
        children: [{ kind: "text", text: "10:05" }],
      },
    ]);
    expect(parseInline("[site](https://example.com)")).toEqual([
      { kind: "link", url: "https://example.com", children: [{ kind: "text", text: "site" }] },
    ]);
    expect(episodeTarget("sondine://episode/0")).toBeNull();
    expect(episodeTarget("sondine://episode/7")).toEqual({ episodeId: 7, atMs: null });
    expect(episodeTarget("javascript:alert(1)")).toBeNull();
  });

  it("groups lines into paragraphs and lists, and reads a heading as a bold line", () => {
    const blocks = parseAnswer("### Jeudi\nOn se rappelle.\n\n- un\n- deux\n1. premier\n\nFin");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "list", "list", "paragraph"]);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      lines: [
        [{ kind: "strong", children: [{ kind: "text", text: "Jeudi" }] }],
        [{ kind: "text", text: "On se rappelle." }],
      ],
    });
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: false });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: true });
  });
});
