import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

const { loadNotificationPermission, permissionOf } = await import("./notification-permission");

describe("notification permission", () => {
  it("says whether macOS puts Sondine's notifications on screen", () => {
    expect(permissionOf("authorized", "banner")).toBe("allowed");
    expect(permissionOf("authorized", "alert")).toBe("allowed");
    expect(permissionOf("authorized", "none")).toBe("silent");
    expect(permissionOf("provisional", "banner")).toBe("silent");
    expect(permissionOf("denied", "none")).toBe("blocked");
    expect(permissionOf("not-determined", "none")).toBe("blocked");
    expect(permissionOf("something new", "banner")).toBe("unknown");
  });

  it("knows nothing in a development build", async () => {
    await expect(loadNotificationPermission()()).resolves.toBe("unknown");
  });
});
