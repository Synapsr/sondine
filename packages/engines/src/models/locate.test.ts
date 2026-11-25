import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NEMOTRON_ARTIFACT, type CatalogArtifact } from "./catalog.ts";
import { candidateLocations, findArtifactFile, huggingFaceCachePath } from "./locate.ts";

let home: string;
let modelsRoot: string;
const artifact: CatalogArtifact = {
  ...NEMOTRON_ARTIFACT,
  sizeBytes: 1024,
  url: "https://huggingface.co/org/repo/resolve/55d289085ed6b1acd1cfd2e6cf279fdeb32fee5f/weights/model.gguf",
  knownLocations: ["Old App/model.gguf"],
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sondine-locate-"));
  modelsRoot = join(home, "Library/Application Support/Sondine/models");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const place = (relative: string, bytes = 1024) => {
  const path = join(home, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
};

describe("locate", () => {
  it("maps a pinned Hugging Face URL to its hub cache snapshot", () => {
    expect(huggingFaceCachePath(artifact.url)).toBe(
      ".cache/huggingface/hub/models--org--repo/snapshots/55d289085ed6b1acd1cfd2e6cf279fdeb32fee5f/weights/model.gguf",
    );
    expect(huggingFaceCachePath("https://huggingface.co/org/repo/resolve/main/model.gguf")).toBe(
      null,
    );
    expect(huggingFaceCachePath("https://example.com/org/repo/resolve/x/model.gguf")).toBe(null);
  });

  it("looks only in the hub cache and the catalog's known places, never Downloads", () => {
    const places = candidateLocations(artifact, home);
    expect(places).toEqual([
      join(home, huggingFaceCachePath(artifact.url) ?? ""),
      join(home, "Old App/model.gguf"),
    ]);
    expect(places.some((path) => path.includes("Downloads"))).toBe(false);
    expect(candidateLocations(NEMOTRON_ARTIFACT, home)).toHaveLength(2);
  });

  it("finds a file of the right size and says whether it clones", async () => {
    expect(await findArtifactFile(artifact, { homeDir: home, modelsRoot })).toBeNull();
    place("Old App/model.gguf", 1023);
    expect(await findArtifactFile(artifact, { homeDir: home, modelsRoot })).toBeNull();
    const path = place("Old App/model.gguf");
    expect(await findArtifactFile(artifact, { homeDir: home, modelsRoot })).toEqual({
      path,
      clones: true,
    });
  });

  it("follows the hub cache's symlink to its blob", async () => {
    const blob = place(".cache/huggingface/hub/models--org--repo/blobs/abc");
    const snapshot = join(home, huggingFaceCachePath(artifact.url) ?? "");
    mkdirSync(dirname(snapshot), { recursive: true });
    symlinkSync(blob, snapshot);
    expect(await findArtifactFile(artifact, { homeDir: home, modelsRoot })).toEqual({
      path: snapshot,
      clones: true,
    });
  });

  it("ignores a candidate inside the models folder", async () => {
    const inside: CatalogArtifact = {
      ...artifact,
      knownLocations: ["Library/Application Support/Sondine/models/x/model.gguf"],
    };
    place("Library/Application Support/Sondine/models/x/model.gguf");
    expect(await findArtifactFile(inside, { homeDir: home, modelsRoot })).toBeNull();
  });
});
