import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WESPEAKER_MODEL } from "./wespeaker";

describe("WeSpeaker model pin", () => {
  it("lists the files native/scripts/fetch-models.sh fetches, at the same revision", () => {
    const script = readFileSync(
      new URL("../../../../native/scripts/fetch-models.sh", import.meta.url),
      "utf8",
    );
    const pinned = [...script.matchAll(/^ {2}"(\S+) ([0-9a-f]{64})"$/gmu)].map(([, path, sha]) => ({
      path,
      sha256: sha,
    }));
    expect(pinned).toEqual(WESPEAKER_MODEL.files.map(({ path, sha256 }) => ({ path, sha256 })));
    expect(script).toContain(`wespeaker_commit="${WESPEAKER_MODEL.revision}"`);
    expect(script).toContain(`wespeaker_license_sha256="${WESPEAKER_MODEL.notices[0].sha256}"`);
  });
});
