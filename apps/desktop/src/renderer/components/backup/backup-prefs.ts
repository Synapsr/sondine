import { BACKUP_RENDERER_KEYS, type BackupRendererPrefs } from "@sondine/api";

// The window's own settings a backup carries (ADR 048): the language, the
// appearance and the shortcuts, from its storage. A restore writes them back
// once, then reloads the window if one changed.

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readRendererPrefs(): BackupRendererPrefs {
  const store = storage();
  const prefs: BackupRendererPrefs = {};
  if (store === null) return prefs;
  for (const key of BACKUP_RENDERER_KEYS) {
    const value = store.getItem(key);
    if (value !== null && value.length <= 16_384) prefs[key] = value;
  }
  return prefs;
}

/** Writes the restored settings; true when one changed, so the window must reload. */
export function applyRendererPrefs(prefs: BackupRendererPrefs): boolean {
  const store = storage();
  if (store === null) return false;
  let changed = false;
  for (const key of BACKUP_RENDERER_KEYS) {
    const value = prefs[key];
    if (value === undefined || store.getItem(key) === value) continue;
    store.setItem(key, value);
    changed = true;
  }
  return changed;
}

// No 0/O, 1/l/I: a passphrase written down on paper reads back.
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** « Générer »: 24 random characters in six groups, about 120 bits. */
export function generatePassphrase(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => void crypto.getRandomValues(bytes),
): string {
  const bytes = new Uint8Array(24);
  random(bytes);
  const characters = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length] ?? "a");
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += 4) {
    groups.push(characters.slice(index, index + 4).join(""));
  }
  return groups.join("-");
}
