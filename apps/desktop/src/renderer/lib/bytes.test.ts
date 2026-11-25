import { describe, expect, it } from "vitest";
import { formatBytes } from "./bytes";

const plain = (text: string) => text.replace(/\s/gu, " ");

describe("bytes", () => {
  it("shows disk sizes in decimal units, like the Finder", () => {
    expect(plain(formatBytes(18_997_225_856, "fr"))).toBe("19 Go");
    expect(plain(formatBytes(18_997_225_856, "en"))).toBe("19 GB");
    expect(plain(formatBytes(7_240_000_000, "fr"))).toBe("7,2 Go");
    expect(plain(formatBytes(512_000_000, "en"))).toBe("512 MB");
    expect(plain(formatBytes(0, "en"))).toBe("0 byte");
  });

  it("shows memory in binary units", () => {
    expect(plain(formatBytes(32 * 1024 ** 3, "fr", { binary: true }))).toBe("32 Go");
  });
});
