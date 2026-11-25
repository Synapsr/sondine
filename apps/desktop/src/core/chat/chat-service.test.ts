import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatView } from "@sondine/api";
import { chatChoice, chatReadCount, openDatabase, type OpenedDatabase } from "@sondine/db";
import type {
  AssistantListener,
  AssistantProvider,
  AssistantSessionOptions,
  AssistantStatus,
} from "@sondine/engines";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationsDir, tempDataDir, type TempDataDir } from "../../../test/support";
import { makeChatKeys, type ChatKeysService } from "./chat-keys";
import {
  makeChatService,
  MAX_LIVE_SESSIONS,
  prepareWorkDirectory,
  type ChatService,
} from "./chat-service";

// The discussion service against a scripted provider: what Téo sees, what
// the provider is given, and what ends when.

const READY: AssistantStatus = {
  provider: "claude",
  state: "ready",
  executable: "/A/claude",
  version: "2.1.400",
  home: "/Users/t/.claude",
  account: { email: "t@example.com", plan: "Claude Max", billing: "subscription" },
  models: [
    {
      id: "default",
      name: "Default",
      description: null,
      efforts: ["low", "high"],
      defaultEffort: "high",
      isDefault: true,
    },
    {
      id: "haiku",
      name: "Haiku",
      description: null,
      efforts: [],
      defaultEffort: null,
      isDefault: false,
    },
  ],
  problem: null,
};

interface FakeSession {
  readonly options: AssistantSessionOptions;
  readonly listener: AssistantListener;
  readonly sent: string[];
  closed: boolean;
  interrupted: boolean;
}

let data: TempDataDir;
let db: OpenedDatabase;
let keys: ChatKeysService;
let service: ChatService;
let sessions: FakeSession[];
let detections: number;
/** When set, `open` throws (a CLI that cannot start). */
let openFails: boolean;

function fakeProvider(): AssistantProvider {
  return {
    id: "claude",
    detect: async () => {
      detections += 1;
      return READY;
    },
    open(options, listener) {
      if (openFails) throw new Error("spawn failed");
      const session: FakeSession = {
        options,
        listener,
        sent: [],
        closed: false,
        interrupted: false,
      };
      sessions.push(session);
      return {
        send: (text) => void session.sent.push(text),
        interrupt: () => {
          session.interrupted = true;
          listener({ type: "turn-ended", reason: "interrupted" });
        },
        close: async () => {
          session.closed = true;
        },
        running: () => false,
      };
    },
  };
}

beforeEach(() => {
  data = tempDataDir();
  db = openDatabase(join(data.dir, "sondine.db"), { migrationsFolder: migrationsDir });
  keys = makeChatKeys(false);
  // The host is not running in these tests: say the socket listens.
  keys.setListening(true);
  sessions = [];
  detections = 0;
  openFails = false;
  const workDirectory = join(data.dir, "chat");
  prepareWorkDirectory(workDirectory);
  service = makeChatService({
    db,
    keys,
    providers: [fakeProvider()],
    relay: { command: "/A/sondine-mcp", args: ["--socket", "/tmp/mcp.sock"] },
    workDirectory,
    instructions: () => "instructions",
  });
});

afterEach(async () => {
  await service.close();
  db.close();
  data.cleanup();
});

const choice = { provider: "claude" as const, model: "default", effort: "low" };

async function viewOf(discussionId: number | null): Promise<ChatView> {
  const controller = new AbortController();
  for await (const view of service.watch(discussionId, controller.signal)) {
    controller.abort();
    return view;
  }
  throw new Error("no view");
}

