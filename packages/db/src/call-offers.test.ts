import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callOffersEnabled,
  mutedCallApps,
  muteCallApp,
  setCallOffersEnabled,
  unmuteCallApp,
} from "./call-offers";
import { t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

describe("call offers settings", () => {
  it("is on by default and remembers being turned off", () => {
    expect(callOffersEnabled(temp.db)).toBe(true);
    setCallOffersEnabled(temp.db, false, t0);
    expect(callOffersEnabled(temp.db)).toBe(false);
    setCallOffersEnabled(temp.db, true, t0 + 1);
    expect(callOffersEnabled(temp.db)).toBe(true);
  });

  it("keeps the muted apps once each, the latest first, until offered again", () => {
    expect(mutedCallApps(temp.db)).toEqual([]);
    muteCallApp(temp.db, { bundleId: "com.hnc.Discord", name: "Discord" }, t0);
    muteCallApp(temp.db, { bundleId: "us.zoom.xos", name: "zoom.us" }, t0 + 1);
    muteCallApp(temp.db, { bundleId: "com.hnc.Discord", name: "Discord" }, t0 + 2);
    expect(mutedCallApps(temp.db).map((app) => app.bundleId)).toEqual([
      "com.hnc.Discord",
      "us.zoom.xos",
    ]);
    unmuteCallApp(temp.db, "com.hnc.Discord", t0 + 3);
    expect(mutedCallApps(temp.db)).toEqual([{ bundleId: "us.zoom.xos", name: "zoom.us" }]);
  });
});
