import { realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { CatalogArtifact } from "./catalog.ts";
import { sameVolume } from "./store.ts";

// Where a file of a catalog artifact may already sit, so the app can offer to
// import it before any download (ADR 016 "Models"). A short list of known
// places, each one `stat`, never a disk scan:
//
// - the Hugging Face hub cache at the pinned revision
//   (`~/.cache/huggingface/hub/models--<org>--<repo>/snapshots/<rev>/<file>`),
//   where `hf download` puts it;
// - the artifact's `knownLocations` from the catalog.
//
// The Downloads, Desktop and Documents folders are left out on purpose:
// reading them makes macOS ask the user for access out of nowhere. A file
// there is picked with the open panel, which is the user's consent.

/** `https://huggingface.co/<org>/<repo>/resolve/<rev>/<path>` as a hub cache path, home-relative. */
export function huggingFaceCachePath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "huggingface.co") return null;
  const parts = parsed.pathname
    .split("/")
    .filter((part) => part !== "")
    .map(decodeURIComponent);
  const [org, repo, resolve, revision, ...file] = parts;
  if (
    org === undefined ||
    repo === undefined ||
    resolve !== "resolve" ||
    revision === undefined ||
    !/^[0-9a-f]{40}$/.test(revision) ||
    file.length === 0 ||
    file.some((part) => part === ".." || part === ".")
  ) {
    return null;
  }
  return join(".cache/huggingface/hub", `models--${org}--${repo}`, "snapshots", revision, ...file);
}

/** Every place `findArtifactFile` looks, absolute, in order. */
export function candidateLocations(artifact: CatalogArtifact, homeDir: string): string[] {
  const hub = huggingFaceCachePath(artifact.url);
  return [...(hub === null ? [] : [hub]), ...artifact.knownLocations].map((path) =>
    join(homeDir, path),
  );
}

export interface FoundFile {
  readonly path: string;
  /** On the models folder's volume: the import clones it and costs no disk space. */
  readonly clones: boolean;
}

const inside = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The first candidate that is a regular file of the artifact's size, outside
 * the models folder. The size is only a hint: the import checks the sha256.
 */
export async function findArtifactFile(
  artifact: CatalogArtifact,
  options: { readonly homeDir: string; readonly modelsRoot: string },
): Promise<FoundFile | null> {
  const modelsRoot = await realpath(options.modelsRoot).catch(() => options.modelsRoot);
  for (const path of candidateLocations(artifact, options.homeDir)) {
    try {
      const stats = await stat(path);
      if (!stats.isFile() || stats.size !== artifact.sizeBytes) continue;
      if (inside(await realpath(path), modelsRoot)) continue;
      return { path, clones: await sameVolume(path, options.modelsRoot) };
    } catch {
      // Missing or unreadable: not there.
    }
  }
  return null;
}
