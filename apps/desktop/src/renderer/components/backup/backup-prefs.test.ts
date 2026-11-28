import { BACKUP_RENDERER_KEYS } from "@sondine/api";
import { THEME_STORAGE_KEY } from "@sondine/ui";
import { describe, expect, it } from "vitest";
import { paraglideOptions } from "../../../../scripts/paraglide-options.mjs";
import { SHORTCUTS_STORAGE_KEY } from "../../shortcuts/registry";

// A backup carries the window's own settings by the keys the window writes
// them under (ADR 048): read from their sources, not copied.

describe("the window's settings a backup carries", () => {
  it("are the keys the window writes", () => {
    expect([...BACKUP_RENDERER_KEYS].toSorted()).toEqual(
      [paraglideOptions.localStorageKey, THEME_STORAGE_KEY, SHORTCUTS_STORAGE_KEY].toSorted(),
    );
  });
});
