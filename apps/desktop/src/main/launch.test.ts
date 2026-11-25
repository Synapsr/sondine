import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVATION_MS, launchReason, openedByLoginwindow, whenInFront } from "./launch";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function frontApp(active = false) {
  const events = new EventEmitter();
  return {
    isActive: () => active,
    onActive: (listener: () => void) => {
      events.on("active", listener);
      return () => events.off("active", listener);
    },
    activate: () => events.emit("active"),
    listeners: () => events.listenerCount("active"),
  };
}

describe("whenInFront", () => {
  it("says so at once for an app already in front", () => {
    const app = frontApp(true);
    const then = vi.fn();
    whenInFront(app, then);
    app.activate();
    vi.advanceTimersByTime(ACTIVATION_MS);
    expect(then.mock.calls).toEqual([[true]]);
  });

  it("waits for macOS to bring the app to the front, and says it once", () => {
    const app = frontApp();
    const then = vi.fn();
    whenInFront(app, then);
    expect(then).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ACTIVATION_MS - 1);
    app.activate();
    app.activate();
    vi.advanceTimersByTime(ACTIVATION_MS);
    expect(then.mock.calls).toEqual([[true]]);
    expect(app.listeners()).toBe(0);
  });

  it("says no for an app left in the background, even if it comes to the front later", () => {
    const app = frontApp();
    const then = vi.fn();
    whenInFront(app, then);
    vi.advanceTimersByTime(ACTIVATION_MS);
    app.activate();
    expect(then.mock.calls).toEqual([[false]]);
    expect(app.listeners()).toBe(0);
  });
});

describe("launchReason", () => {
  it("is the person when macOS brings the launched app to the front", () => {
    const app = frontApp();
    const then = vi.fn();
    launchReason(app, false, then);
    app.activate();
    expect(then.mock.calls).toEqual([["person"]]);
  });

  it("is the background otherwise", () => {
    const then = vi.fn();
    launchReason(frontApp(), false, then);
    vi.advanceTimersByTime(ACTIVATION_MS);
    expect(then.mock.calls).toEqual([["background"]]);
  });

  it("is the login for an app opened at login, even in front", () => {
    const app = frontApp(true);
    const then = vi.fn();
    launchReason(app, true, then);
    app.activate();
    expect(then.mock.calls).toEqual([["login"]]);
  });
});

describe("openedByLoginwindow", () => {
  it("reads who opened the process", () => {
    expect(openedByLoginwindow(() => '    parentASN="loginwindow" ASN:0x0-0x4004: \n')).toBe(true);
    expect(openedByLoginwindow(() => '    parentASN="Finder" ASN:0x0-0x12012: \n')).toBe(false);
    expect(openedByLoginwindow(() => "")).toBe(false);
  });

  it("says no when it cannot be read", () => {
    expect(
      openedByLoginwindow(() => {
        throw new Error("gone");
      }),
    ).toBe(false);
  });
});
