import { constants } from "node:fs";
import { copyFile, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  deleteOrphanContext,
  deleteOrphanTags,
  deleteUnlinkedTranscripts,
  getContextItem,
  linkedTranscripts,
  MAX_LINK_LENGTH,
  MAX_NOTE_LENGTH,
  referencedContextFiles,
  transaction,
  type ContextItemView,
  type NewContextItem,
} from "@sondine/db";
import { Context, Effect, Layer } from "effect";
import { MEDIA_SLICE_BYTES, resolveByteRange } from "../../shared/byte-range";
import type { ContextReadRequest, CoreToMain } from "../../shared/core-messages";
import { DATA_LAYOUT } from "../../shared/data-layout";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { FilePicker } from "../file-picker";
import { log } from "../log";
import { Retention } from "../retention/retention";
import {
  clearContextStaging,
  clearOpenCopies,
  collectContextFiles,
  ContextFileFailure,
  contextPaths,
  ensureContextFolders,
  makeOpenCopy,
  makePreview,
  previewPath,
  publishStaged,
  readTextFile,
  stageFile,
  type ContextFileProblem,
  type ContextPaths,
  type StagedFile,
  type StagedPreview,
} from "./context-files";

// Core's side of a conversation's context (ADR 024): turns what the user
// pasted, dropped or picked into items, keeps their files, collects the
// files nothing holds any more, serves image previews to the window and
// gives agents an image or a text file's text. Adds and collections run one
// at a time, in one turn, so a collection never removes a file an add is
// about to name. Logs no names, paths, addresses or text.

/** Files kept from one gesture. */
export const MAX_FILES_PER_ADD = 20;
/** What an agent reads of a text file, at most. */
export const AGENT_TEXT_CHARS = 100_000;
/**
 * A document sent to an agent as it is, at most: its base64 (6.7 MiB) stays
 * under what an agent's socket may leave unread (8 MiB, socket-transport.ts).
 */
export const AGENT_FILE_BYTES = 5 * 1024 ** 2;

/** What the user gave: typed or pasted text, files dropped, the clipboard, or the open panel. */
export interface ContextSources {
  readonly text?: string;
  readonly paths?: readonly string[];
  readonly clipboard?: boolean;
  readonly pick?: boolean;
}

/** An item ready to be written: a note or a link, or a file staged and hashed. */
export type PreparedItem =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "link"; readonly url: string; readonly title: string | null }
  | {
      readonly kind: "file";
      readonly staged: StagedFile;
      readonly preview: StagedPreview | null;
    };

export interface ContextRefusal {
  /** The file's name as it would show; null for text. */
  readonly name: string | null;
  readonly problem: ContextFileProblem | "too-long" | "too-many" | "empty";
}

/** A link when the text is one `http(s)` address and nothing else, otherwise a note. */
export function classifyText(text: string): PreparedItem | ContextRefusal {
  const trimmed = text.trim();
  if (trimmed === "") return { name: null, problem: "empty" };
  if (/^https?:\/\/\S+$/iu.test(trimmed) && trimmed.length <= MAX_LINK_LENGTH) {
    try {
      const url = new URL(trimmed);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "") {
        return { kind: "link", url: url.href, title: null };
      }
    } catch {
      // Not an address after all: a note.
    }
  }
  if (trimmed.length > MAX_NOTE_LENGTH) return { name: null, problem: "too-long" };
  return { kind: "note", text: trimmed };
}

const isRefusal = (value: PreparedItem | ContextRefusal): value is ContextRefusal =>
  "problem" in value;

/** The item written for a prepared one. */
export function newItemOf(item: PreparedItem): NewContextItem {
  if (item.kind !== "file") return item;
  return {
    kind: item.preview === null ? "file" : "image",
    name: item.staged.name,
    file: {
      sha256: item.staged.sha256,
      bytes: item.staged.bytes,
      mediaType: item.staged.mediaType,
      preview: item.preview?.format ?? null,
    },
  };
}

const two = (value: number) => String(value).padStart(2, "0");

/** « Image 2026-11-09 18.42.07.png »: a pasted image's name, in local time. */
function pastedImageName(nowMs: number): string {
  const date = new Date(nowMs);
  return `Image ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}.png`;
}

/** Drops staged files (and previews) that will not be written, or were published already. */
async function discard(items: readonly PreparedItem[]): Promise<void> {
  for (const item of items) {
    if (item.kind !== "file") continue;
    await rm(item.staged.stagedPath, { force: true });
    if (item.preview !== null) await rm(item.preview.stagedPath, { force: true });
  }
}

