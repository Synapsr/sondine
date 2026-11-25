import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: {} }));
const { isOpenCopy } = await import("./context-files");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sondine-open-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("open copies", () => {
  it("opens only a file core put in its own temporary folder", () => {
    mkdirSync(join(root, "sondine-open-abc"));
    const copy = join(root, "sondine-open-abc", "Rapport.pdf");
    writeFileSync(copy, "x");
    expect(isOpenCopy(copy, root)).toBe(true);

    writeFileSync(join(root, "other.pdf"), "x");
    expect(isOpenCopy(join(root, "other.pdf"), root)).toBe(false);
    expect(isOpenCopy(join(root, "sondine-open-abc"), root)).toBe(false);
    // A link inside the folder that leads elsewhere is not a copy.
    symlinkSync("/etc/hosts", join(root, "sondine-open-abc", "hosts"));
    expect(isOpenCopy(join(root, "sondine-open-abc", "hosts"), root)).toBe(false);
    expect(isOpenCopy(join(root, "missing"), root)).toBe(false);
  });
});
