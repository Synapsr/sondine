import { describe, expect, it } from "vitest";
import { runFrames, type FramePage } from "./sky-surface";

// The opening's moving sky stays within the always-on budget (AGENTS.md):
// no frame while the window is hidden or minimized, none once it is gone.

function fakePage() {
  let next = 1;
  const pending = new Map<number, (now: number) => void>();
  const listeners = new Set<() => void>();
  const page: FramePage & { hidden: boolean } = {
    hidden: false,
    addEventListener: (_type: "visibilitychange", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "visibilitychange", listener: () => void) =>
      listeners.delete(listener),
    requestAnimationFrame: (callback: (now: number) => void) => {
      pending.set(next, callback);
      return next++;
    },
    cancelAnimationFrame: (handle: number) => pending.delete(handle),
  };
  return {
    page,
    pending,
    listeners,
    /** Runs the frames due now, as the browser does at a vsync. */
    frame(now: number) {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback(now);
    },
    setHidden(hidden: boolean) {
      page.hidden = hidden;
      for (const listener of listeners) listener();
    },
  };
}

describe("the opening's sky frames", () => {
  it("draws at each frame while the window shows", () => {
    const fake = fakePage();
    const drawn: number[] = [];
    runFrames((now) => drawn.push(now), false, fake.page);
    fake.frame(16);
    fake.frame(33);
    expect(drawn).toEqual([16, 33]);
    expect(fake.pending.size).toBe(1);
  });

  it("stops while the window is hidden or minimized, and goes on when it shows", () => {
    const fake = fakePage();
    const drawn: number[] = [];
    runFrames((now) => drawn.push(now), false, fake.page);
    fake.frame(16);
    fake.setHidden(true);
    expect(fake.pending.size).toBe(0);
    fake.frame(33);
    expect(drawn).toEqual([16]);
    fake.setHidden(false);
    fake.frame(50);
    expect(drawn).toEqual([16, 50]);
  });

  it("asks for no frame when it starts hidden", () => {
    const fake = fakePage();
    fake.page.hidden = true;
    runFrames(() => {}, false, fake.page);
    expect(fake.pending.size).toBe(0);
  });

  it("leaves nothing behind once stopped", () => {
    const fake = fakePage();
    const drawn: number[] = [];
    const stop = runFrames((now) => drawn.push(now), false, fake.page);
    fake.frame(16);
    stop();
    expect(fake.pending.size).toBe(0);
    expect(fake.listeners.size).toBe(0);
    fake.setHidden(false);
    fake.frame(33);
    expect(drawn).toEqual([16]);
  });

  it("draws one frame only under reduced motion, even after the window hides and shows", () => {
    const fake = fakePage();
    const drawn: number[] = [];
    runFrames((now) => drawn.push(now), true, fake.page);
    fake.frame(16);
    fake.setHidden(true);
    fake.setHidden(false);
    fake.frame(33);
    expect(drawn).toEqual([16]);
  });
});