export interface ContextStoreService {
  readonly paths: ContextPaths;
  /** Copies files into staging (and makes previews); notes and links are only classified. */
  prepare(sources: ContextSources): Promise<{ items: PreparedItem[]; refused: ContextRefusal[] }>;
  /**
   * In the store's turn: publishes the staged files, runs `write` (the
   * database transaction, which may refuse), then collects what nothing holds.
   */
  commit<T>(items: readonly PreparedItem[], write: () => T): Promise<T>;
  /** Drops staged files that will not be written. */
  discard(items: readonly PreparedItem[]): Promise<void>;
  /** Removes, in turn, the files and open copies nothing holds any more. */
  collect(): Promise<void>;
  /** What ⌘Z's steps hold besides the rows (`UndoHistory.heldFiles`). */
  holdWith(held: () => ReadonlySet<string>): void;
  /** A slice of an image's preview for `sondine-media://context/…`. */
  read(request: ContextReadRequest): Promise<CoreToMain>;
  /** A private copy for another app to open; its folder goes with the item. */
  openCopy(item: ContextItemView): Promise<string>;
  /** An image's preview, for an agent. */
  previewBytes(item: ContextItemView): Promise<Uint8Array | null>;
  /** A text file's text, for an agent. */
  textOf(item: ContextItemView): Promise<{ text: string; truncated: boolean } | null>;
  /** A file's bytes as they are, for an agent; null past `limit` bytes. */
  fileBytes(item: ContextItemView, limit: number): Promise<Uint8Array | null>;
  /** A clone of a file's bytes at `path` (« Transcrire »), in turn, while the item holds them. */
  copyFile(item: ContextItemView, path: string): Promise<void>;
}

export class ContextStore extends Context.Service<ContextStore, ContextStoreService>()(
  "sondine/core/ContextStore",
) {}

