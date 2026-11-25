import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportPlayback, RENEW_MS } from "./playback-report";
import type { PlayerSnapshot, PlayerStatus } from "./player-store";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakePlayer() {
  const listeners = new Set<() => void>();
  let status: PlayerStatus = "idle";
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => ({ status }) as PlayerSnapshot,
    set(next: PlayerStatus) {
      status = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("reportPlayback", () => {
  it("reports playing at once and every few seconds, and a stop once", () => {
    const player = fakePlayer();
    const reports: boolean[] = [];
    const stop = reportPlayback(player, (playing) => reports.push(playing));
    player.set("loading");
    expect(reports).toEqual([]);
    player.set("playing");
    player.set("playing");
    expect(reports).toEqual([true]);
    vi.advanceTimersByTime(RENEW_MS * 2);
    expect(reports).toEqual([true, true, true]);
    player.set("paused");
    player.set("ended");
    vi.advanceTimersByTime(RENEW_MS * 2);
    expect(reports).toEqual([true, true, true, false]);
    player.set("playing");
    stop();
    expect(reports).toEqual([true, true, true, false, true, false]);
  });
});
