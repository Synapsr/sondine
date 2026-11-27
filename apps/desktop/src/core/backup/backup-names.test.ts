import { describe, expect, it } from "vitest";
import { isRestorableName } from "./backup-names";

describe("isRestorableName", () => {
  it.each([
    "sondine.db",
    "renderer.json",
    "lan/identity.p12",
    "archive/input-Mic/11111111-2222-4333-8444-555555555555/0003.pcm",
    `context/${"a".repeat(64)}`,
    `context/previews/${"b".repeat(64)}.jpg`,
  ])("accepts %s", (name) => expect(isRestorableName(name)).toBe(true));

  it.each([
    "../sondine.db",
    "archive/../../etc/0001.pcm",
    "archive/./run/0001.pcm",
    "archive/.hidden/run/0001.pcm",
    "spool/input/run/0001.pcm",
    "lan/other.key",
    "context/notasha",
    "/etc/passwd",
    "sondine.db-wal",
  ])("refuses %s", (name) => expect(isRestorableName(name)).toBe(false));
});
