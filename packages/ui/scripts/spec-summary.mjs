#!/usr/bin/env node
// Prints a compact view of a Graphical component specification
// (gui/components/sondine/<name>.md): named tokens per variant, part, mode and
// state, with the resolved values that matter when a token is not enough
// (automatic foregrounds, focus outline, edges, shadows).
//
// Usage: node scripts/spec-summary.mjs <component> [--all]
//   --all  print every token for every state instead of only the changes from rest

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [name, flag] = process.argv.slice(2);
if (!name) {
  console.error("usage: node scripts/spec-summary.mjs <component> [--all]");
  process.exit(1);
}

const markdown = await readFile(path.join(repoDir, "gui/components/sondine", `${name}.md`), "utf8");
const json = markdown.match(/```json\n([\s\S]*?)\n```/)?.[1];
if (!json) throw new Error(`no JSON block in ${name}.md`);
const spec = JSON.parse(json);

const RESOLVED = [
  "background",
  "foreground",
  "borderColor",
  "borderWidth",
  "borderInset",
  "shadow",
  "focusOutline",
];
const format = (record) =>
  Object.entries(record)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join(" ");

console.log(`# ${spec.label}`);
if (Object.keys(spec.structure ?? {}).length > 0)
  console.log(`structure ${JSON.stringify(spec.structure)}`);
for (const part of spec.parts) {
  console.log(
    `part ${part.id}: states ${part.states.join(", ")}; properties ${part.properties.join(", ")}`,
  );
}

for (const [variant, modes] of Object.entries(spec.variants)) {
  for (const [mode, parts] of Object.entries(modes)) {
    for (const [part, states] of Object.entries(parts)) {
      const rest = states.rest?.tokens ?? {};
      for (const [state, record] of Object.entries(states)) {
        const { shadows, ...tokens } = record.tokens;
        const changed =
          flag === "--all" || state === "rest"
            ? tokens
            : Object.fromEntries(
                Object.entries(tokens).filter(
                  ([key, value]) => JSON.stringify(rest[key]) !== JSON.stringify(value),
                ),
              );
        const resolved = Object.fromEntries(
          RESOLVED.filter((key) => key in record.style).map((key) => [key, record.style[key]]),
        );
        console.log(`\n${variant} ${mode} ${part} ${state}`);
        console.log(
          `  tokens   ${format(changed) || "(same as rest)"}${shadows ? ` shadows=${JSON.stringify(shadows)}` : ""}`,
        );
        console.log(`  resolved ${format(resolved)}`);
      }
    }
  }
}
