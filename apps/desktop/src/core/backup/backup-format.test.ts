import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WrongPassphrase } from "./backup-crypto";
import {
  BackupFormatError,
  BackupWriter,
  FRAME_BYTES,
  openBackup,
  readProtection,
  type BackupSummary,
  type FileSink,
} from "./backup-format";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sondine-backup-format-"));
  dirs.push(dir);
  return dir;
}

const summary: BackupSummary = {
  appVersion: "0.11.0",
  createdAtMs: Date.UTC(2026, 10, 27, 10),
  macName: "Mac de test",
  includeAudio: true,
  migrations: [{ name: "20261102000000_init", hash: "a".repeat(64) }],
  counts: {
    episodes: 2,
    people: 1,
    audioMs: 60_000,
    contextItems: 0,
    firstEpisodeAtMs: null,
    lastEpisodeAtMs: null,
  },
  models: ["parakeet-tdt"],
  bytes: 0,
};

/** Invented bytes, more than two frames' worth. */
const big = Buffer.from(Array.from({ length: FRAME_BYTES * 2 + 777 }, (_, index) => index % 251));

async function write(path: string, passphrase: string | null): Promise<void> {
  const writer = await BackupWriter.create({ path, passphrase, summary });
  await writer.addBuffer("sondine.db", Buffer.from("not really a database"));
  await writer.addFile("archive/input/run/0001.pcm", big.length, [
    big.subarray(0, 1000),
    big.subarray(1000),
  ]);
  await writer.finish();
}

async function extractAll(path: string, passphrase: string | null) {
  const backup = await openBackup(path, passphrase);
  const files = new Map<string, Buffer>();
  try {
    await backup.extract({
      accept: () => true,
      sink: async (name): Promise<FileSink> => {
        const parts: Buffer[] = [];
        return {
          write: async (bytes) => void parts.push(Buffer.from(bytes)),
          end: async () => void files.set(name, Buffer.concat(parts)),
        };
      },
    });
  } finally {
    await backup.close();
  }
  return { summary: backup.summary, protected: backup.protected, files };
}

describe("backup format", () => {
  it.each([
    ["with a passphrase", "correct horse battery staple"],
    ["without one", null],
  ])("round-trips %s", async (_label, passphrase) => {
    const path = join(tempDir(), "test.sondine");
    await write(path, passphrase);
    const read = await extractAll(path, passphrase);
    expect(read.summary).toEqual(summary);
    expect(read.protected).toBe(passphrase !== null);
    expect(read.files.get("sondine.db")?.toString()).toBe("not really a database");
    expect(read.files.get("archive/input/run/0001.pcm")?.equals(big)).toBe(true);
    expect((await readProtection(path)).kind).toBe(passphrase === null ? "none" : "passphrase");
  });

  it("hides the content behind a passphrase", async () => {
    const path = join(tempDir(), "test.sondine");
    await write(path, "correct horse battery staple");
    const raw = readFileSync(path);
    expect(raw.includes(Buffer.from("not really a database"))).toBe(false);
    expect(raw.includes(Buffer.from("Mac de test"))).toBe(false);
  });

  it("tells a wrong passphrase from damage", async () => {
    const path = join(tempDir(), "test.sondine");
    await write(path, "correct horse battery staple");
    await expect(openBackup(path, "wrong passphrase!!")).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(openBackup(path, null)).rejects.toBeInstanceOf(WrongPassphrase);
  });

  it.each([
    ["with a passphrase", "correct horse battery staple"],
    ["without one", null],
  ])("refuses a cut or changed file %s", async (_label, passphrase) => {
    const dir = tempDir();
    const path = join(dir, "test.sondine");
    await write(path, passphrase);
    const raw = readFileSync(path);

    const cut = join(dir, "cut.sondine");
    writeFileSync(cut, raw.subarray(0, raw.length - 40));
    await expect(extractAll(cut, passphrase)).rejects.toBeInstanceOf(BackupFormatError);

    const changed = join(dir, "changed.sondine");
    const flipped = Buffer.from(raw);
    const at = Math.floor(raw.length / 2);
    flipped[at] = (flipped[at] ?? 0) ^ 0xff;
    writeFileSync(changed, flipped);
    await expect(extractAll(changed, passphrase)).rejects.toBeInstanceOf(BackupFormatError);
  });

  it("refuses what is not a backup", async () => {
    const path = join(tempDir(), "other.sondine");
    writeFileSync(path, "hello");
    await expect(openBackup(path, null)).rejects.toMatchObject({ reason: "not-a-backup" });
  });

  it("refuses a file the reader does not expect", async () => {
    const path = join(tempDir(), "test.sondine");
    await write(path, null);
    const backup = await openBackup(path, null);
    await expect(
      backup.extract({
        accept: (name) => name === "sondine.db",
        sink: async () => ({ write: async () => undefined, end: async () => undefined }),
      }),
    ).rejects.toBeInstanceOf(BackupFormatError);
    await backup.close();
  });
});
