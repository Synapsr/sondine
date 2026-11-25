import { useHotkey } from "@tanstack/react-hotkeys";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { isEditorInteraction } from "../graphical/interaction-boundary";
import {
  createShortcutStorage,
  displayBinding,
  rebind,
  resetBinding,
  resolveBindings,
  type RebindResult,
  type ShortcutBindings,
  type ShortcutId,
  type ShortcutOverrides,
  type ShortcutPlatform,
} from "./registry";

// React side of the shortcut registry: holds the user's overrides (persisted
// in localStorage, per window profile) and registers hotkeys through TanStack
// Hotkeys. Components never call TanStack Hotkeys directly.

interface ShortcutsContextValue {
  readonly platform: ShortcutPlatform;
  readonly bindings: ShortcutBindings;
  rebind(id: ShortcutId, binding: string | null): RebindResult;
  reset(id: ShortcutId): void;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function shortcutPlatform(platform: string): ShortcutPlatform {
  if (platform === "darwin") return "mac";
  return platform === "win32" ? "windows" : "linux";
}

export function ShortcutsProvider({
  platform,
  children,
}: {
  platform: ShortcutPlatform;
  children: ReactNode;
}) {
  const storage = useMemo(() => createShortcutStorage(window.localStorage, platform), [platform]);
  const [overrides, setOverrides] = useState<ShortcutOverrides>(() => storage.load());

  const value = useMemo<ShortcutsContextValue>(() => {
    const commit = (next: ShortcutOverrides) => {
      setOverrides(next);
      storage.save(next);
    };
    return {
      platform,
      bindings: resolveBindings(overrides, platform),
      rebind(id, binding) {
        const result = rebind(overrides, id, binding, platform);
        if (result.ok) commit(result.overrides);
        return result;
      },
      reset: (id) => commit(resetBinding(overrides, id)),
    };
  }, [overrides, platform, storage]);

  return <ShortcutsContext value={value}>{children}</ShortcutsContext>;
}

export function useShortcuts(): ShortcutsContextValue {
  const value = use(ShortcutsContext);
  if (value === null) throw new Error("useShortcuts needs a ShortcutsProvider");
  return value;
}

/**
 * Runs `handler` on the action's current binding; nothing while it is
 * unbound or `enabled` is false (an action outside its scope).
 */
export function useShortcut(
  id: ShortcutId,
  handler: () => void,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  const { bindings } = useShortcuts();
  useHotkey(
    bindings[id],
    (event) => {
      // Keys typed in Graphical's development editor stay the editor's.
      if (isEditorInteraction(event)) return;
      event.preventDefault();
      handler();
    },
    { preventDefault: false, enabled },
  );
}

/** The binding as shown to the user, for example "⌘ K"; null while unbound. */
export function useShortcutLabel(id: ShortcutId): string | null {
  const { bindings, platform } = useShortcuts();
  const binding = bindings[id];
  return binding === null ? null : displayBinding(binding, platform);
}
