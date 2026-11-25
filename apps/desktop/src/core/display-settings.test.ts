import { join } from "node:path";
import { openDatabase, type OpenedDatabase } from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationsDir, tempDataDir, type TempDataDir } from "../../test/support";
import { readDisplaySettings, updateDisplaySettings } from "./display-settings";

let data: TempDataDir;
let db: OpenedDatabase;

beforeEach(() => {
  data = tempDataDir();
  db = openDatabase(join(data.dir, "sondine.db"), { migrationsFolder: migrationsDir });
});

afterEach(() => {
  db.close();
  data.cleanup();
});

describe("display settings", () => {
  it("reads as not chosen before the user picks anything", () => {
    expect(readDisplaySettings(db)).toEqual({
      commitmentsFolded: false,
      media: null,
      dictations: null,
    });
  });

  it("keeps each choice and changes only the fields given", () => {
    updateDisplaySettings(db, { media: false }, 1);
    updateDisplaySettings(db, { commitmentsFolded: true }, 2);
    expect(readDisplaySettings(db)).toEqual({
      commitmentsFolded: true,
      media: false,
      dictations: null,
    });
    expect(updateDisplaySettings(db, { dictations: true }, 3)).toEqual({
      commitmentsFolded: true,
      media: false,
      dictations: true,
    });
  });

  it("reads a row of another shape as not chosen", () => {
    db.statement(
      "INSERT INTO settings (key, value, updated_at_ms) VALUES ('display', '{\"media\":\"yes\"}', 1)",
    ).run();
    expect(readDisplaySettings(db).media).toBeNull();
  });
});
