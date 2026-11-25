import { agentTools, type AgentTool } from "@sondine/api";
import { describe, expect, it } from "vitest";
import {
  readsOf,
  agentOutput,
  CONTEXT_NOTE_CHARS,
  fitText,
  MAX_FILE_CHARS,
  MAX_IMAGE_CHARS,
  MAX_RESULT_CHARS,
} from "./agent-tools";

const tool = (name: string): AgentTool => {
  const found = agentTools().find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(name);
  return found;
};

const item = (text: string, preview: string | null) => ({
  id: 1,
  kind: preview === null ? "note" : "image",
  text,
  title: null,
  file: preview === null ? null : { mediaType: "image/heic", bytes: 10, preview },
});

describe("agent output", () => {
  it("cuts long notes in get_episode and drops the window's preview address", () => {
    const { json, attachment } = agentOutput(tool("get_episode"), {
      context: [item("n".repeat(CONTEXT_NOTE_CHARS + 5), null), item("", "sondine-media://x")],
    });
    expect(attachment).toBeNull();
    const [note, picture] = (json as { context: Record<string, unknown>[] }).context;
    expect(note?.["textTruncated"]).toBe(true);
    expect(String(note?.["text"]).length).toBe(CONTEXT_NOTE_CHARS + 1);
    expect(JSON.stringify(picture)).not.toContain("sondine-media");
  });

  it("sends get_context_item's image apart from its JSON, within its budget", () => {
    const output = {
      episodeId: 4,
      item: item("", "sondine-media://context/1?v=0123456789abcdef"),
      content: null,
      image: { mediaType: "image/jpeg", data: "AAAA" },
      file: null,
    };
    const { json, attachment } = agentOutput(tool("get_context_item"), output);
    expect(attachment).toEqual({ kind: "image", data: "AAAA", mimeType: "image/jpeg" });
    expect(JSON.stringify(json)).not.toContain("AAAA");
    expect(JSON.stringify(json)).not.toContain("sondine-media");
    const huge = {
      ...output,
      image: { mediaType: "image/jpeg", data: "A".repeat(MAX_IMAGE_CHARS + 1) },
    };
    expect(agentOutput(tool("get_context_item"), huge).attachment).toBeNull();
  });

  it("sends any other file as it is, as an embedded resource, within its budget", () => {
    const output = {
      episodeId: 4,
      item: { id: 2, kind: "file", text: "", title: "plan.pdf", file: null },
      content: null,
      image: null,
      file: { mediaType: "application/pdf", data: "JVBERi0=" },
    };
    const { json, attachment } = agentOutput(tool("get_context_item"), output);
    expect(attachment).toEqual({
      kind: "resource",
      data: "JVBERi0=",
      mimeType: "application/pdf",
    });
    expect(json).toMatchObject({ fileSentAs: "embedded resource" });
    expect(JSON.stringify(json)).not.toContain("JVBERi0=");
    const huge = {
      ...output,
      file: { mediaType: "application/pdf", data: "A".repeat(MAX_FILE_CHARS + 1) },
    };
    expect(agentOutput(tool("get_context_item"), huge).attachment).toBeNull();
  });
});

describe("text files for agents", () => {
  it("cuts a text file's text until the result fits, escaping included", () => {
    const output = {
      episodeId: 4,
      item: item("", null),
      content: { text: '"\n'.repeat(60_000), truncated: false },
      image: null,
    };
    const body = fitText(output, JSON.stringify);
    expect(body.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const parsed = JSON.parse(body) as { content: { text: string; truncated: boolean } };
    expect(parsed.content.truncated).toBe(true);
    expect(parsed.content.text.length).toBeGreaterThan(10_000);
    // Short text is left alone.
    const short = { ...output, content: { text: "court", truncated: false } };
    expect(fitText(short, JSON.stringify)).toBe(JSON.stringify(short));
  });
});

describe("what an answer carries of Sondine", () => {
  it("finds episodes, people and items of context by their shape, wherever they sit", () => {
    const summary = (id: number, people: { id: number; name: string }[] = []) => ({
      id,
      state: "closed",
      startedAtMs: 1,
      people,
    });
    const search = {
      episodes: [
        {
          episode: summary(4, [{ id: 9, name: "Marie" }]),
          hits: [{ segmentId: 1 }],
          contextHits: [{ itemId: 30, kind: "note" }],
        },
      ],
      total: 1,
    };
    expect(readsOf(search)).toEqual({ episodes: [4], people: [9], items: [30] });
    const day = {
      momentHours: [{ previews: [{ episodeId: 5, firstWords: "bonjour" }] }],
      ongoing: [summary(6)],
    };
    expect(readsOf(day)).toEqual({ episodes: [5, 6], people: [], items: [] });
    const episode = {
      episode: summary(7),
      speakers: [{ label: "S1", person: { id: 11, name: "Paul" } }],
      context: [{ id: 31, kind: "note", addedAtMs: 1, text: "devis" }],
    };
    expect(readsOf(episode)).toEqual({ episodes: [7], people: [11], items: [31] });
    // A journal's items are not items of context; its citations name episodes.
    const journal = {
      conversations: [
        {
          episodeId: 8,
          lines: [{ itemId: 31, kind: "event", citations: [{ episodeId: 9, segmentId: 2 }] }],
        },
      ],
    };
    expect(readsOf(journal)).toEqual({ episodes: [8, 9], people: [], items: [] });
    expect(readsOf({ summary: { person: { id: 12, name: "Léa" } }, episodes: [] })).toEqual({
      episodes: [],
      people: [12],
      items: [],
    });
    expect(readsOf(null)).toEqual({ episodes: [], people: [], items: [] });
  });
});
