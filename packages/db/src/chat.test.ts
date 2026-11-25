import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addChatMessage,
  chatChoice,
  chatDiscussion,
  chatDiscussionsReading,
  chatEnabled,
  chatMessages,
  chatReadCount,
  createChatDiscussion,
  deleteChatDiscussion,
  finishChatMessage,
  listChatDiscussions,
  recordChatReads,
  setChatChoice,
  setChatDiscussionChoice,
  setChatDiscussionLimited,
  setChatEnabled,
  settleInterruptedChatMessages,
  staleChatDiscussions,
} from "./chat";
import { bumpInputGeneration } from "./publish";
import {
  count,
  seedEpisode,
  seedTrackRun,
  t0,
  tempDatabase,
  type TempDatabase,
} from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const discussion = (title = "Quand rappeler ?") =>
  createChatDiscussion(temp.db, {
    title,
    provider: "claude",
    model: "opus",
    effort: "high",
    nowMs: t0,
  });

const person = (name: string) =>
  Number(
    temp.db.client
      .prepare("INSERT INTO people (name, created_at_ms, updated_at_ms) VALUES (?, 0, 0)")
      .run(name).lastInsertRowid,
  );

const item = (trackRunId: number) =>
  Number(
    temp.db.client
      .prepare(
        `INSERT INTO context_items (kind, track_run_id, anchor_sample, body, origin, created_at_ms, updated_at_ms)
         VALUES ('note', ?, 0, 'devis à 1 200 €', 'app', 0, 0)`,
      )
      .run(trackRunId).lastInsertRowid,
  );

describe("chat settings", () => {
  it("is off until the user turns it on", () => {
    expect(chatEnabled(temp.db)).toBe(false);
    setChatEnabled(temp.db, true, t0);
    expect(chatEnabled(temp.db)).toBe(true);
    setChatEnabled(temp.db, false, t0 + 1);
    expect(chatEnabled(temp.db)).toBe(false);
  });

  it("keeps the last choice of provider, model and effort", () => {
    expect(chatChoice(temp.db)).toBeNull();
    setChatChoice(temp.db, { provider: "claude", model: "opus", effort: "high" }, t0);
    expect(chatChoice(temp.db)).toEqual({ provider: "claude", model: "opus", effort: "high" });
    setChatChoice(temp.db, { provider: "claude", model: "haiku", effort: null }, t0 + 1);
    expect(chatChoice(temp.db)).toEqual({ provider: "claude", model: "haiku", effort: null });
  });
});

