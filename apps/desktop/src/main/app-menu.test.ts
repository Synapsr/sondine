import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { applicationMenu } from "./app-menu";

/** The labels of every item, separators aside; null where Electron's English one would show. */
function labels(items: readonly MenuItemConstructorOptions[]): (string | null)[] {
  return items
    .filter((item) => item.type !== "separator")
    .flatMap((item) => [
      item.label ?? null,
      ...(Array.isArray(item.submenu) ? labels(item.submenu) : []),
    ]);
}

describe("applicationMenu", () => {
  const menu = (locale: "fr" | "en") =>
    labels(applicationMenu(locale, { edit: vi.fn(), development: false }));

  it("says every item in the OS locale", () => {
    const fr = menu("fr");
    const en = menu("en");
    expect(fr).not.toContain(null);
    expect(en).not.toContain(null);
    // Only the app's name is the same in both.
    expect(fr.filter((label, index) => label === en[index])).toEqual(["Sondine"]);
  });

  it("has the View menu in development only", () => {
    expect(menu("en")).not.toContain("View");
    expect(labels(applicationMenu("en", { edit: vi.fn(), development: true }))).toContain("View");
  });
});
