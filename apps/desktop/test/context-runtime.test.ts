import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSpeechRegion, openSpeechRegion, upsertTrackRun } from "@sondine/db";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { ContextStore } from "../src/core/context/context-layer";
import { Database } from "../src/core/database";
import { makeCoreRuntime, type CoreRuntime } from "../src/core/runtime";
import { DATA_LAYOUT } from "../src/shared/data-layout";
import { captureOptions, recordingMain, tempDataDir, waitUntil } from "./support";

// A conversation's context through the real core (ADR 024): files copied
// into the data directory, an image's preview served to the window and
// given to agents, ⌘Z bringing a removed item back with its file, and a
// deleted conversation taking its files and open copies along.

const SYSTEM_JPEG = "/System/Library/CoreServices/DefaultBackground.jpg";
const SYSTEM_SOUND = "/System/Library/Sounds/Ping.aiff";
const T0 = Date.UTC(2026, 10, 9, 9, 0, 0);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function setup() {
  const data = tempDataDir();
  cleanups.push(() => data.cleanup());
  const main = recordingMain();
  const runtime = makeCoreRuntime(data.config(), main, captureOptions(data));
  cleanups.push(() => runtime.dispose());
  return { data, main, runtime };
}

/** A closed conversation over one region, 10 to 40 s, with one sentence. */
function seedConversation(runtime: CoreRuntime) {
  return runtime.runPromise(
    Effect.map(Database, (db) => {
      const { trackRunId } = upsertTrackRun(db, {
        uid: "run-context",
        trackKey: "input:BuiltInMicrophoneDevice",
        sourceKind: "input",
        device: {
          uid: "BuiltInMicrophoneDevice",
          name: "Micro",
          transport: "built_in",
          hasInput: true,
          seenAtMs: T0,
        },
        startedWallMs: T0,
        nowMs: T0,
      });
      const { speechRegionId } = openSpeechRegion(db, {
        trackRunId,
        sampleStart: 160_000,
        wallStartMs: T0 + 10_000,
        vadVersion: "silero-6.2",
      });
      closeSpeechRegion(db, {
        trackRunId,
        sampleStart: 160_000,
        sampleEnd: 640_000,
        wallEndMs: T0 + 40_000,
        endReason: "silence",
      });
      const episode = db
        .statement(
          `INSERT INTO episodes (state, context, size, started_at_ms, ended_at_ms, grouping_version,
             classifier_version, created_at_ms, updated_at_ms)
           VALUES ('closed', 'in_person', 'conversation', ?, ?, 'g1', 'c1', ?, ?)`,
        )
        .run(T0 + 10_000, T0 + 40_000, T0, T0);
      const episodeId = Number(episode.lastInsertRowid);
      db.statement(
        `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start)
         VALUES (?, ?, 'g1', 160000)`,
      ).run(episodeId, speechRegionId);
      return episodeId;
    }),
  );
}

const contextFiles = (dir: string) =>
  readdirSync(join(dir, DATA_LAYOUT.contextDir)).filter((name) => /^[0-9a-f]{64}$/u.test(name));

