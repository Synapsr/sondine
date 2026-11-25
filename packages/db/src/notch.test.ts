import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notchOpensOnHover, setNotchOpensOnHover } from "./notch";
import { t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

describe("the notch setting", () => {
  it("opens on hover until the user chooses a click, and back", () => {
    expect(notchOpensOnHover(temp.db)).toBe(true);
    setNotchOpensOnHover(temp.db, false, t0);
    expect(notchOpensOnHover(temp.db)).toBe(false);
    setNotchOpensOnHover(temp.db, true, t0 + 1);
    expect(notchOpensOnHover(temp.db)).toBe(true);
  });
});
