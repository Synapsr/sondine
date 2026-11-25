import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRecording } from "./audio-import";
import {
  addContextItems,
  contextEpisodeOf,
  linkContextTranscript,
  linkedTranscripts,
  ongoingEpisode,
  deleteOrphanContext,
  editContextItem,
  listContextItems,
  planContextAnchor,
  referencedContextFiles,
  removeContextItem,
  unpinContextItem,
  contextHomes,
  settleContext,
  type ContextAnchor,
  type NewContextItem,
} from "./context-items";
import { deleteEpisode, deleteUnlinkedTranscripts } from "./delete-episode";
import { deletePassage } from "./delete-passage";
import { mergeEpisodes, splitEpisode } from "./episode-boundaries";
import { forgetRange } from "./forget-range";
import { publishAnalysis } from "./publish";
import { ensureSearchNormalizer } from "./search-text";
import { searchEpisodes } from "./search";
import {
  count,
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";
import { UndoHistory } from "./undo-history";

const canary = "zqxjvwplonk";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const s = (seconds: number) => t0 + seconds * 1000;

const note = (text: string): NewContextItem => ({ kind: "note", text });
const image = (name: string, sha256: string): NewContextItem => ({
  kind: "image",
  name,
  file: { sha256, bytes: 1234, mediaType: "image/png", preview: "png" },
});

/** A closed conversation at 10–40 s with three sentences. */
function conversation(regions: readonly (readonly [number, number])[] = [[10, 40]]) {
  const seeded = seedEpisode(temp.db, regions);
  const { episodeId, trackRunId } = seeded;
  temp.db.client
    .prepare("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
    .run(episodeId);
  const runId = startRun(temp.db, episodeId, "asr");
  const published = publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: [
      segment(trackRunId, 10, 15, "bonjour à tous", "A"),
      segment(trackRunId, 20, 25, "le budget est prêt", "B"),
      segment(trackRunId, 30, 35, "on passe au planning", "A"),
    ],
    turns: [turn(trackRunId, 10, 15, "A"), turn(trackRunId, 20, 25, "B")],
  });
  expect(published.published).toBe(true);
  return seeded;
}

const segmentIds = (episodeId: number) =>
  temp.db.client
    .prepare("SELECT id FROM segments WHERE episode_id = ? ORDER BY start_ms")
    .all(episodeId)
    .map((row) => Number(row["id"]));

function plan(episodeId: number, segmentId?: number): ContextAnchor {
  const anchor = planContextAnchor(temp.db, episodeId, segmentId);
  if (typeof anchor === "string") throw new Error(anchor);
  return anchor;
}

let clock = 0;
function add(episodeId: number, items: readonly NewContextItem[], segmentId?: number): number[] {
  clock += 10;
  const result = addContextItems(temp.db, {
    anchor: plan(episodeId, segmentId),
    items,
    origin: "app",
    nowMs: s(100) + clock,
  });
  if (!result.ok) throw new Error("refused");
  return [...result.itemIds];
}

