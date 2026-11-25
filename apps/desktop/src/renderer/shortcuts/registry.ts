import {
  formatForDisplay,
  hasNonModifierKey,
  normalizeHotkey,
  validateHotkey,
  type HotkeyChord,
} from "@tanstack/react-hotkeys";
import * as z from "zod";
import { m } from "../paraglide/messages.js";

// The one typed shortcut registry (architecture §11, handbook web
// conventions): action ids, labels, keywords, scopes, default bindings,
// persisted overrides, conflict detection and display. The command palette
// and the direct hotkeys both read it. TanStack Hotkeys (beta) is used only
// here and in use-shortcut.ts, so it can be replaced.

export type ShortcutPlatform = "mac" | "windows" | "linux";

export const SHORTCUT_IDS = [
  "theme.toggle",
  "search.open",
  "palette.open",
  "agent.open",
  "player.toggle",
  "player.back",
  "player.forward",
  "player.previous",
  "player.next",
] as const;
export type ShortcutId = (typeof SHORTCUT_IDS)[number];

export interface ShortcutAction {
  readonly label: () => string;
  /** Extra words the command palette matches, in both languages. */
  readonly keywords: readonly string[];
  /**
   * Where the shortcut fires (single keys never while typing, nor on a
   * control that uses the key itself): anywhere in the window, while an
   * episode is loaded in the player, or on an episode's page.
   */
  readonly scope: "global" | "player" | "episode";
  readonly defaultBinding: string | null;
}

export const SHORTCUT_ACTIONS: Readonly<Record<ShortcutId, ShortcutAction>> = {
  "theme.toggle": {
    label: () => m.shortcut_toggle_theme(),
    keywords: ["theme", "dark", "light", "thème", "sombre", "clair"],
    scope: "global",
    // A plain letter flipped the theme on any stray keypress.
    defaultBinding: "Mod+Shift+D",
  },
  "search.open": {
    label: () => m.shortcut_search(),
    keywords: ["search", "find", "rechercher", "chercher", "trouver"],
    scope: "global",
    defaultBinding: "Mod+K",
  },
  "palette.open": {
    label: () => m.shortcut_command_palette(),
    keywords: ["command", "palette", "commande", "actions"],
    scope: "global",
    defaultBinding: "Mod+Shift+P",
  },
  "agent.open": {
    label: () => m.shortcut_agent(),
    keywords: ["agent", "ask", "chat", "claude", "demander", "discussion"],
    scope: "global",
    defaultBinding: "Mod+J",
  },
  "player.toggle": {
    label: () => m.shortcut_player_toggle(),
    keywords: ["play", "pause", "lecture", "lire"],
    scope: "player",
    defaultBinding: "Space",
  },
  "player.back": {
    label: () => m.shortcut_player_back(),
    keywords: ["back", "rewind", "reculer", "arrière"],
    scope: "player",
    defaultBinding: "ArrowLeft",
  },
  "player.forward": {
    label: () => m.shortcut_player_forward(),
    keywords: ["forward", "skip", "avancer", "avant"],
    scope: "player",
    defaultBinding: "ArrowRight",
  },
  "player.previous": {
    label: () => m.shortcut_player_previous(),
    keywords: ["previous", "sentence", "précédent", "phrase"],
    scope: "episode",
    defaultBinding: "ArrowUp",
  },
  "player.next": {
    label: () => m.shortcut_player_next(),
    keywords: ["next", "sentence", "suivant", "phrase"],
    scope: "episode",
    defaultBinding: "ArrowDown",
  },
};

/** The user's changes: a binding string, or null to unbind. Missing ids keep their default. */
export type ShortcutOverrides = Readonly<Partial<Record<ShortcutId, string | null>>>;

export type ShortcutBindings = Readonly<Record<ShortcutId, HotkeyChord | null>>;

export function isShortcutId(value: string): value is ShortcutId {
  return SHORTCUT_IDS.some((id) => id === value);
}

/** The canonical chord for a binding, or null when it is not a usable shortcut. */
export function normalizeBinding(binding: string, platform: ShortcutPlatform): HotkeyChord | null {
  if (!validateHotkey(binding).valid || !hasNonModifierKey(binding, platform)) return null;
  return normalizeHotkey(binding, platform);
}