describe("chat discussions", () => {
  it("keeps the focus a discussion started on and its limit (ADR 037)", () => {
    const id = createChatDiscussion(temp.db, {
      title: "Résume",
      provider: "claude",
      model: "opus",
      effort: null,
      nowMs: t0,
      focus: { kind: "episode", episodeId: 7 },
      limited: true,
    });
    expect(chatDiscussion(temp.db, id)).toMatchObject({
      focus: { kind: "episode", episodeId: 7 },
      limited: true,
    });
    expect(setChatDiscussionLimited(temp.db, id, false)).toBe(true);
    expect(chatDiscussion(temp.db, id)?.limited).toBe(false);
    // An older discussion reads everything.
    expect(chatDiscussion(temp.db, discussion())).toMatchObject({ focus: null, limited: false });
    expect(setChatDiscussionLimited(temp.db, 999, true)).toBe(false);
  });

  it("keeps a discussion's messages in order, newest discussion first", () => {
    const first = discussion("Premier");
    const second = discussion("Second");
    addChatMessage(temp.db, {
      discussionId: first,
      role: "user",
      text: "Un",
      atMs: t0 + 10,
      streaming: false,
    });
    const answer = addChatMessage(temp.db, {
      discussionId: first,
      role: "agent",
      text: "",
      atMs: t0 + 10,
      streaming: true,
    });
    finishChatMessage(temp.db, answer, {
      text: "Jeudi.",
      tools: [{ id: "t1", tool: "search_transcripts" }],
      stopped: false,
      failure: null,
    });
    expect(listChatDiscussions(temp.db).map((d) => d.id)).toEqual([first, second]);
    expect(chatMessages(temp.db, first)).toEqual([
      expect.objectContaining({ role: "user", text: "Un", streaming: false }),
      {
        id: answer,
        role: "agent",
        text: "Jeudi.",
        atMs: t0 + 10,
        tools: [{ id: "t1", tool: "search_transcripts" }],
        streaming: false,
        stopped: false,
        failure: null,
      },
    ]);
    setChatDiscussionChoice(
      temp.db,
      first,
      { provider: "claude", model: "haiku", effort: null },
      t0 + 20,
    );
    expect(chatDiscussion(temp.db, first)).toMatchObject({
      model: "haiku",
      effort: null,
      updatedAtMs: t0 + 20,
    });
  });

  it("marks answers a stopped core left streaming as stopped", () => {
    const id = discussion();
    const answer = addChatMessage(temp.db, {
      discussionId: id,
      role: "agent",
      text: "",
      atMs: t0,
      streaming: true,
    });
    expect(settleInterruptedChatMessages(temp.db)).toBe(1);
    expect(chatMessages(temp.db, id)).toEqual([
      expect.objectContaining({ id: answer, streaming: false, stopped: true }),
    ]);
  });

  it("deletes a discussion with its messages and reads", () => {
    const id = discussion();
    const { episodeId } = seedEpisode(temp.db);
    addChatMessage(temp.db, {
      discussionId: id,
      role: "user",
      text: "Un",
      atMs: t0,
      streaming: false,
    });
    recordChatReads(temp.db, id, { episodes: [episodeId], people: [], items: [] });
    expect(deleteChatDiscussion(temp.db, id)).toBe(true);
    expect(count(temp.db, "chat_messages")).toBe(0);
    expect(count(temp.db, "chat_reads")).toBe(0);
    expect(deleteChatDiscussion(temp.db, id)).toBe(false);
  });

  it("finds the discussions that read something since deleted or changed, and only them", () => {
    const trackRunId = seedTrackRun(temp.db);
    const kept = seedEpisode(temp.db, [[10, 20]], trackRunId).episodeId;
    const passage = seedEpisode(temp.db, [[30, 40]], trackRunId).episodeId;
    const gone = seedEpisode(temp.db, [[50, 60]], trackRunId).episodeId;
    const marie = person("Marie");
    const note = item(trackRunId);

    const readsKept = discussion("Garde");
    const readsPassage = discussion("Passage");
    const readsGone = discussion("Supprimé");
    const readsMarie = discussion("Marie");
    const readsNote = discussion("Note");
    const readsNothing = discussion("Rien");
    recordChatReads(temp.db, readsKept, { episodes: [kept], people: [], items: [] });
    recordChatReads(temp.db, readsPassage, { episodes: [kept, passage], people: [], items: [] });
    recordChatReads(temp.db, readsGone, { episodes: [gone, 999], people: [], items: [] });
    recordChatReads(temp.db, readsMarie, { episodes: [], people: [marie], items: [] });
    recordChatReads(temp.db, readsNote, { episodes: [], people: [], items: [note] });
    // Ids that do not exist are not recorded (nothing of them was read).
    expect(chatReadCount(temp.db, readsGone)).toBe(1);
    expect(staleChatDiscussions(temp.db)).toEqual([]);

    bumpInputGeneration(temp.db, passage, t0 + 1);
    temp.db.client.prepare("DELETE FROM episodes WHERE id = ?").run(gone);
    temp.db.client.prepare("DELETE FROM people WHERE id = ?").run(marie);
    temp.db.client.prepare("DELETE FROM context_items WHERE id = ?").run(note);
    expect(staleChatDiscussions(temp.db)).toEqual([readsPassage, readsGone, readsMarie, readsNote]);
    expect(staleChatDiscussions(temp.db)).not.toContain(readsKept);
    expect(staleChatDiscussions(temp.db)).not.toContain(readsNothing);

    // Reading the changed episode again does not make the earlier answers fresh.
    recordChatReads(temp.db, readsPassage, { episodes: [passage], people: [], items: [] });
    expect(staleChatDiscussions(temp.db)).toContain(readsPassage);
    expect(chatDiscussionsReading(temp.db, [kept, 999])).toEqual([readsKept, readsPassage]);
  });
});
