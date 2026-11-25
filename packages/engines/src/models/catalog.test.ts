import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, NEMOTRON_ARTIFACT, catalogArtifact } from "./catalog.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("model catalog", () => {
  it("keeps each license text byte-exact", () => {
    for (const artifact of MODEL_CATALOG) {
      expect(sha256(artifact.license.text), artifact.artifactId).toBe(artifact.license.sha256);
    }
  });

  it("pins every artifact to one upstream revision and hash", () => {
    const ids = MODEL_CATALOG.map((artifact) => `${artifact.artifactId}@${artifact.version}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const artifact of MODEL_CATALOG) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.url).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//);
      expect(artifact.notices).toContain("Copyright");
    }
  });

  it("finds an artifact by id, with or without its version", () => {
    expect(catalogArtifact(NEMOTRON_ARTIFACT.artifactId)).toBe(NEMOTRON_ARTIFACT);
    expect(catalogArtifact(NEMOTRON_ARTIFACT.artifactId, NEMOTRON_ARTIFACT.version)).toBe(
      NEMOTRON_ARTIFACT,
    );
    expect(catalogArtifact(NEMOTRON_ARTIFACT.artifactId, "0")).toBeUndefined();
    expect(catalogArtifact("whisper")).toBeUndefined();
  });
});
