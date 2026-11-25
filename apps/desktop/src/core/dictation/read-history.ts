import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// Reading another app's history (ADR 020) without ever writing to it, waiting
// on it, or trusting it: any trouble is as if there were none.

const MAX_TEXT_BYTES = 16 * 1024 ** 2;
const MAX_DATABASE_BYTES = 64 * 1024 ** 2;
const PIECE_BYTES = 1024 ** 2;
const COPY_PREFIX = "sondine-dictation-";
const LEFT_MS = 60_000;
const MAX_ROWS = 20_000;
/** What was read is kept this long, for the dictations that follow, then let go. */
const KEPT_MS = 60_000;

/**
 * Hands a regular file's bytes to `use`, in order, as it was when opened.
 * False when it is not one, is larger than `maxBytes`, or changed meanwhile.
 * Opened without waiting, and checked once open: a pipe in its place would
 * hold core.
 */
function readFile(path: string, maxBytes: number, use: (bytes: Buffer) => void): boolean {
  let file: number | null = null;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const { size, mtimeMs } = statRegular(file);
    if (size > maxBytes) return false;
    const bytes = Buffer.alloc(Math.min(size + 1, PIECE_BYTES));
    let length = 0;
    while (length <= size) {
      const read = readSync(file, bytes, 0, Math.min(bytes.length, size + 1 - length), length);
      if (read === 0) break;
      use(bytes.subarray(0, read));
      length += read;
    }
    return length === size && statRegular(file).mtimeMs === mtimeMs;
  } catch {
    return false;
  } finally {
    if (file !== null) closeSync(file);
  }
}

function statRegular(file: number) {
  const stat = fstatSync(file);
  if (!stat.isFile()) throw new Error("not a file");
  return stat;
}

/** A file's text; null when it cannot be read whole. */
export function readText(path: string): string | null {
  const parts: Buffer[] = [];
  const whole = readFile(path, MAX_TEXT_BYTES, (bytes) => parts.push(Buffer.from(bytes)));
  return whole ? Buffer.concat(parts).toString("utf8") : null;
}

function copyFile(path: string, to: string): boolean {
  const copy = openSync(to, "wx", 0o600);
  try {
    return readFile(path, MAX_DATABASE_BYTES, (bytes) => {
      for (let done = 0; done < bytes.length;) done += writeSync(copy, bytes, done);
    });
  } finally {
    closeSync(copy);
  }
}

/**
 * Rows of one table of an app's SQLite file, read from a copy of it made for
 * the time of the query: opened in place, SQLite would lock and write beside
 * it.
 */
export function readRows(
  path: string,
  table: string,
  sql: string,
  ...values: SQLInputValue[]
): Record<string, unknown>[] | null {
  let folder: string | null = null;
  let database: DatabaseSync | null = null;
  try {
    const log = `${path}-wal`;
    const before = stateOf([path, log]);
    folder = mkdtempSync(join(tmpdir(), COPY_PREFIX));
    const copy = join(folder, "copy");
    if (!copyFile(path, copy)) return null;
    if (existsSync(log) && !copyFile(log, `${copy}-wal`)) return null;
    // The app moved rows from one file to the other meanwhile: what was copied is neither.
    if (stateOf([path, log]) !== before) return null;
    database = new DatabaseSync(copy, { allowExtension: false });
    database.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;");
    // A view, a virtual table or a generated column of that name could compute anything.
    const made = database
      .prepare("SELECT sql FROM sqlite_master WHERE name = ? AND type = 'table'")
      .get(table);
    if (!/^\s*CREATE\s+TABLE\s/i.test(String(made?.["sql"] ?? ""))) return null;
    const columns = database.prepare("SELECT hidden FROM pragma_table_xinfo(?)").all(table);
    if (columns.some((column) => column["hidden"] !== 0)) return null;
    const rows: Record<string, unknown>[] = [];
    for (const row of database.prepare(sql).iterate(...values)) {
      rows.push(row);
      if (rows.length >= MAX_ROWS) break;
    }
    return rows;
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } finally {
      if (folder !== null) rmSync(folder, { recursive: true, force: true });
    }
  }
}

/** Removes the copies a crash left behind. */
export function removeLeftCopies(nowMs: number): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(COPY_PREFIX)) continue;
      const folder = join(tmpdir(), name);
      // Another Sondine may be reading one now, for a second at most.
      if (nowMs - statSync(folder).mtimeMs > LEFT_MS) rmSync(folder, { recursive: true });
    }
  } catch {
    // Tried again at the next start.
  }
}

/** What tells a file changed. Throws when it cannot be told. */
const stateOf = (paths: readonly string[]) =>
  paths
    .map((path) => {
      const stat = statSync(path, { throwIfNoEntry: false });
      return stat === undefined ? "none" : `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    })
    .join();

/** `read` again only once one of `paths` changed, or after `KEPT_MS`; null when that cannot be told. */
export function remembered<T>(paths: readonly string[], read: () => T): () => T | null {
  let last: { readonly key: string; readonly value: T } | null = null;
  let forget: NodeJS.Timeout | undefined;
  return () => {
    try {
      const key = stateOf(paths);
      if (last?.key !== key) last = { key, value: read() };
    } catch {
      last = null;
      return null;
    }
    clearTimeout(forget);
    forget = setTimeout(() => (last = null), KEPT_MS);
    forget.unref();
    return last.value;
  };
}