describe("chat service", () => {
  it("asks no CLI and refuses messages while discussions are off", async () => {
    expect(await service.status(undefined)).toEqual({
      enabled: false,
      providers: null,
      choice: null,
      canRead: true,
    });
    expect(detections).toBe(0);
    await expect(service.send({ discussionId: null, text: "Bonjour", choice })).rejects.toThrow(
      "Discussions are off.",
    );
  });

  it("streams an answer, with Sondine's tools behind a key of the discussion's own", async () => {
    const status = await service.setEnabled(true);
    expect(status.providers?.[0]).toMatchObject({
      id: "claude",
      state: "ready",
      home: "/Users/t/.claude",
    });
    const { discussionId } = await service.send({
      discussionId: null,
      text: "Quand rappeler ?",
      choice,
    });
    const [session] = sessions;
    if (session === undefined) throw new Error("no session");
    expect(session.options).toMatchObject({
      model: "default",
      effort: "low",
      instructions: "instructions",
    });
    expect(session.options.tools?.server).toMatchObject({
      name: "sondine",
      command: "/A/sondine-mcp",
      args: ["--socket", "/tmp/mcp.sock"],
    });
    expect(session.options.tools?.server.env["SONDINE_TOKEN"]).toMatch(/^sdc_/u);
    expect(keys.count()).toBe(1);
    expect(existsSync(session.options.workingDirectory)).toBe(true);
    expect(session.sent).toEqual(["Quand rappeler ?"]);
    // The last choice is kept for next time.
    expect(chatChoice(db)).toEqual(choice);

    session.listener({
      type: "tool-started",
      callId: "t1",
      tool: "search_transcripts",
      input: { text: "rappeler" },
    });
    session.listener({ type: "text", delta: "Jeudi " });
    session.listener({ type: "text", delta: "[10:05](sondine://episode/4?t=1)." });
    session.listener({ type: "tool-ended", callId: "t1", ok: true });
    session.listener({ type: "turn-ended", reason: "complete" });

    const view = await viewOf(discussionId);
    expect(view.discussions).toMatchObject([
      { id: discussionId, title: "Quand rappeler ?", running: false },
    ]);
    expect(view.discussion?.messages.map((m) => [m.role, m.text, m.streaming])).toEqual([
      ["user", "Quand rappeler ?", false],
      ["agent", "Jeudi [10:05](sondine://episode/4?t=1).", false],
    ]);
    expect(view.discussion?.messages[1]?.tools).toEqual([
      {
        id: "t1",
        tool: "search_transcripts",
        state: "done",
        query: "rappeler",
        episodeId: null,
        personId: null,
        itemId: null,
        day: null,
        results: null,
      },
    ]);
  });

  it("starts a new session with what was said when the model changes", async () => {
    await service.setEnabled(true);
    const { discussionId } = await service.send({ discussionId: null, text: "Premier", choice });
    sessions[0]!.listener({ type: "text", delta: "Réponse" });
    sessions[0]!.listener({ type: "turn-ended", reason: "complete" });
    await service.send({
      discussionId,
      text: "Second",
      choice: { ...choice, model: "haiku", effort: "high" },
    });
    expect(sessions[0]!.closed).toBe(true);
    expect(sessions[1]!.options.model).toBe("haiku");
    // Haiku takes no effort: the choice is cleaned.
    expect(sessions[1]!.options.effort).toBeNull();
    expect(sessions[1]!.sent[0]).toContain("User: Premier\nYou: Réponse");
    expect(sessions[1]!.sent[0]?.endsWith("Second")).toBe(true);
    expect(keys.count()).toBe(1);
  });

  it("refuses a second message while the agent answers, and stops on request", async () => {
    await service.setEnabled(true);
    const { discussionId } = await service.send({ discussionId: null, text: "Un", choice });
    await expect(service.send({ discussionId, text: "Deux", choice })).rejects.toThrow(
      "still answering",
    );
    await service.stop(discussionId);
    expect(sessions[0]!.interrupted).toBe(true);
    const view = await viewOf(discussionId);
    expect(view.discussion?.messages[1]).toMatchObject({ stopped: true, streaming: false });
  });

  it("erases the discussions that read what is deleted, and only them", async () => {
    await service.setEnabled(true);
    const episode = Number(
      db.client
        .prepare(
          `INSERT INTO episodes (state, started_at_ms, grouping_version, classifier_version, created_at_ms, updated_at_ms)
           VALUES ('closed', 1, 'g', 'c', 0, 0)`,
        )
        .run().lastInsertRowid,
    );
    const marie = Number(
      db.client
        .prepare("INSERT INTO people (name, created_at_ms, updated_at_ms) VALUES ('Marie', 0, 0)")
        .run().lastInsertRowid,
    );
    const readEpisode = await service.send({ discussionId: null, text: "Lis", choice });
    const readMarie = await service.send({ discussionId: null, text: "Marie ?", choice });
    const asked = await service.send({ discussionId: null, text: "Juste l'état", choice });
    const keyOf = (n: number) =>
      createHash("sha256")
        .update(sessions[n]!.options.tools!.server.env["SONDINE_TOKEN"]!)
        .digest();
    const call = (n: number, tool: string, reads: { episodes?: number[]; people?: number[] }) =>
      keys.lookup(keyOf(n))?.onCall({
        tool,
        outcome: "ok",
        detail: {},
        reads: { episodes: reads.episodes ?? [], people: reads.people ?? [], items: [] },
      });
    call(0, "search_transcripts", { episodes: [episode] });
    call(1, "get_person", { people: [marie] });
    call(2, "get_status", {});
    const episodeKey = keyOf(0);

    // Nothing they read was deleted: all stay.
    service.deleted();
    expect((await viewOf(null)).discussions).toHaveLength(3);

    db.client.prepare("DELETE FROM episodes WHERE id = ?").run(episode);
    service.deleted();
    let view = await viewOf(readEpisode.discussionId);
    expect(view.discussion).toBeNull();
    expect(view.discussions.map((d) => d.id).toSorted()).toEqual(
      [readMarie.discussionId, asked.discussionId].toSorted(),
    );
    expect(view.erased).toBe(1);
    expect(sessions[0]!.closed).toBe(true);
    // Its key is gone with it, and its words are gone from the database.
    expect(keys.lookup(episodeKey)).toBeNull();
    expect(
      db.client.prepare("SELECT count(*) AS n FROM chat_messages WHERE text = 'Lis'").get(),
    ).toEqual({ n: 0 });

    db.client.prepare("DELETE FROM people WHERE id = ?").run(marie);
    service.deleted();
    view = await viewOf(null);
    expect(view.discussions.map((d) => d.id)).toEqual([asked.discussionId]);
    expect(view.erased).toBe(2);
  });

  it("erases the discussions that read a person's episodes when that person goes, and catches up at start", async () => {
    await service.setEnabled(true);
    const episode = Number(
      db.client
        .prepare(
          `INSERT INTO episodes (state, started_at_ms, grouping_version, classifier_version, created_at_ms, updated_at_ms)
           VALUES ('closed', 1, 'g', 'c', 0, 0)`,
        )
        .run().lastInsertRowid,
    );
    const journal = await service.send({ discussionId: null, text: "Journal ?", choice });
    const other = await service.send({ discussionId: null, text: "Autre", choice });
    const keyOf = (n: number) =>
      createHash("sha256")
        .update(sessions[n]!.options.tools!.server.env["SONDINE_TOKEN"]!)
        .digest();
    // A journal names voices without ids: only its episodes are known.
    keys.lookup(keyOf(0))?.onCall({
      tool: "get_journal",
      outcome: "ok",
      detail: {},
      reads: { episodes: [episode], people: [], items: [] },
    });
    // An answer refused for its size still told times and counts: it counts as read.
    keys.lookup(keyOf(1))?.onCall({
      tool: "get_episode",
      outcome: "error",
      detail: {},
      reads: { episodes: [episode], people: [], items: [] },
    });
    expect(chatReadCount(db, other.discussionId)).toBe(1);

    service.peopleRemoved([episode]);
    expect((await viewOf(null)).discussions).toEqual([]);
    expect(sessions[0]!.closed && sessions[1]!.closed).toBe(true);

    // A deletion core did not see through (it stopped first) is caught up at the next start.
    const kept = await service.send({ discussionId: null, text: "Encore", choice });
    keys.lookup(keyOf(2))?.onCall({
      tool: "search_transcripts",
      outcome: "ok",
      detail: {},
      reads: { episodes: [episode], people: [], items: [] },
    });
    db.client.prepare("DELETE FROM episodes WHERE id = ?").run(episode);
    const relaunched = makeChatService({
      db,
      keys,
      providers: [fakeProvider()],
      relay: null,
      workDirectory: join(data.dir, "chat"),
      instructions: () => "instructions",
    });
    const controller = new AbortController();
    for await (const view of relaunched.watch(kept.discussionId, controller.signal)) {
      expect(view.discussion).toBeNull();
      expect(view.erased).toBe(1);
      controller.abort();
    }
    // Ids of erased discussions are never given again.
    expect(kept.discussionId).toBeGreaterThan(journal.discussionId);
    await relaunched.close();
  });

  it("ends every session when turned off, and keeps the discussions", async () => {
    await service.setEnabled(true);
    const { discussionId } = await service.send({ discussionId: null, text: "Un", choice });
    await service.setEnabled(false);
    expect(sessions[0]!.closed).toBe(true);
    expect(keys.count()).toBe(0);
    const view = await viewOf(discussionId);
    expect(view.discussions.map((d) => d.id)).toEqual([discussionId]);
    expect(view.discussion?.messages[1]).toMatchObject({ stopped: true, streaming: false });
  });

  it("keeps discussions across launches, and stops an answer a stopped core left streaming", async () => {
    await service.setEnabled(true);
    const { discussionId } = await service.send({ discussionId: null, text: "Un", choice });
    sessions[0]!.listener({ type: "text", delta: "Une réponse" });
    sessions[0]!.listener({ type: "turn-ended", reason: "complete" });
    await service.send({ discussionId, text: "Deux", choice });
    sessions[0]!.listener({ type: "text", delta: "Coupé" });
    // Core stops without closing: the second answer is still streaming in the database.
    const relaunched = makeChatService({
      db,
      keys,
      providers: [fakeProvider()],
      relay: null,
      workDirectory: join(data.dir, "chat"),
      instructions: () => "instructions",
    });
    const controller = new AbortController();
    let view: ChatView | undefined;
    for await (const next of relaunched.watch(discussionId, controller.signal)) {
      view = next;
      controller.abort();
    }
    expect(view?.discussion?.messages.map((m) => [m.role, m.text, m.streaming, m.stopped])).toEqual(
      [
        ["user", "Un", false, false],
        ["agent", "Une réponse", false, false],
        ["user", "Deux", false, false],
        // What streamed in memory is lost with the core; the answer reads as stopped.
        ["agent", "", false, true],
      ],
    );
    await relaunched.close();
  });

  it(`keeps at most ${MAX_LIVE_SESSIONS} sessions, ending the oldest idle one`, async () => {
    await service.setEnabled(true);
    for (let n = 0; n < MAX_LIVE_SESSIONS; n += 1) {
      await service.send({ discussionId: null, text: `D${n}`, choice });
    }
    // All answering: a fifth is refused before anything changes.
    await expect(service.send({ discussionId: null, text: "D4", choice })).rejects.toThrow(
      "already answering",
    );
    sessions[1]!.listener({ type: "turn-ended", reason: "complete" });
    await service.send({ discussionId: null, text: "D4", choice });
    expect(sessions.map((s) => s.closed)).toEqual([false, true, false, false, false]);
    expect(service.liveSessions()).toBe(MAX_LIVE_SESSIONS);
  });

  it("counts sessions still starting against the cap, so concurrent messages cannot pass it", async () => {
    await service.setEnabled(true);
    keys.setListening(false);
    const sends = Array.from({ length: MAX_LIVE_SESSIONS + 1 }, (_, n) =>
      service.send({ discussionId: null, text: `D${n}`, choice }),
    );
    // The fifth is refused at once, while the first four wait for the socket.
    await expect(sends.at(-1)).rejects.toThrow("already answering");
    keys.setListening(true);
    await Promise.all(sends.slice(0, MAX_LIVE_SESSIONS));
    expect(sessions).toHaveLength(MAX_LIVE_SESSIONS);
    expect(keys.count()).toBe(MAX_LIVE_SESSIONS);
  });

  it("cancels a message stopped while its session starts: nothing is sent", async () => {
    await service.setEnabled(true);
    keys.setListening(false);
    const pending = service.send({ discussionId: null, text: "Un", choice });
    let summary: ChatView["discussions"][number] | undefined;
    for (let attempt = 0; attempt < 50 && summary === undefined; attempt += 1) {
      [summary] = (await viewOf(null)).discussions;
    }
    await service.stop(summary!.id);
    keys.setListening(true);
    await pending;
    expect(sessions).toEqual([]);
    expect(keys.count()).toBe(0);
    const view = await viewOf(summary!.id);
    expect(view.discussion?.messages[1]).toMatchObject({ stopped: true, streaming: false });
  });

  it("releases the key when the CLI cannot start", async () => {
    await service.setEnabled(true);
    openFails = true;
    const { discussionId } = await service.send({ discussionId: null, text: "Un", choice });
    expect(keys.count()).toBe(0);
    const view = await viewOf(discussionId);
    expect(view.discussion?.messages[1]).toMatchObject({
      streaming: false,
      failure: { code: "unavailable" },
    });
  });
});
