import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSelfPlaybacksBetween,
  notePlaying,
  noteStopped,
  PLAYBACK_LEASE_MS,
  reroutePlayback,
} from "./self-playback";
import { t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const all = () => loadSelfPlaybacksBetween(temp.db, 0, t0 + 3_600_000);

describe("self playbacks", () => {
  it("renews one playback while the player keeps saying so, and ends it when it stops", () => {
    notePlaying(temp.db, { route: "speakers", nowMs: t0 });
    notePlaying(temp.db, { route: "speakers", nowMs: t0 + 3_000 });
    expect(all()).toEqual([
      { startedWallMs: t0, endedWallMs: t0 + 3_000 + PLAYBACK_LEASE_MS, route: "speakers" },
    ]);
    noteStopped(temp.db, t0 + 4_000);
    expect(all()).toEqual([{ startedWallMs: t0, endedWallMs: t0 + 4_000, route: "speakers" }]);
  });

  it("changes way at once when the output changes while it plays, and not when it does not", () => {
    notePlaying(temp.db, { route: "headphones", nowMs: t0 });
    reroutePlayback(temp.db, { route: "speakers", nowMs: t0 + 1_000 });
    reroutePlayback(temp.db, { route: "speakers", nowMs: t0 + 2_000 });
    expect(all()).toEqual([
      { startedWallMs: t0, endedWallMs: t0 + 1_000, route: "headphones" },
      { startedWallMs: t0 + 1_000, endedWallMs: t0 + PLAYBACK_LEASE_MS, route: "speakers" },
    ]);
    // Nothing plays: a change of output records nothing.
    reroutePlayback(temp.db, { route: "headphones", nowMs: t0 + 60_000 });
    expect(all()).toHaveLength(2);
  });

  it("starts anew after its lease ran out, and when the route changes", () => {
    notePlaying(temp.db, { route: "speakers", nowMs: t0 });
    // The window died: no renewal, no stop. Later it plays again.
    notePlaying(temp.db, { route: "speakers", nowMs: t0 + 60_000 });
    notePlaying(temp.db, { route: "headphones", nowMs: t0 + 62_000 });
    expect(all()).toEqual([
      { startedWallMs: t0, endedWallMs: t0 + PLAYBACK_LEASE_MS, route: "speakers" },
      { startedWallMs: t0 + 60_000, endedWallMs: t0 + 62_000, route: "speakers" },
      {
        startedWallMs: t0 + 62_000,
        endedWallMs: t0 + 62_000 + PLAYBACK_LEASE_MS,
        route: "headphones",
      },
    ]);
  });
});
