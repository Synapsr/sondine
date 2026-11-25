// Writes docs/schemas/*.schema.json from the zod schemas of the JSON exports
// (a transcript, a day). Run with `pnpm --filter @sondine/api run gen`; a
// test fails while the files and the code differ.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The sources use extensionless imports (bundler resolution); Node needs `.ts`.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { exportJsonSchemas } = await import("../src/transcript-json");

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const schemasDir = join(packageDir, "..", "..", "docs", "schemas");
for (const [name, schema] of Object.entries(exportJsonSchemas())) {
  const target = join(schemasDir, name);
  // Formatted like `pnpm format`, so the file passes `pnpm format:check`.
  const formatted = spawnSync("oxfmt", [`--stdin-filepath=${target}`], {
    cwd: packageDir,
    input: `${JSON.stringify(schema, null, 2)}\n`,
    encoding: "utf8",
  });
  if (formatted.error !== undefined || formatted.status !== 0) {
    throw new Error(`oxfmt failed: ${formatted.error?.message ?? formatted.stderr}`);
  }
  writeFileSync(target, formatted.stdout);
  console.log(`wrote ${target}`);
}
