import { describe, expect, it, vi } from "vitest";
import {
  type ColorSchemeQuery,
  createThemeController,
  isTheme,
  type ThemeTarget,
} from "./theme-controller";
import { createLocalStorageThemeStorage, createMemoryThemeStorage } from "./theme-storage";

function fakeTarget() {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const target = {
    classList: {
      toggle(token: string, force?: boolean) {
        const on = force ?? !classes.has(token);
        if (on) classes.add(token);
        else classes.delete(token);
        return on;
      },
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    style: { colorScheme: "" },
  } satisfies ThemeTarget;
  return { target, classes, attributes };
}

function fakeQuery(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener: (_type: "change", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: () => void) => listeners.delete(listener),
  } satisfies ColorSchemeQuery;
  return {
    query,
    listeners,
    setDark(dark: boolean) {
      query.matches = dark;
      for (const listener of listeners) listener();
    },
  };
}

describe("theme controller", () => {
  it("resolves system from the color scheme query and applies it on connect", () => {
    const { target, classes, attributes } = fakeTarget();
    const { query } = fakeQuery(true);
    const controller = createThemeController({ target, query });
    expect(controller.getSnapshot()).toEqual({ theme: "system", resolvedTheme: "dark" });
    controller.connect();
    expect([...classes]).toEqual(["dark"]);
    expect(attributes.get("data-theme")).toBe("dark");
    expect(target.style.colorScheme).toBe("dark");
  });

  it("follows system changes while the theme is system", () => {
    const { target, classes } = fakeTarget();
    const system = fakeQuery(false);
    const controller = createThemeController({ target, query: system.query });
    const disconnect = controller.connect();
    const listener = vi.fn();
    controller.subscribe(listener);

    system.setDark(true);
    expect(controller.getSnapshot().resolvedTheme).toBe("dark");
    expect(classes.has("dark")).toBe(true);
    expect(classes.has("light")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    controller.setTheme("light");
    system.setDark(false);
    system.setDark(true);
    expect(controller.getSnapshot()).toEqual({ theme: "light", resolvedTheme: "light" });

    disconnect();
    expect(system.listeners.size).toBe(0);
  });

  it("persists choices and toggles from the mode in effect", () => {
    const storage = createMemoryThemeStorage();
    const { target } = fakeTarget();
    const controller = createThemeController({ storage, target, query: fakeQuery(true).query });
    controller.connect();

    controller.toggleTheme();
    expect(controller.getSnapshot()).toEqual({ theme: "light", resolvedTheme: "light" });
    expect(storage.load()).toBe("light");

    controller.toggleTheme();
    expect(storage.load()).toBe("dark");
    expect(target.style.colorScheme).toBe("dark");
  });

  it("starts from the stored theme and keeps a stable snapshot between changes", () => {
    const controller = createThemeController({
      storage: createMemoryThemeStorage("dark"),
      defaultTheme: "light",
    });
    const first = controller.getSnapshot();
    expect(first.theme).toBe("dark");
    controller.setTheme("dark");
    expect(controller.getSnapshot()).toBe(first);
  });

  it("applies themes reported by the storage", () => {
    let report: ((theme: "light" | "dark" | "system") => void) | undefined;
    const controller = createThemeController({
      storage: {
        load: () => null,
        save: () => {},
        subscribe(onChange) {
          report = onChange;
          return () => {
            report = undefined;
          };
        },
      },
      defaultTheme: "light",
    });
    const disconnect = controller.connect();
    report?.("dark");
    expect(controller.getSnapshot().resolvedTheme).toBe("dark");
    disconnect();
    expect(report).toBeUndefined();
  });
});

describe("theme storage", () => {
  it("validates themes", () => {
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("sepia")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it("falls back to null without localStorage", () => {
    vi.stubGlobal("localStorage", undefined);
    try {
      const storage = createLocalStorageThemeStorage();
      expect(storage.load()).toBeNull();
      expect(() => storage.save("dark")).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads and writes localStorage when present", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    try {
      const storage = createLocalStorageThemeStorage("test.theme");
      storage.save("dark");
      expect(values.get("test.theme")).toBe("dark");
      expect(storage.load()).toBe("dark");
      values.set("test.theme", "neon");
      expect(storage.load()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
