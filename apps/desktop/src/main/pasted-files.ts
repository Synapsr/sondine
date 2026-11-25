import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clipboard } from "electron";

// The files copied in Finder (⌘C), for a paste on « Importés » (ADR 021):
// each as a `file://` URL of `text/uri-list`. Only existing files, at most
// 20; nothing else on the clipboard is read.

const MAX_FILES = 20;
const URI_LIST = "text/uri-list";

/** The local files a `text/uri-list` names (comment lines and other URLs left out). */
export function filesOfUriList(list: string): string[] {
  return list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("file://"))
    .flatMap((url) => {
      try {
        return [fileURLToPath(url)];
      } catch {
        return [];
      }
    });
}

export async function pastedFiles(): Promise<string[]> {
  const paths: string[] = [];
  for (const item of await clipboard.read()) {
    if (!item.types.includes(URI_LIST)) continue;
    const value: unknown = await item.getType(URI_LIST);
    const text =
      typeof value === "string" ? value : value instanceof Blob ? await value.text() : "";
    paths.push(...filesOfUriList(text));
  }
  return [...new Set(paths)]
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true)
    .slice(0, MAX_FILES);
}
