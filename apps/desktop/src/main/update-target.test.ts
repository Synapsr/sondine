import { describe, expect, it } from "vitest";
import { updateTarget, type UpdateTargetInput } from "./update-target";

const base: UpdateTargetInput = {
  isPackaged: true,
  resourcesPath: "/Applications/Sondine.app/Contents/Resources",
  released: true,
  team: "P5G8WAJ2G2",
  expectedTeam: "P5G8WAJ2G2",
  dataDirectory: "/data",
  writable: () => true,
  volume: () => 1,
};
const blocked = (input: Partial<UpdateTargetInput>) => updateTarget({ ...base, ...input }).blocked;

describe("the app an update replaces", () => {
  it("is this app, where it is", () => {
    expect(updateTarget(base)).toEqual({ app: "/Applications/Sondine.app", blocked: null });
    expect(
      updateTarget({
        ...base,
        resourcesPath: "/Users/x/Applications/Sondine.app/Contents/Resources",
      }).app,
    ).toBe("/Users/x/Applications/Sondine.app");
  });

  it("is none in development, or in a build that is not a signed release", () => {
    expect(blocked({ isPackaged: false })).toBe("development");
    expect(blocked({ released: false })).toBe("unreleased");
    expect(blocked({ team: null })).toBe("unreleased");
    expect(blocked({ team: "AAAAAAAAAA" })).toBe("unreleased");
  });

  it("is none in a copy under another name", () => {
    expect(blocked({ resourcesPath: "/Applications/Sondine Exp.app/Contents/Resources" })).toBe(
      "test-copy",
    );
  });

  it("asks to move an app macOS moved, or this user cannot replace", () => {
    expect(
      blocked({
        resourcesPath: "/private/var/folders/x/AppTranslocation/1/d/Sondine.app/Contents/Resources",
      }),
    ).toBe("move");
    expect(blocked({ writable: (path) => path !== "/Applications" })).toBe("move");
    expect(blocked({ writable: (path) => path !== "/Applications/Sondine.app" })).toBe("move");
    // A disk image, or another disk: the two apps could not be exchanged.
    expect(blocked({ volume: (path) => (path === "/data" ? 1 : 2) })).toBe("move");
    expect(blocked({ volume: () => null })).toBe("move");
  });
});
