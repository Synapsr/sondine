// Installs a model file the user already has into the model store.
//
//   node packages/engines/src/cli/import-model.ts <artifactId> <path> [--version V] [--models-dir DIR] [--force] [--copy]
//   node packages/engines/src/cli/import-model.ts --list [--models-dir DIR]
//
// The file must match the catalog's size and sha256. It is cloned (APFS, no
// extra disk), so it must sit on the same volume as the models folder, unless
// --copy allows a copy when it does not.
import { parseArgs } from "node:util";
import { MODEL_CATALOG, catalogArtifact } from "../models/catalog.ts";
import {
  ModelStoreError,
  importArtifact,
  listInstalled,
  modelsDirectory,
  type ImportProgress,
} from "../models/store.ts";

const usage = `usage: import-model.ts <artifactId> <path> [--version V] [--models-dir DIR] [--force] [--copy]
       import-model.ts --list [--models-dir DIR]

Artifacts in the catalog:
${MODEL_CATALOG.map((artifact) => `  ${artifact.artifactId}  version ${artifact.version}  ${artifact.label}`).join("\n")}`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: "string" },
    "models-dir": { type: "string" },
    force: { type: "boolean", default: false },
    copy: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
const root = values["models-dir"] ?? modelsDirectory();

if (values.help) {
  console.log(usage);
  process.exit(0);
}

if (values.list) {
  const entries = await listInstalled(root);
  if (entries.length === 0) console.log(`No artifacts in ${root}`);
  for (const entry of entries) {
    console.log(`${entry.artifactId}@${entry.version}  ${entry.status}`);
  }
  process.exit(0);
}

const [artifactId, source] = positionals;
if (artifactId === undefined || source === undefined || positionals.length > 2) {
  console.error(usage);
  process.exit(2);
}
const artifact = catalogArtifact(artifactId, values.version);
if (artifact === undefined) {
  console.error(
    `No ${artifactId}${values.version === undefined ? "" : `@${values.version}`} in the catalog.\n\n${usage}`,
  );
  process.exit(2);
}

// OpenMDW-1.1 and similar licenses ask that their text and notices are shown
// and kept (ADR 005); the import keeps them next to the weights.
console.log(`${artifact.label}\nLicense: ${artifact.license.id}\n`);
console.log(artifact.license.text.trimEnd());
console.log(`\n${artifact.notices.trimEnd()}\n`);

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
let lastLine = "";
const report = (progress: ImportProgress) => {
  const line =
    progress.phase === "hash" || progress.phase === "copy"
      ? `${progress.phase === "hash" ? "hashing" : "copying"} ${gib(progress.bytes)} / ${gib(progress.totalBytes)} GiB`
      : progress.phase === "clone"
        ? "cloning"
        : "";
  if (line === "" || line === lastLine) return;
  lastLine = line;
  process.stdout.write(process.stdout.isTTY ? `\r${line}   ` : `${line}\n`);
};

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

try {
  const result = await importArtifact({
    root,
    artifact,
    source,
    force: values.force,
    method: values.copy ? "clone-or-copy" : "clone",
    signal: controller.signal,
    onProgress: report,
  });
  if (process.stdout.isTTY) process.stdout.write("\n");
  console.log(
    result.status === "imported"
      ? `Imported ${artifact.artifactId}@${artifact.version} to ${result.installed.path} by ${result.method ?? "clone"} (sha256 verified in ${(result.hashMs / 1000).toFixed(1)} s)`
      : `${artifact.artifactId}@${artifact.version} is already installed at ${result.installed.path} (use --force to import again)`,
  );
} catch (error) {
  if (process.stdout.isTTY) process.stdout.write("\n");
  if (error instanceof ModelStoreError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