export function resolveBindings(
  overrides: ShortcutOverrides,
  platform: ShortcutPlatform,
): ShortcutBindings {
  const entry = (id: ShortcutId): HotkeyChord | null => {
    const override = overrides[id];
    const binding = override === undefined ? SHORTCUT_ACTIONS[id].defaultBinding : override;
    return binding === null ? null : normalizeBinding(binding, platform);
  };
  return {
    "theme.toggle": entry("theme.toggle"),
    "search.open": entry("search.open"),
    "palette.open": entry("palette.open"),
    "agent.open": entry("agent.open"),
    "player.toggle": entry("player.toggle"),
    "player.back": entry("player.back"),
    "player.forward": entry("player.forward"),
    "player.previous": entry("player.previous"),
    "player.next": entry("player.next"),
  };
}

export interface ShortcutConflict {
  readonly binding: HotkeyChord;
  readonly ids: readonly ShortcutId[];
}

/** Bindings used by more than one action. `Mod+K` and `Meta+K` are the same chord on a Mac. */
export function findConflicts(bindings: ShortcutBindings): ShortcutConflict[] {
  const byBinding = new Map<HotkeyChord, ShortcutId[]>();
  for (const id of SHORTCUT_IDS) {
    const binding = bindings[id];
    if (binding === null) continue;
    byBinding.set(binding, [...(byBinding.get(binding) ?? []), id]);
  }
  return [...byBinding]
    .filter(([, ids]) => ids.length > 1)
    .map(([binding, ids]) => ({ binding, ids }));
}

export type RebindResult =
  | { readonly ok: true; readonly overrides: ShortcutOverrides }
  | { readonly ok: false; readonly reason: "invalid" }
  | { readonly ok: false; readonly reason: "conflict"; readonly conflictsWith: ShortcutId };

/** Binds `id` to `binding` (null unbinds it), refusing invalid and conflicting bindings. */
export function rebind(
  overrides: ShortcutOverrides,
  id: ShortcutId,
  binding: string | null,
  platform: ShortcutPlatform,
): RebindResult {
  if (binding !== null && normalizeBinding(binding, platform) === null)
    return { ok: false, reason: "invalid" };
  const next: ShortcutOverrides = { ...overrides, [id]: binding };
  const conflict = findConflicts(resolveBindings(next, platform)).find((found) =>
    found.ids.includes(id),
  );
  const other = conflict?.ids.find((candidate) => candidate !== id);
  if (other !== undefined) return { ok: false, reason: "conflict", conflictsWith: other };
  return { ok: true, overrides: next };
}

/** Drops the override so `id` uses its default again. */
export function resetBinding(overrides: ShortcutOverrides, id: ShortcutId): ShortcutOverrides {
  const { [id]: _removed, ...rest } = overrides;
  return rest;
}

const StoredOverrides = z.record(z.string(), z.string().max(64).nullable());

/**
 * Reads persisted overrides, dropping unknown actions, invalid bindings, and
 * any override that collides with another binding (that action falls back to
 * its default). Never throws: a broken store means defaults.
 */
export function parseOverrides(
  raw: unknown,
  platform: ShortcutPlatform,
): { overrides: ShortcutOverrides; dropped: string[] } {
  const parsed = StoredOverrides.safeParse(raw);
  if (!parsed.success)
    return { overrides: {}, dropped: raw === null || raw === undefined ? [] : ["*"] };
  let overrides: ShortcutOverrides = {};
  const dropped: string[] = [];
  for (const [id, binding] of Object.entries(parsed.data)) {
    if (!isShortcutId(id)) {
      dropped.push(id);
      continue;
    }
    const result = rebind(overrides, id, binding, platform);
    if (result.ok) overrides = result.overrides;
    else dropped.push(id);
  }
  // An override can also collide with a default applied after it.
  for (const conflict of findConflicts(resolveBindings(overrides, platform))) {
    for (const id of conflict.ids) {
      if (overrides[id] !== undefined) {
        overrides = resetBinding(overrides, id);
        dropped.push(id);
      }
    }
  }
  return { overrides, dropped };
}

/** "⌘ K" on a Mac, "Ctrl+K" elsewhere. */
export function displayBinding(binding: HotkeyChord, platform: ShortcutPlatform): string {
  return formatForDisplay(binding, { platform });
}

export interface ShortcutStorage {
  load(): ShortcutOverrides;
  save(overrides: ShortcutOverrides): void;
}

export const SHORTCUTS_STORAGE_KEY = "sondine.shortcuts";

export function createShortcutStorage(
  storage: Pick<Storage, "getItem" | "setItem">,
  platform: ShortcutPlatform,
  key = SHORTCUTS_STORAGE_KEY,
): ShortcutStorage {
  return {
    load() {
      try {
        const text = storage.getItem(key);
        return text === null ? {} : parseOverrides(JSON.parse(text), platform).overrides;
      } catch {
        return {};
      }
    },
    save(overrides) {
      storage.setItem(key, JSON.stringify(overrides));
    },
  };
}
