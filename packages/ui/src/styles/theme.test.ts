import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Loads the real stylesheet through Tailwind's compiler so the checks see the
// same theme the app builds with.
const require = createRequire(import.meta.url);
const tailwindDir = path.dirname(require.resolve("tailwindcss/package.json"));
const tailwind: typeof import("tailwindcss") = await import(
  pathToFileURL(path.join(tailwindDir, "dist/lib.mjs")).href
);
const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.dirname(stylesDir);

async function loadStylesheet(id: string, base: string) {
  const file =
    id === "tailwindcss"
      ? path.join(tailwindDir, "index.css")
      : id.startsWith("tailwindcss/")
        ? path.join(tailwindDir, id.slice("tailwindcss/".length))
        : path.resolve(base, id);
  return { path: file, base: path.dirname(file), content: await readFile(file, "utf8") };
}

const entry = path.join(stylesDir, "index.css");
// oxlint-disable-next-line no-underscore-dangle -- Tailwind's only API that compiles one candidate at a time.
const designSystem = await tailwind.__unstable__loadDesignSystem(await readFile(entry, "utf8"), {
  base: stylesDir,
  loadStylesheet,
});

function css(candidate: string): string | null {
  return designSystem.candidatesToCss([candidate])[0] ?? null;
}

describe("Tailwind mapping", () => {
  it.each([
    ["bg-color-1", "background-color: var(--color-1)"],
    ["bg-neutral-4-transparent", "background-color: var(--neutral-4-transparent)"],
    ["text-cte-text-muted", "color: var(--cte-text-muted)"],
    ["text-body-s", "font-size: var(--size-s)"],
    ["text-body-s", "line-height: var(--tw-leading, var(--line-s))"],
    ["text-body-s", "letter-spacing: var(--tw-tracking, var(--letter-spacing-s))"],
    ["text-display-m", "font-size: var(--display-size-m)"],
    ["tracking-l", "letter-spacing: var(--tracking-l)"],
    ["font-body", "font-family: var(--font-body)"],
    ["font-display", "--weight-heavy: var(--weight-display-heavy)"],
    ["font-medium", "font-weight: var(--weight-medium)"],
    ["p-m", "padding: var(--space-m)"],
    ["gap-xs", "gap: var(--space-xs)"],
    ["p-zero", "padding: var(--space-zero)"],
    ["size-s", "var(--space-s)"],
    ["corner-s", "border-radius: var(--radius-s)"],
    ["corner-l", "border-radius: var(--radius-l)"],
    ["edge-m", "border-width: var(--border-m)"],
    ["shadow-m", "var(--shadow-m)"],
    ["ring-s", "calc(var(--border-s) + var(--tw-ring-offset-width))"],
    ["inset-ring-s", "var(--border-s)"],
    ["ease-motion", "transition-timing-function: var(--motion-easing)"],
    ["duration-motion-large", "transition-duration: var(--motion-large-duration)"],
    ["transition-colors", "transition-duration: var(--tw-duration, var(--motion-duration))"],
    ["focus-ring", "outline: var(--focus-ring-outline, 2px solid var(--cte-focus))"],
    ["focus-ring-within", ":has(:focus-visible)"],
    ["focus-ring-within", "outline: var(--focus-ring-outline, 2px solid var(--cte-focus))"],
    ["control-disabled:text-neutral-6", "[data-disabled]:not([data-pending])"],
  ])("%s generates %s", (candidate, expected) => {
    expect(css(candidate)).toContain(expected);
  });

  // The nearest theme scope decides the mode: a light ThemeScope inside a dark
  // page must not match dark:, and a dark scope inside a light one must.
  it("resolves dark: from the nearest theme scope", () => {
    const output = css("dark:text-neutral-1") ?? "";
    expect(output).toContain("@container style(--theme-mode: dark)");
    expect(output).toContain(':where(.dark, [data-theme="dark"])');
    expect(output).toContain(':not(:where(.light, [data-theme="light"]))');
    expect(output).not.toMatch(/\.dark \*|\[data-theme="dark"\] \*/);
  });

  it.each([
    "text-sm",
    "rounded-md",
    "shadow-lg",
    "font-semibold",
    "bg-white",
    "text-gray-500",
    "p-4",
    "w-64",
    "ease-out",
  ])("drops Tailwind's default %s", (candidate) => {
    expect(css(candidate)).toBeNull();
  });

  it("emits Graphical's theme variables and the base text", async () => {
    const compiler = await tailwind.compile(await readFile(entry, "utf8"), {
      base: stylesDir,
      loadStylesheet,
    });
    const output = compiler.build([]);
    for (const declaration of [
      '--font-body: "Allo", sans-serif',
      "--tracking-xl: 0.02em",
      "--radius-full: 9999px",
      "--neutral-1: #000000",
    ]) {
      expect(output).toContain(declaration);
    }
    expect(output).toContain('[data-theme="dark"]');
    expect(output).toContain('font-family: "Allo"');
    expect(output).toContain("text-wrap: pretty");
    expect(output).toContain("font-optical-sizing: auto");
  });
});

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, dirent.name);
    if (dirent.isDirectory()) files.push(...(await sourceFiles(file)));
    else if (dirent.name.endsWith(".tsx") && !dirent.name.endsWith(".test.tsx")) files.push(file);
  }
  return files;
}

// Markers and tokens that parse as utilities but intentionally emit no CSS.
const NO_CSS = new Set(["group", "peer"]);

describe("class names in packages/ui", () => {
  it("only use utilities that exist in the theme", async () => {
    const unknown: string[] = [];
    for (const file of await sourceFiles(srcDir)) {
      const source = await readFile(file, "utf8");
      const literals = source.matchAll(/"([^"\n]*)"|`([^`]*)`/g);
      for (const match of literals) {
        const text = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
        for (const token of text.split(/\s+/)) {
          if (!token || NO_CSS.has(token.split("/")[0] ?? "")) continue;
          const parsed = designSystem.parseCandidate(token);
          // Bare words such as "m" parse as a utility root without a value.
          if (
            parsed.every((candidate) => candidate.kind === "functional" && candidate.value === null)
          )
            continue;
          if (css(token) === null) unknown.push(`${path.relative(srcDir, file)}: ${token}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
