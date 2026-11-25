import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { openDatabase } from "@sondine/db";
import { repoRoot, userPath } from "../paths.ts";
import { measurePhoneVoices, phoneReportMarkdown } from "./phone.ts";
import { localDay, readBenchVoices } from "./read.ts";
import { privateVoices } from "./usage.ts";

const sondineDatabase = join(
  homedir(),
  "Library",
  "Group Containers",
  "P5G8WAJ2G2.app.sondine",
  "sondine.db",
);

export async function voicesMain(
  command: string | undefined,
  args: readonly string[],
  usageError: (message: string) => Error,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: "string" },
      results: { type: "string" },
      date: { type: "string" },
      "keep-copy": { type: "boolean" },
    },
  });
  if (positionals.length > 0) throw usageError(`unexpected argument ${positionals[0] ?? ""}`);
  if (command !== "phone") {
    throw usageError(
      command === undefined ? "voices needs a command" : `unknown voices command "${command}"`,
    );
  }
  const date = values.date ?? localDay(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw usageError("--date is YYYY-MM-DD");

  // A copy first: the app's database is opened read-only, only to copy it.
  const directory = join(privateVoices, "phone");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const copy = join(directory, `copy-${process.pid}.db`);
  const source = new DatabaseSync(values.db === undefined ? sondineDatabase : userPath(values.db), {
    readOnly: true,
  });
  try {
    await backup(source, copy);
  } finally {
    source.close();
  }
  try {
    const db = openDatabase(copy, { migrate: false });
    try {
      const { voices, sameMoment, inventory, embedders } = readBenchVoices(db);
      const report = measurePhoneVoices(voices, sameMoment);
      const markdown = phoneReportMarkdown({ date, embedder: embedders, inventory, report });
      const results =
        values.results === undefined
          ? join(repoRoot, "bench", "results")
          : userPath(values.results);
      mkdirSync(results, { recursive: true });
      const path = join(results, `voices-phone-${date}.md`);
      writeFileSync(path, markdown);
      console.log(markdown);
      console.log(`written: ${path}`);
    } finally {
      db.close();
    }
  } finally {
    if (values["keep-copy"] !== true) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${copy}${suffix}`, { force: true });
    }
  }
  return 0;
}
