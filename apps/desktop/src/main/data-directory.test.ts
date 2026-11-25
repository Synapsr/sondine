import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_GROUP,
  TEAM_ID,
  dataPaths,
  resolveDataDirectory,
  sandboxedHelperCanReach,
  usableDirectory,
} from "./data-directory";
import type { GroupContainerAccess } from "./group-container";

const base = { appDataDir: "/Users/t/Library/Application Support" };
const containerPath = `/Users/t/Library/Group Containers/${APP_GROUP}`;

/** A fake addon that records the order of calls. */
function access(team: string | null, container: string | null = containerPath) {
  const calls: string[] = [];
  const addon: GroupContainerAccess = {
    teamIdentifier: () => {
      calls.push("team");
      return team;
    },
    groupContainerPath: (groupId) => {
      calls.push(`container ${groupId}`);
      return container;
    },
  };
  return { addon, calls };
}

describe("data directory", () => {
  it("never touches the group container in development", () => {
    const probed: string[] = [];
    const { addon, calls } = access(TEAM_ID);
    const result = resolveDataDirectory({
      ...base,
      isPackaged: false,
      groupContainer: addon,
      usable: (path) => {
        probed.push(path);
        return true;
      },
    });
    expect(result).toMatchObject({
      kind: "app-data",
      path: "/Users/t/Library/Application Support/Sondine Dev",
    });
    expect(probed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("asks macOS for the container before writing to it in signed builds", () => {
    const { addon, calls } = access(TEAM_ID);
    const result = resolveDataDirectory({
      ...base,
      isPackaged: true,
      groupContainer: addon,
      usable: (path) => {
        calls.push(`write ${path}`);
        return true;
      },
    });
    expect(result).toEqual({
      kind: "group-container",
      path: containerPath,
      reason: `app group ${APP_GROUP}`,
    });
    expect(calls).toEqual(["team", `container ${APP_GROUP}`, `write ${containerPath}`]);
  });

  it("keeps a packaged app's data and socket in the group container, where a sandboxed helper reaches", () => {
    const result = resolveDataDirectory({
      ...base,
      isPackaged: true,
      groupContainer: access(TEAM_ID).addon,
      usable: () => true,
    });
    const container = `${containerPath}/`;
    const paths = dataPaths(result.path);
    expect(`${paths.root}/`).toBe(container);
    expect(paths.audioSocket.startsWith(container)).toBe(true);
    expect(paths.runDir.startsWith(container)).toBe(true);
    expect(sandboxedHelperCanReach(result)).toBe(true);
  });

  it("never touches the container of an unsigned, ad-hoc or other team's build", () => {
    for (const team of [null, "ABCDE12345"]) {
      const { addon, calls } = access(team);
      const result = resolveDataDirectory({
        ...base,
        isPackaged: true,
        groupContainer: addon,
        usable: () => true,
      });
      expect(result.kind).toBe("app-data");
      expect(calls).toEqual(["team"]);
      expect(sandboxedHelperCanReach(result)).toBe(false);
    }
  });

  it("falls back to Application Support when the addon is missing or the container is not writable", () => {
    const fallback = { kind: "app-data", path: "/Users/t/Library/Application Support/Sondine" };
    expect(
      resolveDataDirectory({ ...base, isPackaged: true, groupContainer: null, usable: () => true }),
    ).toMatchObject(fallback);
    expect(
      resolveDataDirectory({
        ...base,
        isPackaged: true,
        groupContainer: access(TEAM_ID, null).addon,
        usable: () => true,
      }),
    ).toMatchObject(fallback);
    const notWritable = resolveDataDirectory({
      ...base,
      isPackaged: true,
      groupContainer: access(TEAM_ID).addon,
      usable: () => false,
    });
    expect(notWritable).toMatchObject(fallback);
    expect(sandboxedHelperCanReach(notWritable)).toBe(false);
  });

  it("honours SONDINE_DATA_DIR in development only", () => {
    expect(resolveDataDirectory({ ...base, isPackaged: false, override: "/tmp/s" }).kind).toBe(
      "override",
    );
    expect(
      resolveDataDirectory({
        ...base,
        isPackaged: true,
        override: "/tmp/s",
        groupContainer: access(TEAM_ID).addon,
        usable: () => true,
      }).kind,
    ).toBe("group-container");
  });

  it("refuses socket paths longer than macOS allows", () => {
    expect(dataPaths(containerPath).audioSocket).toBe(`${containerPath}/run/audio.sock`);
    expect(() => dataPaths(`/${"x".repeat(100)}`)).toThrow(RangeError);
  });
});

describe("usable directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sondine-usable-"));
  afterAll(() => {
    chmodSync(join(dir, "read-only"), 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory and leaves no probe behind", () => {
    const target = join(dir, "data");
    expect(usableDirectory(target)).toBe(true);
    expect(readdirSync(target)).toEqual([]);
  });

  it("rejects a directory it cannot write a file in", () => {
    const target = join(dir, "read-only");
    mkdirSync(target, { mode: 0o500 });
    expect(usableDirectory(target)).toBe(false);
  });
});
