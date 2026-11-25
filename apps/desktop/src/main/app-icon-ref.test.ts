import { describe, expect, it } from "vitest";
import { iconTarget } from "./app-icon-ref";

describe("app icon requests", () => {
  it("takes a bundle ID or an app bundle's absolute path", () => {
    expect(iconTarget({ bundleId: "us.zoom.xos" })).toEqual({ bundleId: "us.zoom.xos" });
    expect(iconTarget({ appPath: "/Applications/Cursor.app" })).toEqual({
      appPath: "/Applications/Cursor.app",
    });
  });

  it("refuses anything else before looking at the disk", () => {
    // A quote would break out of the Spotlight query.
    expect(iconTarget({ bundleId: 'us.zoom.xos" || kMDItemFSName == "*' })).toBeNull();
    expect(iconTarget({ appPath: "Applications/Cursor.app" })).toBeNull();
    expect(iconTarget({ appPath: "/Applications/../etc/passwd" })).toBeNull();
    expect(iconTarget({ appPath: "/Applications/Cursor.app/../../etc.app" })).toBeNull();
    expect(iconTarget({ appPath: "/etc/passwd" })).toBeNull();
    expect(iconTarget("us.zoom.xos")).toBeNull();
    expect(iconTarget(null)).toBeNull();
  });
});