export const contextLayer = Layer.effect(
  ContextStore,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const db = yield* Database;
    const picker = yield* FilePicker;
    const retention = yield* Retention;
    const paths = contextPaths(config.dataDir, {
      root: DATA_LAYOUT.contextDir,
      previews: DATA_LAYOUT.contextPreviewDir,
      staging: DATA_LAYOUT.contextStagingDir,
    });
    /** What ⌘Z's steps hold, once api-services says how to ask. */
    let held: (() => ReadonlySet<string>) | null = null;
    /** Open copies by file: removed once no item holds the file. */
    const openCopies = new Map<string, Set<string>>();

    // One add or collection at a time.
    let turn: Promise<unknown> = Promise.resolve();
    const inTurn = <A>(work: () => Promise<A>): Promise<A> => {
      const mine = turn.then(work);
      turn = mine.catch(() => undefined);
      return mine;
    };

    const collectNow = async () => {
      const rows = referencedContextFiles(db);
      const keep = new Set([...rows, ...(held?.() ?? [])]);
      const removed = await collectContextFiles(paths, keep);
      for (const [sha256, folders] of openCopies) {
        if (rows.has(sha256)) continue;
        for (const folder of folders) await rm(folder, { recursive: true, force: true });
        openCopies.delete(sha256);
      }
      if (removed > 0) log.info("context.files-removed", { files: removed });
    };
    const collect = () =>
      inTurn(collectNow).catch((error: unknown) =>
        log.warn("context.collect-failed", {
          error: error instanceof Error ? error.name : "unknown",
        }),
      );

    // What an earlier run left: staged bytes, open copies, items nothing holds, their files.
    yield* Effect.promise(async () => {
      await ensureContextFolders(paths);
      await clearContextStaging(paths);
      await clearOpenCopies(paths);
      await collectNow();
    });
    // Items whose audio no episode holds, and their transcriptions (ADR 024).
    const orphans = transaction(db, () => {
      const linked = linkedTranscripts(db);
      const items = deleteOrphanContext(db);
      // Tags whose audio no episode holds go too (ADR 039).
      deleteOrphanTags(db);
      return {
        items,
        ...deleteUnlinkedTranscripts(db, linked, { origin: "app", nowMs: Date.now() }),
      };
    });
    if (orphans.items > 0) {
      log.warn("context.orphans-removed", {
        items: orphans.items,
        transcripts: orphans.episodeIds.length,
      });
      yield* Effect.promise(collectNow);
    }
    if (orphans.chunks.length > 0) yield* retention.scrub(orphans.chunks);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const folders of openCopies.values()) {
          for (const folder of folders) await rm(folder, { recursive: true, force: true });
        }
      }),
    );

    const stage = async (
      path: string,
      refused: ContextRefusal[],
      name?: string,
    ): Promise<PreparedItem | null> => {
      try {
        const staged = await stageFile(path, paths, name === undefined ? {} : { name });
        const preview = await makePreview(staged, paths);
        return { kind: "file", staged, preview };
      } catch (error) {
        const problem = error instanceof ContextFileFailure ? error.problem : "unreadable";
        refused.push({ name: name ?? path.split("/").at(-1) ?? null, problem });
        log.info("context.file-refused", { problem });
        return null;
      }
    };

    const prepare: ContextStoreService["prepare"] = async (sources) => {
      const items: PreparedItem[] = [];
      const refused: ContextRefusal[] = [];
      const files = [...(sources.paths ?? [])];
      if (sources.pick === true) files.push(...(await picker.pickFiles()));
      let text = sources.text;
      if (sources.clipboard === true) {
        const content = await picker.readClipboard();
        if (content !== null) {
          if (content.files.length > 0) files.push(...content.files);
          else if (content.imagePath !== null) {
            const item = await stage(content.imagePath, refused, pastedImageName(Date.now()));
            if (item !== null) items.push(item);
          } else if (content.text !== null) text = content.text;
        }
      }
      if (text !== undefined) {
        const classified = classifyText(text);
        if (isRefusal(classified)) refused.push(classified);
        else items.push(classified);
      }
      for (const [index, path] of files.entries()) {
        if (index >= MAX_FILES_PER_ADD) {
          refused.push({ name: path.split("/").at(-1) ?? null, problem: "too-many" });
          continue;
        }
        const item = await stage(path, refused);
        if (item !== null) items.push(item);
      }
      return { items, refused };
    };

    /** Whether an item still exists with these bytes: what a slow read or copy checks at its end. */
    const stillHolds = (itemId: number, sha256: string) =>
      getContextItem(db, itemId)?.file?.sha256 === sha256;

    return ContextStore.of({
      paths,
      prepare,
      commit: (items, write) =>
        inTurn(async () => {
          try {
            for (const item of items)
              if (item.kind === "file") await publishStaged(item.staged, item.preview, paths);
            return write();
          } finally {
            await discard(items);
            // A refused write leaves files no row names; a dedup leaves nothing.
            await collectNow();
          }
        }),
      discard,
      collect,
      holdWith: (provider) => {
        held = provider;
      },
      read: async (request) => {
        const failed = (
          reason: "not-found" | "unsatisfiable" | "failed",
          total: number | null,
        ) => ({
          type: "media-failed" as const,
          requestId: request.requestId,
          reason,
          total,
        });
        const item = getContextItem(db, request.itemId);
        const file = item?.file ?? null;
        if (file === null || file.preview === null || !file.sha256.startsWith(request.version)) {
          return failed("not-found", null);
        }
        let handle;
        try {
          handle = await open(previewPath(paths, file.sha256, file.preview), "r");
        } catch {
          return failed("not-found", null);
        }
        try {
          const total = (await handle.stat()).size;
          const range = resolveByteRange(request.range, total);
          if (range === null) return failed("unsatisfiable", total);
          const length = Math.min(range.end - range.start + 1, MEDIA_SLICE_BYTES);
          const bytes = new Uint8Array(length);
          const { bytesRead } = await handle.read(bytes, 0, length, range.start);
          if (bytesRead === 0) return failed("failed", total);
          // Removed while it was read: an open file stays readable, its bytes must not leave.
          if (!stillHolds(request.itemId, file.sha256)) return failed("not-found", null);
          return {
            type: "media-bytes",
            requestId: request.requestId,
            mediaType: file.preview === "jpeg" ? "image/jpeg" : "image/png",
            total,
            start: range.start,
            end: range.end,
            bytes: bytes.slice(0, bytesRead),
          };
        } catch {
          return failed("failed", null);
        } finally {
          await handle.close();
        }
      },
      openCopy: (item) =>
        inTurn(async () => {
          const file = item.file;
          // Removed while the request waited: nothing to open.
          if (file === null || !stillHolds(item.id, file.sha256)) {
            throw new ContextFileFailure("unreadable");
          }
          const copy = await makeOpenCopy(paths, file.sha256, item.title ?? "fichier");
          // Removed while it was copied (a deletion does not wait for this turn).
          if (!stillHolds(item.id, file.sha256)) {
            await rm(copy.folder, { recursive: true, force: true });
            throw new ContextFileFailure("unreadable");
          }
          const folders = openCopies.get(file.sha256) ?? new Set<string>();
          folders.add(copy.folder);
          openCopies.set(file.sha256, folders);
          return copy.path;
        }),
      previewBytes: async (item) => {
        const file = item.file;
        if (file === null || file.preview === null) return null;
        try {
          const handle = await open(previewPath(paths, file.sha256, file.preview), "r");
          try {
            return new Uint8Array(await handle.readFile());
          } finally {
            await handle.close();
          }
        } catch {
          return null;
        }
      },
      textOf: async (item) => {
        const file = item.file;
        if (file === null || item.kind !== "file") return null;
        try {
          return await readTextFile(join(paths.root, file.sha256), AGENT_TEXT_CHARS);
        } catch {
          return null;
        }
      },
      fileBytes: async (item, limit) => {
        const file = item.file;
        if (file === null || file.bytes > limit) return null;
        try {
          const bytes = new Uint8Array(await readFile(join(paths.root, file.sha256)));
          // Removed while it was read: it does not leave.
          return bytes.length <= limit && stillHolds(item.id, file.sha256) ? bytes : null;
        } catch {
          return null;
        }
      },
      copyFile: (item, path) =>
        inTurn(async () => {
          const file = item.file;
          if (file === null || !stillHolds(item.id, file.sha256)) {
            throw new ContextFileFailure("unreadable");
          }
          await copyFile(join(paths.root, file.sha256), path, constants.COPYFILE_FICLONE);
        }),
    });
  }),
);
