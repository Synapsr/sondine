import { nativeImage } from "electron";
import { NOTCH_ICON_MAX } from "@sondine/protocol";
import { appIcon } from "./app-icons";

// The call app's icon for the island: main finds it (app-icons.ts) and sends
// it as a small PNG, since the notch helper reads no file.

/** 26 pt at 2×. */
const EDGE_PX = 52;

/** The icons known so far; one asked for is looked up once, then `onLoad` says it came. */
export function createIslandIcons(onLoad: () => void): (bundleId: string) => string | null {
  const icons = new Map<string, string | null>();
  return (bundleId) => {
    const known = icons.get(bundleId);
    if (known !== undefined) return known;
    icons.set(bundleId, null);
    void appIcon({ bundleId }).then(
      (url) => {
        if (url === null) return;
        const png = nativeImage
          .createFromDataURL(url)
          .resize({ width: EDGE_PX, height: EDGE_PX, quality: "best" })
          .toPNG()
          .toString("base64");
        if (png.length === 0 || png.length > NOTCH_ICON_MAX) return;
        icons.set(bundleId, png);
        onLoad();
      },
      () => undefined,
    );
    return null;
  };
}