describe.skipIf(!existsSync(SYSTEM_JPEG) || !existsSync(SYSTEM_SOUND))(
  "conversation context in core",
  () => {
    it("adds, shows, gives agents, undoes and deletes context with its files", async () => {
      const { data, main, runtime } = setup();
      const services = await runtime.runPromise(Api);
      const episodeId = await seedConversation(runtime);
      // The user's files sit outside Sondine's data: files from inside it are refused.
      const user = mkdtempSync(join(tmpdir(), "sondine-user-"));
      cleanups.push(() => rmSync(user, { recursive: true, force: true }));
      const notes = join(user, "ordre du jour.md");
      writeFileSync(notes, "# Budget\n\nPoints à voir.\n");
      const photo = join(user, "tableau.jpg");
      copyFileSync(SYSTEM_JPEG, photo);
      const memo = join(user, "mémo vocal.aiff");
      copyFileSync(SYSTEM_SOUND, memo);
      const pdf = join(user, "plan.pdf");
      writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");

      const added = await services.context.add({ episodeId, paths: [notes, photo, memo, pdf] });
      expect(added.refused).toEqual([]);
      const link = await services.context.add({ episodeId, text: " https://example.com/plan " });
      const [noteFile, image, audio, document] = added.itemIds;
      expect(contextFiles(data.dir)).toHaveLength(4);

      const detail = await services.episodes.get({ episodeId });
      expect(detail.context.map((item) => item.kind)).toEqual([
        "file",
        "image",
        "file",
        "file",
        "link",
      ]);
      // Only the audio offers « Transcrire ».
      expect(detail.context.map((item) => item.file?.transcript ?? null)).toEqual([
        null,
        null,
        { episodeId: null },
        null,
        null,
      ]);
      const shown = detail.context[1];
      const linked = detail.context[4];
      expect(shown?.file?.preview).toMatch(/^sondine-media:\/\/context\/\d+\?v=[0-9a-f]{16}$/u);
      expect(linked).toMatchObject({ text: "https://example.com/plan", title: null });

      // The window's preview, through the media scheme's core side.
      const version = /v=([0-9a-f]{16})/u.exec(shown?.file?.preview ?? "")?.[1] ?? "";
      const reply = await runtime.runPromise(
        Effect.flatMap(ContextStore, (store) =>
          Effect.promise(() =>
            store.read({
              type: "context-read",
              requestId: 1,
              itemId: image ?? 0,
              version,
              range: { kind: "range", start: 0, end: null },
            }),
          ),
        ),
      );
      expect(reply).toMatchObject({ type: "media-bytes", mediaType: "image/jpeg", start: 0 });

      // What an agent gets: the image, and a text file's text.
      const forAgent = await services.context.get({ itemId: image ?? 0 });
      expect(forAgent.image?.mediaType).toBe("image/jpeg");
      expect(forAgent.image?.data.length).toBeGreaterThan(100);
      expect((await services.context.get({ itemId: noteFile ?? 0 })).content).toEqual({
        text: "# Budget\n\nPoints à voir.\n",
        truncated: false,
      });
      // A PDF as it is; never the audio.
      expect((await services.context.get({ itemId: document ?? 0 })).file).toEqual({
        mediaType: "application/pdf",
        data: Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64"),
      });
      expect(await services.context.get({ itemId: audio ?? 0 })).toMatchObject({
        content: null,
        file: null,
      });

      // « Transcrire »: an imported recording, linked to the item.
      const transcribed = await services.context.transcribe({ itemId: audio ?? 0 });
      if (transcribed.outcome !== "imported") throw new Error(JSON.stringify(transcribed));
      const audioItem = (await services.episodes.get({ episodeId })).context[2];
      expect(audioItem?.file?.transcript).toEqual({ episodeId: transcribed.episodeId });
      expect((await services.imports.list({})).imports.map((row) => row.fileName)).toEqual([
        "mémo vocal.aiff",
      ]);
      // Nothing going on: ⌃⌥⌘V adds nowhere.
      expect(await services.context.pasteOngoing()).toEqual({ outcome: "none" });

      // Found by its name, and by the link's words.
      const found = await services.search.query({ text: "ordre du jour", limit: 10, offset: 0 });
      expect(found.episodes[0]?.contextHits.map((hit) => hit.itemId)).toEqual([noteFile]);

      // Opened from a private copy, which goes once the item does.
      await services.context.open({ itemId: noteFile ?? 0 });
      const opened = main.posted.find((message) => message.type === "open-file");
      expect(opened?.type === "open-file" && existsSync(opened.path)).toBe(true);

      // Removed, then brought back by ⌘Z with its file.
      await services.context.remove({ itemId: image ?? 0 });
      expect((await services.episodes.get({ episodeId })).context).toHaveLength(4);
      expect(contextFiles(data.dir)).toHaveLength(4);
      expect(await services.history.undo()).toMatchObject({ outcome: "undone", action: "context" });
      expect((await services.episodes.get({ episodeId })).context).toHaveLength(5);

      // Audio Sondine does not recognize (bytes of no known type) never leaves.
      const opaque = join(user, "voix.ogg");
      writeFileSync(opaque, Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0xff, 0xfe]));
      const [unknown = 0] = (await services.context.add({ episodeId, paths: [opaque] })).itemIds;
      expect(await services.context.get({ itemId: unknown })).toMatchObject({
        content: null,
        image: null,
        file: null,
      });

      // Deleting the conversation takes the context, its files and open copies,
      // and the transcription with its audio.
      await services.episodes.delete({ episodeId });
      expect((await services.imports.list({})).imports).toEqual([]);
      await waitUntil(() => contextFiles(data.dir).length === 0, { label: "files collected" });
      await waitUntil(() => opened?.type === "open-file" && !existsSync(opened.path), {
        label: "open copy removed",
      });
      expect(link.itemIds).toHaveLength(1);
    });
  },
);
