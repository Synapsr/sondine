// Checks the committed Nucleo subset (ADR 009): at most 100 glyph files, each
// carrying the Nucleo copyright notice, matching icons.json, and no file in
// the repository importing a nucleo-* package.
//
// Usage: node scripts/check-icons.ts (also run by src/icon/icons.test.ts).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_GLYPHS = 100;

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(packageDir, "../..");
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "release",
  ".git",
  ".turbo",
  "coverage",
  // Generated translations, rewritten while the desktop's tests compile them.
  "paraglide",
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const NUCLEO_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']nucleo-[^"']*["']/m;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(value)) throw new Error(`${file} is not a JSON object`);
  return value;
}

export function formatNotice(text: string): string {
  const lines = text.trimEnd().split("\n");
  return `/*\n${lines.map((line) => (line ? ` * ${line}` : " *")).join("\n")}\n */\n`;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name))
        files.push(...(await sourceFiles(path.join(dir, entry.name))));
    } else if (SOURCE_FILE.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

export interface IconCheckResult {
  glyphCount: number;
  problems: string[];
}

export async function checkIcons(): Promise<IconCheckResult> {
  const problems: string[] = [];
  const nucleoDir = path.join(packageDir, "src/icon/nucleo");
  const notice = formatNotice(
    await readFile(path.join(packageDir, "scripts/nucleo-notice.txt"), "utf8"),
  );

  const glyphFiles = (await readdir(nucleoDir)).filter((file) => file.endsWith(".tsx")).toSorted();
  if (glyphFiles.length > MAX_GLYPHS) {
    problems.push(`${glyphFiles.length} Nucleo glyph files exceed the ${MAX_GLYPHS}-glyph budget`);
  }
  for (const file of glyphFiles) {
    const content = await readFile(path.join(nucleoDir, file), "utf8");
    if (!content.startsWith(notice))
      problems.push(`${file} does not start with the Nucleo copyright notice`);
  }

  const listed = Object.keys(await readJson(path.join(packageDir, "src/icon/icons.json"))).map(
    (name) => `${name}.tsx`,
  );
  for (const file of listed) {
    if (!glyphFiles.includes(file))
      problems.push(`${file} is listed in icons.json but not generated`);
  }
  for (const file of glyphFiles) {
    if (!listed.includes(file)) problems.push(`${file} is not listed in icons.json`);
  }

  for (const root of ["apps", "packages"]) {
    const dir = path.join(repoDir, root);
    for (const file of await sourceFiles(dir).catch(() => [])) {
      if (NUCLEO_IMPORT.test(await readFile(file, "utf8"))) {
        problems.push(`${path.relative(repoDir, file)} imports a nucleo-* package`);
      }
    }
  }
  for (const manifestDir of [packageDir, repoDir]) {
    const manifest = await readJson(path.join(manifestDir, "package.json"));
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const deps = manifest[field];
      if (isRecord(deps) && Object.keys(deps).some((name) => name.startsWith("nucleo-"))) {
        problems.push(
          `${path.relative(repoDir, path.join(manifestDir, "package.json"))} depends on a nucleo-* package`,
        );
      }
    }
  }

  return { glyphCount: glyphFiles.length, problems };
}

if (import.meta.main) {
  const { glyphCount, problems } = await checkIcons();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-icons: ${problem}`);
    process.exit(1);
  }
  console.log(
    `check-icons: ${glyphCount}/${MAX_GLYPHS} Nucleo glyphs, notices present, no nucleo-* imports`,
  );
}
