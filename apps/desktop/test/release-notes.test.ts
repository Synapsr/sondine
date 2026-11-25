import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseNotes } from "../scripts/release-notes.mjs";

describe("the release notes the app carries", () => {
  it("are the version's section, and nothing of the others", () => {
    const changelog =
      "# Changelog\n\n## 0.8.0 — today\n\nOne.\n\n### New\n\n#### A\n\nB.\n\n## 0.7.0\n\nOld.\n";
    expect(releaseNotes(changelog, "0.8.0")).toBe("One.\n\n### New\n\n#### A\n\nB.");
    expect(releaseNotes(changelog, "0.7.0")).toBe("Old.");
    expect(releaseNotes(changelog, "0.8")).toBe("");
  });

  it("exist for this version", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const { version } = JSON.parse(
      readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"),
    ) as { version: string };
    expect(releaseNotes(readFileSync(resolve(root, "CHANGELOG.md"), "utf8"), version)).not.toBe("");
  });
});
