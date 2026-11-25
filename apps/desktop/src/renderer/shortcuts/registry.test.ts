import { describe, expect, it } from "vitest";
import {
  createShortcutStorage,
  displayBinding,
  findConflicts,
  normalizeBinding,
  parseOverrides,
  rebind,
  resetBinding,
  resolveBindings,
  SHORTCUT_ACTIONS,
  SHORTCUT_IDS,
  SHORTCUTS_STORAGE_KEY,
} from "./registry";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("shortcut registry", () => {
  it("binds Mod+Shift+D to the theme, Mod+K to search, Mod+Shift+P to the palette and Mod+J to the agent by default", () => {
    expect(resolveBindings({}, "mac")).toEqual({
      "theme.toggle": "Mod+Shift+D",
      "search.open": "Mod+K",
      "palette.open": "Mod+Shift+P",
      "agent.open": "Mod+J",
      "player.toggle": "Space",
      "player.back": "ArrowLeft",
      "player.forward": "ArrowRight",
      "player.previous": "ArrowUp",
      "player.next": "ArrowDown",
    });
    expect(findConflicts(resolveBindings({}, "mac"))).toEqual([]);
  });

  it("gives every action a valid default and keywords", () => {
    for (const id of SHORTCUT_IDS) {
      const action = SHORTCUT_ACTIONS[id];
      if (action.defaultBinding !== null)
        expect(normalizeBinding(action.defaultBinding, "mac"), id).not.toBeNull();
      expect(action.keywords.length, id).toBeGreaterThan(0);
    }
  });

  it("normalizes spellings and refuses bindings without a key", () => {
    expect(normalizeBinding("cmd+k", "mac")).toBe("Mod+K");
    expect(normalizeBinding("Meta+K", "mac")).toBe("Mod+K");
    expect(normalizeBinding("ctrl+k", "windows")).toBe("Mod+K");
    expect(normalizeBinding("Mod+Shift", "mac")).toBeNull();
    expect(normalizeBinding("Foo+K", "mac")).toBeNull();
    expect(normalizeBinding("", "mac")).toBeNull();
  });

  it("detects two actions on the same chord, whatever the spelling", () => {
    const bindings = resolveBindings({ "theme.toggle": "Meta+K" }, "mac");
    expect(findConflicts(bindings)).toEqual([
      { binding: "Mod+K", ids: ["theme.toggle", "search.open"] },
    ]);
  });

  it("refuses a rebinding that conflicts or does not parse, and keeps the overrides unchanged", () => {
    expect(rebind({}, "theme.toggle", "cmd+K", "mac")).toEqual({
      ok: false,
      reason: "conflict",
      conflictsWith: "search.open",
    });
    expect(rebind({}, "theme.toggle", "Mod+", "mac")).toMatchObject({ ok: true });
    expect(rebind({}, "theme.toggle", "Shift", "mac")).toEqual({ ok: false, reason: "invalid" });
  });

  it("allows swapping through an unbound step, and resets to the default", () => {
    let overrides = {};
    const steps = [
      ["search.open", null],
      ["theme.toggle", "Mod+K"],
      ["search.open", "D"],
    ] as const;
    for (const [id, binding] of steps) {
      const result = rebind(overrides, id, binding, "mac");
      if (!result.ok) throw new Error(`${id} → ${binding}: ${result.reason}`);
      overrides = result.overrides;
    }
    expect(resolveBindings(overrides, "mac")).toMatchObject({
      "theme.toggle": "Mod+K",
      "search.open": "D",
    });
    const reset = resetBinding(resetBinding(overrides, "theme.toggle"), "search.open");
    expect(reset).toEqual({});
  });

  it("drops stored overrides that are unknown, invalid, or collide with a default", () => {
    const { overrides, dropped } = parseOverrides(
      { "theme.toggle": "Mod+K", "palette.open": "Shift+P", "gone.action": "G", extra: 3 },
      "mac",
    );
    // The whole record fails validation because of the number: defaults win.
    expect(overrides).toEqual({});
    expect(dropped).toEqual(["*"]);

    const second = parseOverrides({ "theme.toggle": "Mod+K", "gone.action": "G" }, "mac");
    expect(second.overrides).toEqual({});
    expect(second.dropped.toSorted()).toEqual(["gone.action", "theme.toggle"]);

    const third = parseOverrides({ "search.open": "Shift+P", "theme.toggle": "Mod+K" }, "mac");
    expect(third.overrides).toEqual({ "search.open": "Shift+P", "theme.toggle": "Mod+K" });
    expect(third.dropped).toEqual([]);
  });

  it("persists overrides and survives a corrupted store", () => {
    const storage = memoryStorage({ [SHORTCUTS_STORAGE_KEY]: "{not json" });
    const store = createShortcutStorage(storage, "mac");
    expect(store.load()).toEqual({});
    store.save({ "theme.toggle": "Shift+D" });
    expect(createShortcutStorage(storage, "mac").load()).toEqual({ "theme.toggle": "Shift+D" });
  });

  it("formats bindings for the platform", () => {
    expect(displayBinding("Mod+K", "mac")).toBe("⌘ K");
    expect(displayBinding("Mod+K", "windows")).toBe("Ctrl+K");
  });
});
