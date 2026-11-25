// Runs the built page script (every site but YouTube) against a fake page.

import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { asJson, FakeEvent, script } from "./bundled.ts";

const code = script("pages");

class FakeMedia {
  paused = true;
  muted = false;
  ended = false;
  volume = 1;
}
class FakeVideo extends FakeMedia {}
class FakeAudio extends FakeMedia {}

class FakeTarget {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, target: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, target });
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }

  count(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
  }
}

const URL_HERE = "https://www.example.org/podcast/42";

/** A page's word without its id, checked to be above any tab id. */
function withoutId(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return message;
  if (!("page" in message) || !("type" in message)) return message;
  const { page: said, type } = message;
  if (typeof said !== "object" || said === null || !("id" in said)) return message;
  const { id, ...rest } = said;
  expect(id).toBeGreaterThanOrEqual(2 ** 30);
  return { type, ...rest };
}

function page(media: FakeMedia[] = [], href = URL_HERE) {
  const document = Object.assign(new FakeTarget(), {
    querySelectorAll: (selector: string) => (selector === "video, audio" ? media : []),
    title: "Épisode 42 – Le podcast",
  });
  const window = Object.assign(new FakeTarget(), { postMessage: () => undefined });
  const location = { href };
  const sent: unknown[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const runtime = {
    id: "nnieeegenbmpfllllldjpkolkldjmmdb",
    refuses: false,
    sendMessage(message: unknown): Promise<void> {
      if (runtime.refuses) return Promise.reject(new Error("Extension context invalidated."));
      sent.push(message);
      return Promise.resolve();
    },
    onMessage: new FakeEvent<[unknown]>(),
  };
  const context = createContext({
    chrome: { runtime },
    document,
    window,
    location,
    // The two media elements are one class in a browser; both answer it.
    HTMLMediaElement: FakeMedia,
    setInterval: (run: () => void) => {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    },
    clearInterval: (id: number) => timers.delete(id),
    URL,
    AbortController,
    CustomEvent,
    Event,
  });
  new Script(code).runInContext(context);
  return {
    document,
    window,
    location,
    runtime,
    timers,
    /** What the page said, without its id. */
    said: () => asJson(sent).map(withoutId),
    fire: (target: FakeMedia, type: string) => document.dispatch(type, target),
    tick: () => {
      for (const run of timers.values()) run();
    },
  };
}

const heard = (url = URL_HERE) => ({
  type: "page",
  url,
  title: "Épisode 42 – Le podcast",
  aloud: true,
});

describe("page script", () => {
  it("says nothing and runs nothing while the page is silent", () => {
    const muted = Object.assign(new FakeVideo(), { paused: false, muted: true });
    const tab = page([new FakeAudio(), muted]);
    tab.fire(muted, "play");
    tab.fire(muted, "volumechange");
    expect(tab.said()).toEqual([]);
    expect(tab.timers.size).toBe(0);
  });

  it("says the page is heard when a sound starts, every 30 s while it lasts, and when it stops", () => {
    const audio = new FakeAudio();
    const tab = page([audio]);
    audio.paused = false;
    tab.fire(audio, "play");
    tab.fire(audio, "playing");
    expect(tab.said()).toEqual([heard()]);
    expect(tab.timers.size).toBe(1);
    tab.tick();
    expect(tab.said()).toEqual([heard(), heard()]);
    audio.volume = 0;
    tab.fire(audio, "volumechange");
    expect(tab.said().at(-1)).toEqual({ ...heard(), aloud: false });
    expect(tab.timers.size).toBe(0);
  });

  it("hears a video already playing when it starts, and says it is gone with the page", () => {
    const video = Object.assign(new FakeVideo(), { paused: false });
    const tab = page([video]);
    expect(tab.said()).toEqual([heard()]);
    tab.window.dispatch("pagehide", tab.window);
    expect(tab.said().at(-1)).toEqual({ ...heard(), aloud: false });
    expect(tab.timers.size).toBe(0);
  });

  it("says nothing more once silent, even when the silent page moves or changes", () => {
    const audio = Object.assign(new FakeAudio(), { paused: false });
    const tab = page([audio]);
    audio.paused = true;
    tab.fire(audio, "pause");
    // Silent: another address in the page, a volume change; nothing goes out.
    tab.location.href = "https://www.example.org/podcast/43";
    tab.document.title = "Épisode 43";
    tab.fire(audio, "volumechange");
    tab.fire(audio, "emptied");
    expect(tab.said()).toEqual([heard(), { ...heard(), aloud: false }]);
  });

  it("stops once the browser refuses its messages as an orphan's", async () => {
    const video = Object.assign(new FakeVideo(), { paused: false });
    const tab = page([video]);
    tab.runtime.refuses = true;
    tab.tick();
    await new Promise((settle) => setTimeout(settle, 0));
    expect(tab.timers.size).toBe(0);
    expect(tab.document.count()).toBe(0);
  });
});
