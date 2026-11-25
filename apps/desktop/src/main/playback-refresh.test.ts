import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAYBACK_RECHECK_MS, refreshPidsOnPlayback } from "./playback-refresh";

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshPidsOnPlayback", () => {
  it("refreshes the excluded PIDs when playback starts, and once more a second later", () => {
    vi.useFakeTimers();
    const contents = new EventEmitter();
    const refresh = vi.fn();
    refreshPidsOnPlayback(contents, refresh);
    expect(refresh).not.toHaveBeenCalled();

    contents.emit("media-started-playing");
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PLAYBACK_RECHECK_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    // Nothing more until the next playback: no polling.
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    contents.emit("media-started-playing");
    vi.advanceTimersByTime(PLAYBACK_RECHECK_MS);
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});
