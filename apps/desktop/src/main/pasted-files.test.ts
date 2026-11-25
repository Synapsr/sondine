import { describe, expect, it } from "vitest";
import { filesOfUriList } from "./pasted-files";

describe("pasted files", () => {
  it("reads the local files of a uri list", () => {
    expect(
      filesOfUriList(
        "# copied\r\nfile:///Users/me/Desktop/M%C3%A9mo%201.qta\r\nhttps://example.com/a.m4a\nfile:///tmp/b.m4a\n",
      ),
    ).toEqual(["/Users/me/Desktop/Mémo 1.qta", "/tmp/b.m4a"]);
  });
});
