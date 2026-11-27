import { randomUUID } from "node:crypto";
import { mkdtemp, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  app,
  clipboard,
  dialog,
  shell,
  ShareMenu,
  type BrowserWindow,
  type SaveDialogOptions,
} from "electron";
import { m } from "../renderer/paraglide/messages.js";
import type { CoreToMain, MainToCore } from "../shared/core-messages";
import type { MediaRelay } from "./media-protocol";
import type { TrayLocale } from "./tray-state";

// Exports, which core asks for. « Exporter l'audio… »: a save panel, then the
// episode's WAV read slice by slice through the media relay (as playback reads
// it). A transcript: the clipboard, or a save panel; either way main asks core
// once more right before it writes, and writes only on its go. Files are
// written to a temporary file of their own, renamed once whole and shown in
// the Finder. « Partager… » writes the transcript in a folder of its own
// under the temporary directory and opens the macOS share sheet with it; the
// folder goes 30 minutes after the sheet closes (the chosen app has copied
// it by then), or when Sondine quits, or at its next start.

export type ExportOutcome = "saved" | "copied" | "shared" | "cancelled" | "stale" | "failed";

/** How long a shared file stays for the app it went to. */
const SHARE_KEEP_MS = 30 * 60_000;
const SHARE_PREFIX = "sondine-share-";
const shareFolders = new Set<string>();

const removeShareFolder = (folder: string) => {
  shareFolders.delete(folder);
  return rm(folder, { recursive: true, force: true });
};

/** Removes every shared file left: at quit, and at start for a previous run's. */
export async function removeSharedFiles(): Promise<void> {
  const temp = app.getPath("temp");
  const left = await readdir(temp).catch(() => []);
  await Promise.all([
    ...[...shareFolders].map(removeShareFolder),
    ...left
      .filter((name) => name.startsWith(SHARE_PREFIX))
      .map((name) => rm(join(temp, name), { recursive: true, force: true })),
  ]);
}

/** A core that does not answer in time says no. */
const CONFIRM_TIMEOUT_MS = 30_000;

/** Main's side of `export-ready` / `export-go`. */
export class ExportConfirmations {
  readonly #waiting = new Map<string, (go: boolean) => void>();

  constructor(private readonly post: (message: MainToCore) => void) {}

  ask(requestId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer(false), CONFIRM_TIMEOUT_MS);
      const answer = (go: boolean) => {
        clearTimeout(timer);
        this.#waiting.delete(requestId);
        resolve(go);
      };
      this.#waiting.set(requestId, answer);
      this.post({ type: "export-ready", requestId });
    });
  }

  receive(message: Extract<CoreToMain, { type: "export-go" }>): void {
    this.#waiting.get(message.requestId)?.(message.go);
  }
}

/**
 * Writes a temporary file beside the target, created exclusively (never an
 * existing file or a link), and renames it over the target once whole; on
 * failure only that temporary file is removed.
 */
async function writeWhole(target: string, write: (file: FileHandle) => Promise<void>) {
  const partial = join(dirname(target), `.${basename(target)}.${randomUUID()}.partial`);
  const file = await open(partial, "wx", 0o600);
  try {
    await write(file);
    await file.sync();
    await file.close();
    await rename(partial, target);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  }
}

/** The path the user chose in a save panel, or null when they closed it. */
export async function askSavePath(
  window: BrowserWindow | null,
  options: SaveDialogOptions,
): Promise<string | null> {
  app.focus({ steal: true });
  const parent = window !== null && !window.isDestroyed() && window.isVisible() ? window : null;
  const chosen =
    parent === null
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(parent, options);
  return chosen.canceled || chosen.filePath === undefined || chosen.filePath === ""
    ? null
    : chosen.filePath;
}

export async function exportEpisodeAudio(
  request: Extract<CoreToMain, { type: "export-audio" }>,
  relay: MediaRelay,
  window: BrowserWindow | null,
  locale: TrayLocale,
): Promise<ExportOutcome> {
  const target = await askSavePath(window, {
    defaultPath: join(app.getPath("downloads"), request.fileName),
    filters: [{ name: "WAV", extensions: ["wav"] }],
    message: m.export_audio_message({}, { locale }),
  });
  if (target === null) return "cancelled";
  await writeWhole(target, async (file) => {
    let start = 0;
    let total = Number.POSITIVE_INFINITY;
    while (start < total) {
      const reply = await relay.read({
        episodeId: request.episodeId,
        generation: request.generation,
        range: { kind: "range", start, end: null },
      });
      if (!reply.ok) throw new Error(`media read failed: ${reply.reason}`);
      total = reply.total;
      await file.write(reply.bytes, 0, reply.bytes.byteLength, start);
      start += reply.bytes.byteLength;
    }
  });
  shell.showItemInFolder(target);
  return "saved";
}

const textFilters: Record<string, { name: string; extensions: string[] }> = {
  md: { name: "Markdown", extensions: ["md"] },
  srt: { name: "SubRip", extensions: ["srt"] },
  vtt: { name: "WebVTT", extensions: ["vtt"] },
};

export async function exportText(
  request: Extract<CoreToMain, { type: "export-text" }>,
  confirmations: ExportConfirmations,
  window: BrowserWindow | null,
  locale: TrayLocale,
): Promise<ExportOutcome> {
  if (request.destination === "clipboard") {
    if (!(await confirmations.ask(request.requestId))) return "stale";
    clipboard.writeText(request.text);
    return "copied";
  }
  if (request.destination === "share") {
    if (!(await confirmations.ask(request.requestId))) return "stale";
    const folder = await mkdtemp(join(app.getPath("temp"), SHARE_PREFIX));
    shareFolders.add(folder);
    const target = join(folder, request.fileName);
    await writeWhole(target, (file) => file.writeFile(request.text, "utf8"));
    const parent = window !== null && !window.isDestroyed() ? window : undefined;
    new ShareMenu({ filePaths: [target] }).popup({
      ...(parent === undefined ? {} : { window: parent }),
      callback: () => {
        setTimeout(() => void removeShareFolder(folder), SHARE_KEEP_MS).unref();
      },
    });
    return "shared";
  }
  const extension = request.fileName.slice(request.fileName.lastIndexOf(".") + 1);
  const filter = textFilters[extension];
  const target = await askSavePath(window, {
    defaultPath: join(app.getPath("downloads"), request.fileName),
    filters: filter === undefined ? [] : [filter],
    message: m.export_text_message({}, { locale }),
  });
  if (target === null) return "cancelled";
  if (!(await confirmations.ask(request.requestId))) return "stale";
  await writeWhole(target, (file) => file.writeFile(request.text, "utf8"));
  shell.showItemInFolder(target);
  return "saved";
}
