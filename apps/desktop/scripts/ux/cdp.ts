// A minimal DevTools protocol client for the window, used by the redesign's
// capture and click-path scripts (docs/ux-redesign.md §8).

import { setTimeout as sleep } from "node:timers/promises";

export interface Page {
  eval<T = unknown>(expression: string): Promise<T>;
  waitFor(expression: string, timeoutMs?: number): Promise<void>;
  go(route: string): Promise<void>;
  size(width: number, height: number): Promise<void>;
  colorScheme(scheme: "light" | "dark"): Promise<void>;
  screenshot(): Promise<Buffer>;
  /** Clicks the element a CSS selector or its visible text names, like a person. */
  click(target: string): Promise<void>;
  key(key: string, modifiers?: number): Promise<void>;
  /** Moves the pointer to a point, as a mouse does. */
  move(x: number, y: number): Promise<void>;
  /** Clicks at a point. */
  clickAt(x: number, y: number): Promise<void>;
  /** Turns the mouse wheel over a point, as a trackpad does, by `deltaY` pixels. */
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  /** Runs a script in the window before its own, on every load from now on. */
  beforeLoad(source: string): Promise<void>;
  /** Slows the window's CPU down `rate` times (1: as it is). */
  throttle(rate: number): Promise<void>;
  close(): void;
}

interface Target {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export async function connect(port: number, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  let target: Target | undefined;
  while (target === undefined) {
    if (Date.now() > deadline) throw new Error("the window did not open");
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
      target = list.find((t) => t.type === "page" && !t.url.startsWith("devtools:"));
    } catch {
      // Not listening yet.
    }
    if (target === undefined) await sleep(500);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((open, fail) => {
    ws.onopen = open;
    ws.onerror = fail;
  });
  let next = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    const id = message["id"];
    if (typeof id === "number") pending.get(id)?.(message);
  };
  const send = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((done, fail) => {
      next += 1;
      pending.set(next, (message) => {
        if (message["error"] !== undefined) fail(new Error(JSON.stringify(message["error"])));
        else done((message["result"] ?? {}) as Record<string, unknown>);
      });
      ws.send(JSON.stringify({ id: next, method, params }));
    });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const details = result["exceptionDetails"];
    if (details !== undefined) throw new Error(`${expression}: ${JSON.stringify(details)}`);
    return (result["result"] as { value: T }).value;
  };
  const waitFor = async (expression: string, timeout = 10_000) => {
    const end = Date.now() + timeout;
    while (!(await evaluate<boolean>(`Boolean(${expression})`).catch(() => false))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${expression}`);
      await sleep(150);
    }
  };
  const pointAt = async (target: string) => {
    const box = await evaluate<{ x: number; y: number } | null>(`(() => {
      const t = ${JSON.stringify(target)};
      let el = null;
      try { el = document.querySelector(t); } catch {}
      if (el === null) {
        const all = [...document.querySelectorAll('button, a, [role=button], [role=menuitem], [role=tab], [role=option], label, input')];
        el = all.find((e) => (e.getAttribute('aria-label') ?? '').trim() === t || e.textContent.trim() === t) ?? null;
      }
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (box === null) throw new Error(`nothing to click: ${target}`);
    return box;
  };

  return {
    eval: evaluate,
    waitFor,
    async go(route) {
      await evaluate(`location.hash = ${JSON.stringify(`#${route}`)}`);
      await sleep(200);
      await waitFor("document.querySelector('main, #welcome-title') !== null");
    },
    async size(width, height) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: false,
      });
    },
    async colorScheme(scheme) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: scheme }],
      });
    },
    async screenshot() {
      const result = await send("Page.captureScreenshot", { format: "png" });
      return Buffer.from(String(result["data"]), "base64");
    },
    async click(target) {
      const { x, y } = await pointAt(target);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    },
    async key(key, modifiers = 0) {
      for (const type of ["keyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type: type === "keyDown" ? "rawKeyDown" : type,
          key,
          code: key,
          modifiers,
          ...(key === "Tab" ? { windowsVirtualKeyCode: 9 } : {}),
          ...(key === "Escape" ? { windowsVirtualKeyCode: 27 } : {}),
          ...(key === "Enter" ? { windowsVirtualKeyCode: 13 } : {}),
        });
    },
    async move(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    },
    async clickAt(x, y) {
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    },
    async wheel(x, y, deltaY) {
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    },
    async beforeLoad(source) {
      await send("Page.enable");
      await send("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true });
    },
    async throttle(rate) {
      await send("Emulation.setCPUThrottlingRate", { rate });
    },
    close: () => ws.close(),
  };
}
