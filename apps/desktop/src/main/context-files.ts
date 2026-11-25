import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { clipboard } from "electron";
import type { ClipboardContent } from "../shared/core-messages";
import { pastedFiles } from "./pasted-files";

// Main's side of a conversation's context (ADR 024): what the clipboard
// holds for ⌘V (files copied in Finder, else an image, else text), and which
// copies main may open in another app. Main reads and writes nothing else.

/** The longest text taken from the clipboard. */
const MAX_TEXT = 1_000_000;
/** An image on the clipboard, as Chromium hands it (a screenshot's TIFF included). */
const PNG = "image/png";
/** Where core puts copies for other apps: `<tmp>/sondine-open-…/<name>`. */
const OPEN_COPY_PREFIX = "sondine-open-";

/**
 * Files first (a Finder copy also carries the file's icon and name), then an
 * image (a screenshot: written as PNG into the context staging folder, which
 * core empties at start), then text.
 */
export async function readClipboard(stagingDir: string): Promise<ClipboardContent> {
  const files = await pastedFiles();
  if (files.length > 0) return { files, imagePath: null, text: null };
  for (const item of await clipboard.read()) {
    if (!item.types.includes(PNG)) continue;
    const value: unknown = await item.getType(PNG);
    if (!(value instanceof Blob) || value.size === 0) continue;
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const imagePath = join(stagingDir, `paste-${randomUUID()}.png`);
    await writeFile(imagePath, Buffer.from(await value.arrayBuffer()), { mode: 0o600 });
    return { files: [], imagePath, text: null };
  }
  const text = await clipboard.readText();
  return { files: [], imagePath: null, text: text === "" ? null : text.slice(0, MAX_TEXT) };
}

/** Whether `path` is a copy core made for another app to open, and nothing else. */
export function isOpenCopy(path: string, tmpDir = tmpdir()): boolean {
  try {
    const real = realpathSync(path);
    const root = realpathSync(tmpDir);
    if (!real.startsWith(root + sep)) return false;
    const [folder, name, ...rest] = real.slice(root.length + 1).split(sep);
    return (
      folder !== undefined &&
      folder.startsWith(OPEN_COPY_PREFIX) &&
      name !== undefined &&
      name !== "" &&
      rest.length === 0
    );
  } catch {
    return false;
  }
}