describe("context items", () => {
  it("adds notes, links and files to a conversation and pins one to a sentence", () => {
    const { episodeId } = conversation();
    const [, second] = segmentIds(episodeId);
    const [noteId] = add(episodeId, [note("ordre du jour"), image("capture.png", "a".repeat(64))]);
    const [linkId] = add(
      episodeId,
      [{ kind: "link", url: "https://example.com/budget", title: "Budget" }],
      second,
    );
    const items = listContextItems(temp.db, episodeId);
    expect(items.map((item) => item.kind)).toEqual(["note", "image", "link"]);
    expect(items[0]).toMatchObject({
      id: noteId,
      body: "ordre du jour",
      span: null,
      segmentId: null,
    });
    expect(items[0]?.atMs).toBe(s(10));
    expect(items[2]).toMatchObject({ id: linkId, segmentId: second, title: "Budget" });
    expect(items[2]?.atMs).toBeGreaterThanOrEqual(s(20));
    expect(referencedContextFiles(temp.db)).toEqual(new Set(["a".repeat(64)]));
  });

  it("is found by search through its notes, link titles and file names", () => {
    const { episodeId } = conversation();
    add(episodeId, [note(`le mot ${canary}`), image("schéma réseau.png", "b".repeat(64))]);
    const found = searchEpisodes(temp.db, canary, { limit: 10, offset: 0 });
    expect(found.total).toBe(1);
    expect(found.episodes[0]?.episode.id).toBe(episodeId);
    expect(found.episodes[0]?.contextHits.map((hit) => hit.kind)).toEqual(["note"]);
    expect(found.episodes[0]?.contextHits[0]?.highlights.length).toBeGreaterThan(0);
    expect(searchEpisodes(temp.db, "schema reseau", { limit: 10, offset: 0 }).total).toBe(1);
    // Context has no app in front: that filter leaves it out.
    expect(
      searchEpisodes(temp.db, canary, { limit: 10, offset: 0, foregroundApp: "com.apple.Notes" })
        .total,
    ).toBe(0);
  });

  it("edits, unpins and removes, keeping the index in step", () => {
    const { episodeId } = conversation();
    const [, second] = segmentIds(episodeId);
    const [id] = add(episodeId, [note("avant")], second);
    if (id === undefined) throw new Error("no item");
    expect(
      editContextItem(temp.db, { itemId: id, edit: { kind: "note", text: canary }, nowMs: s(101) }),
    ).toBe(true);
    expect(searchEpisodes(temp.db, "avant", { limit: 10, offset: 0 }).total).toBe(0);
    expect(searchEpisodes(temp.db, canary, { limit: 10, offset: 0 }).total).toBe(1);
    // A note is not a link.
    expect(
      editContextItem(temp.db, {
        itemId: id,
        edit: { kind: "link", url: "https://x.test", title: null },
        nowMs: s(102),
      }),
    ).toBe(false);
    expect(unpinContextItem(temp.db, { itemId: id, nowMs: s(103) })).toBe(true);
    expect(listContextItems(temp.db, episodeId)[0]).toMatchObject({ span: null, segmentId: null });
    expect(removeContextItem(temp.db, id)).toBe(true);
    expect(listContextItems(temp.db, episodeId)).toEqual([]);
    expect(searchEpisodes(temp.db, canary, { limit: 10, offset: 0 }).total).toBe(0);
    temp.db.client.exec(
      "INSERT INTO context_fts (context_fts, rank) VALUES ('integrity-check', 1)",
    );
  });

  it("follows its audio through a split and a merge", () => {
    const { episodeId } = conversation([
      [10, 18],
      [20, 26],
      [30, 36],
    ]);
    const [, , third] = segmentIds(episodeId);
    const [whole] = add(episodeId, [note("pour toute la conversation")]);
    const [pinned] = add(episodeId, [note("sur la dernière phrase")], third);
    const split = splitEpisode(temp.db, { episodeId, atMs: s(28), nowMs: s(101) });
    if (!split.ok) throw new Error(split.reason);
    const later = split.value.newEpisodeId;
    // The whole conversation's context stays with the first part; the pin goes with its sentence.
    expect(listContextItems(temp.db, episodeId).map((item) => item.id)).toEqual([whole]);
    expect(listContextItems(temp.db, later).map((item) => item.id)).toEqual([pinned]);
    expect(listContextItems(temp.db, later)[0]?.segmentId).not.toBeNull();
    const merged = mergeEpisodes(temp.db, { episodeId, otherId: later, nowMs: s(102) });
    if (!merged.ok) throw new Error(merged.reason);
    expect(listContextItems(temp.db, merged.value.episodeId).map((item) => item.id)).toEqual([
      whole,
      pinned,
    ]);
    expect(contextEpisodeOf(temp.db, pinned ?? 0)).toBe(merged.value.episodeId);
  });

  it("goes with a deleted conversation, its text out of the database file", () => {
    const { episodeId } = conversation();
    add(episodeId, [note(`secret ${canary}`), image("photo.heic", "c".repeat(64))]);
    const result = deleteEpisode(temp.db, episodeId, { origin: "app" });
    expect(result.deleted && result.contextCount).toBe(2);
    expect(count(temp.db, "context_items")).toBe(0);
    expect(referencedContextFiles(temp.db).size).toBe(0);
    for (const path of [temp.path, `${temp.path}-wal`]) {
      expect(existsSync(path) && readFileSync(path).includes(Buffer.from(canary))).toBe(false);
    }
  });

  it("refuses an add planned before its conversation was deleted", () => {
    const { episodeId } = conversation();
    const anchor = plan(episodeId);
    deleteEpisode(temp.db, episodeId, { origin: "app" });
    // A new episode may take the same id: the anchor's audio is what counts.
    conversation();
    expect(
      addContextItems(temp.db, { anchor, items: [note("trop tard")], origin: "app", nowMs: s(1) }),
    ).toEqual({ ok: false });
    expect(count(temp.db, "context_items")).toBe(0);
  });

  it("loses what was pinned in a deleted passage and keeps the conversation's", () => {
    const { episodeId } = conversation([
      [10, 18],
      [20, 26],
      [30, 36],
    ]);
    const [first, second] = segmentIds(episodeId);
    const [whole] = add(episodeId, [note("toute la conversation")]);
    const [onFirst] = add(episodeId, [note(`épinglé ${canary}`)], first);
    const [onSecond] = add(episodeId, [note("reste")], second);
    // The first sentence, where the conversation-wide item is anchored too.
    const result = deletePassage(temp.db, {
      episodeId,
      fromMs: s(10),
      toMs: s(16),
      origin: "app",
      nowMs: s(101),
    });
    expect(result.deleted && !result.episodeDeleted).toBe(true);
    const left = listContextItems(temp.db, episodeId);
    expect(left.map((item) => item.id)).toEqual([whole, onSecond]);
    expect(left[0]?.atMs).toBeGreaterThanOrEqual(s(16));
    expect(left.some((item) => item.id === onFirst)).toBe(false);
    expect(searchEpisodes(temp.db, canary, { limit: 10, offset: 0 }).total).toBe(0);
  });

  it("goes with a forgotten range, and an orphan is swept", () => {
    const other = conversation();
    add(other.episodeId, [note("orpheline")]);
    temp.db.client.prepare("DELETE FROM episode_regions WHERE episode_id = ?").run(other.episodeId);
    expect(deleteOrphanContext(temp.db)).toBe(1);

    const { episodeId } = conversation();
    add(episodeId, [note("oublie-moi")]);
    forgetRange(temp.db, { fromWallMs: s(30), toWallMs: s(50), origin: "app", nowMs: s(60) });
    expect(count(temp.db, "context_items")).toBe(0);
  });

  it("is undone and redone, file references held by the history", () => {
    const { episodeId } = conversation();
    let released = 0;
    const history = new UndoHistory(temp.db, { onRelease: () => (released += 1) });
    const scope = { level: "assertions" as const, episodeIds: [episodeId], personIds: [] };
    const [id] = history.track("context", scope, () =>
      add(episodeId, [image("x.png", "d".repeat(64))]),
    );
    history.track("context", scope, () => removeContextItem(temp.db, id ?? 0));
    expect(listContextItems(temp.db, episodeId)).toEqual([]);
    expect(history.heldFiles()).toEqual(new Set(["d".repeat(64)]));
    expect(history.undo(s(200))).toMatchObject({ outcome: "undone", action: "context" });
    expect(listContextItems(temp.db, episodeId).map((item) => item.id)).toEqual([id]);
    expect(searchEpisodes(temp.db, "x", { limit: 10, offset: 0, prefix: true }).total).toBe(1);
    expect(history.undo(s(201))).toMatchObject({ outcome: "undone" });
    expect(listContextItems(temp.db, episodeId)).toEqual([]);
    expect(history.redo(s(202))).toMatchObject({ outcome: "redone" });
    expect(listContextItems(temp.db, episodeId).map((item) => item.id)).toEqual([id]);
    history.clear();
    expect(released).toBe(1);
    expect(history.heldFiles().size).toBe(0);
  });

  it("settles an item whose audio left every episode, never into an id reused meanwhile", () => {
    const first = conversation();
    const [id] = add(first.episodeId, [note("à garder")]);
    const homes = contextHomes(temp.db, [first.episodeId]);
    // Its audio leaves the episode (self-playback); the episode itself stays.
    temp.db.client.prepare("DELETE FROM episode_regions WHERE episode_id = ?").run(first.episodeId);
    const other = conversation([[50, 60]]);
    temp.db.client
      .prepare("UPDATE episode_regions SET episode_id = ? WHERE episode_id = ?")
      .run(first.episodeId, other.episodeId);
    // Same id, but the pass created it anew: another conversation, so the item goes.
    expect(settleContext(temp.db, homes, s(200), new Set([first.episodeId]))).toEqual({
      moved: 0,
      deleted: 1,
    });
    expect(count(temp.db, "context_items")).toBe(0);
    expect(id).toBeDefined();

    // The same episode still there: the item moves to its first audio instead.
    const kept = conversation([[70, 80]]);
    const [kept1] = add(kept.episodeId, [note("reste")], segmentIds(kept.episodeId)[0]);
    const keptHomes = contextHomes(temp.db, [kept.episodeId]);
    temp.db.client
      .prepare("UPDATE context_items SET anchor_sample = 0 WHERE id = ?")
      .run(kept1 ?? 0);
    expect(settleContext(temp.db, keptHomes, s(201))).toEqual({ moved: 1, deleted: 0 });
    expect(listContextItems(temp.db, kept.episodeId)[0]).toMatchObject({ id: kept1, span: null });
  });

  it("deletes an audio file's transcription with its conversation, never on « Retirer »", () => {
    const sha = "c".repeat(64);
    const memo: NewContextItem = {
      kind: "file",
      name: "memo.m4a",
      file: { sha256: sha, bytes: 9_000, mediaType: "audio/mp4", preview: null },
    };
    /** « Transcrire »: an imported recording, linked in its transaction. */
    const transcribe = (itemId: number, uid: string) => {
      const imported = importRecording(temp.db, {
        uid,
        fileName: "memo.m4a",
        sampleRate: 16_000,
        sampleCount: 32_000,
        startedWallMs: s(500),
        archiveRelPath: `archive/imports/${uid}/0001.pcm`,
        spoolRelPath: `spool/imports/${uid}/0001.pcm`,
        chunks: [{ sampleStart: 0, sampleCount: 32_000, byteOffset: 0, crc32: 1 }],
        nowMs: s(500),
      });
      expect(
        linkContextTranscript(temp.db, { itemId, sha256: sha, trackRunId: imported.trackRunId }),
      ).toBeNull();
      return imported;
    };
    const episodes = () => count(temp.db, "episodes");

    // Deleting the conversation takes its transcription and the audio of both.
    const first = conversation();
    const [memoId = 0] = add(first.episodeId, [memo]);
    const made = transcribe(memoId, "import-a");
    expect(listContextItems(temp.db, first.episodeId)[0]?.transcriptEpisodeId).toBe(made.episodeId);
    // A second « Transcrire » is refused while the first is there.
    expect(
      linkContextTranscript(temp.db, { itemId: memoId, sha256: sha, trackRunId: made.trackRunId }),
    ).toBe("transcribed");
    const before = episodes();
    const removed = deleteEpisode(temp.db, first.episodeId, { origin: "app" });
    if (!removed.deleted) throw new Error("not deleted");
    expect(episodes()).toBe(before - 2);
    expect(removed.chunks.some((chunk) => chunk.archiveRelPath?.includes("import-a"))).toBe(true);

    // « Retirer » leaves it in « Importés »; ⌘Z links it again.
    const second = conversation([[50, 70]]);
    const [kept = 0] = add(second.episodeId, [memo]);
    const keptImport = transcribe(kept, "import-b");
    const history = new UndoHistory(temp.db);
    history.track(
      "context",
      { level: "assertions", episodeIds: [second.episodeId], personIds: [] },
      () => removeContextItem(temp.db, kept),
    );
    expect(contextEpisodeOf(temp.db, kept)).toBeNull();
    expect(
      temp.db.client.prepare("SELECT 1 FROM episodes WHERE id = ?").get(keptImport.episodeId),
    ).toBeDefined();
    expect(history.undo(s(600))).toMatchObject({ outcome: "undone" });
    expect(listContextItems(temp.db, second.episodeId)[0]?.transcriptEpisodeId).toBe(
      keptImport.episodeId,
    );

    // Deleting the passage an item is pinned to takes its transcription; the
    // whole conversation's stays.
    const third = conversation();
    const [whole = 0] = add(third.episodeId, [memo]);
    const wholeImport = transcribe(whole, "import-c");
    const [, sentence] = segmentIds(third.episodeId);
    const [pinned = 0] = add(third.episodeId, [memo], sentence);
    const pinnedImport = transcribe(pinned, "import-d");
    const passage = deletePassage(temp.db, {
      episodeId: third.episodeId,
      fromMs: s(19),
      toMs: s(26),
      origin: "app",
      nowMs: s(700),
    });
    expect(passage.deleted).toBe(true);
    const exists = (episodeId: number) =>
      temp.db.client.prepare("SELECT 1 FROM episodes WHERE id = ?").get(episodeId) !== undefined;
    expect(exists(pinnedImport.episodeId)).toBe(false);
    expect(exists(wholeImport.episodeId)).toBe(true);
    expect(exists(keptImport.episodeId)).toBe(true);
  });

  it("takes an orphan item's transcription along at the start's sweep", () => {
    const { episodeId } = conversation();
    const sha = "d".repeat(64);
    const [itemId = 0] = add(episodeId, [
      {
        kind: "file",
        name: "memo.m4a",
        file: { sha256: sha, bytes: 10, mediaType: "audio/mp4", preview: null },
      },
    ]);
    const imported = importRecording(temp.db, {
      uid: "import-orphan",
      fileName: "memo.m4a",
      sampleRate: 16_000,
      sampleCount: 16_000,
      startedWallMs: s(500),
      archiveRelPath: "archive/imports/import-orphan/0001.pcm",
      spoolRelPath: "spool/imports/import-orphan/0001.pcm",
      chunks: [{ sampleStart: 0, sampleCount: 16_000, byteOffset: 0, crc32: 1 }],
      nowMs: s(500),
    });
    linkContextTranscript(temp.db, { itemId, sha256: sha, trackRunId: imported.trackRunId });
    // Its audio left every episode by a path that kept the item.
    temp.db.client.prepare("DELETE FROM episode_regions WHERE episode_id = ?").run(episodeId);
    const linked = linkedTranscripts(temp.db);
    expect(deleteOrphanContext(temp.db)).toBe(1);
    const gone = deleteUnlinkedTranscripts(temp.db, linked, { origin: "app", nowMs: s(600) });
    expect(gone.episodeIds).toEqual([imported.episodeId]);
    expect(gone.chunks.length).toBeGreaterThan(0);
  });

  it("finds the conversation going on: open first, a call first, never media", () => {
    const now = s(1_000);
    expect(ongoingEpisode(temp.db, now)).toBeNull();
    const media = conversation([[900, 990]]);
    temp.db.client
      .prepare("UPDATE episodes SET context = 'media' WHERE id = ?")
      .run(media.episodeId);
    expect(ongoingEpisode(temp.db, now)).toBeNull();
    const ended = conversation([[600, 800]]);
    // Ended 200 s ago: still within 5 minutes.
    expect(ongoingEpisode(temp.db, now)).toBe(ended.episodeId);
    expect(ongoingEpisode(temp.db, s(1_200))).toBeNull();
    const call = conversation([[850, 950]]);
    temp.db.client.prepare("UPDATE episodes SET context = 'call' WHERE id = ?").run(call.episodeId);
    expect(ongoingEpisode(temp.db, now)).toBe(call.episodeId);
    temp.db.client
      .prepare("UPDATE episodes SET state = 'open', ended_at_ms = NULL WHERE id = ?")
      .run(ended.episodeId);
    expect(ongoingEpisode(temp.db, now)).toBe(ended.episodeId);
  });

  it("reindexes with the normalizer", () => {
    const { episodeId } = conversation();
    add(episodeId, [note("vingt-deux")]);
    temp.db.client
      .prepare("UPDATE settings SET value = '\"old\"' WHERE key = 'search.normalizer'")
      .run();
    temp.db.client.prepare("UPDATE context_items SET search_text = ''").run();
    ensureSearchNormalizer(temp.db);
    expect(searchEpisodes(temp.db, "22", { limit: 10, offset: 0 }).total).toBe(1);
  });
});
