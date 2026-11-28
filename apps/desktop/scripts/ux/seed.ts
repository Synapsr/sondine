// Seeds invented conversations into a fresh development data folder, for the
// redesign's captures and click paths (docs/ux-redesign.md §8). The data is
// src/main/flow-lab/invented-data.ts, which the flow lab seeds too.
//
// Usage: node scripts/ux/seed.ts <data-folder> [--ask]

import { registerHooks } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Workspace packages import without extensions (bundler resolution).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || context.parentURL?.endsWith(".ts") !== true) throw error;
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
  },
});

const { openDatabase } = await import("@sondine/db");
const { seedInvented } = await import("../../src/main/flow-lab/invented-data.ts");

const folder = process.argv[2];
if (folder === undefined) throw new Error("usage: node scripts/ux/seed.ts <data-folder>");
mkdirSync(folder, { recursive: true });
const db = openDatabase(join(folder, "sondine.db"));
seedInvented(db, { now: Date.now(), askUsage: process.argv.includes("--ask") });
db.close();
console.log(`seeded ${folder}`);
