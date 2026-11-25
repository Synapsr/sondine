// Writes packages/protocol/schemas/*.json from the zod schemas.
// Run with `pnpm --filter @sondine/protocol run gen`.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const { buildJsonSchemaFiles } = await import("../src/json-schema");

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const schemasDir = join(packageDir, "schemas");

/** Formats like `pnpm format` so the files pass `pnpm format:check`. */
function format(path: string, text: string): string {
  const result = spawnSync("oxfmt", [`--stdin-filepath=${path}`], {
    cwd: packageDir,
    input: text,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr;
    throw new Error(`oxfmt failed for ${path}: ${reason}. Run through pnpm so oxfmt is on PATH.`);
  }
  return result.stdout;
}

const files = buildJsonSchemaFiles();
mkdirSync(schemasDir, { recursive: true });

for (const name of readdirSync(schemasDir)) {
  if (name.endsWith(".json") && !(name in files)) {
    rmSync(join(schemasDir, name));
    console.log(`removed schemas/${name}`);
  }
}
for (const [name, schema] of Object.entries(files)) {
  const path = join(schemasDir, name);
  writeFileSync(path, format(path, `${JSON.stringify(schema, null, 2)}\n`));
  console.log(`wrote schemas/${name}`);
}
