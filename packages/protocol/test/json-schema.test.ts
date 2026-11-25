import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROL_MESSAGE_TYPES,
  HELPER_EVENT_TYPES,
  MANIFEST_RECORD_TYPES,
  buildJsonSchemaFiles,
} from "../src";

const schemasDir = join(import.meta.dirname, "..", "schemas");
const files = buildJsonSchemaFiles();

describe("generated JSON Schemas", () => {
  it("are up to date (run `pnpm --filter @sondine/protocol run gen`)", () => {
    const onDisk = readdirSync(schemasDir)
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    expect(onDisk).toEqual(Object.keys(files).toSorted());
    for (const [name, schema] of Object.entries(files)) {
      const committed: unknown = JSON.parse(readFileSync(join(schemasDir, name), "utf8"));
      expect(committed, name).toEqual(schema);
    }
  });

  it.each([
    ["control-message.json", CONTROL_MESSAGE_TYPES.length],
    ["helper-event.json", HELPER_EVENT_TYPES.length],
    ["manifest-record.json", MANIFEST_RECORD_TYPES.length],
  ])("%s has one branch per type", (name, count) => {
    const schema = files[name];
    expect(schema?.["oneOf"]).toHaveLength(count);
    expect(schema?.["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("describes clocks as decimal strings", () => {
    const defs = files["helper-event.json"]?.["$defs"];
    expect(defs).toMatchObject({
      ClockValue: { type: "string", pattern: "^(?:0|[1-9][0-9]{0,18})$" },
    });
  });
});
