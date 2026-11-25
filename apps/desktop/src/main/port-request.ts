import type { WebFrameMain } from "electron";
import type { UrlGuard } from "./url-guard";

// Who may receive a port to core. Pure, so the rules are unit-tested.

export interface FrameIdentity {
  readonly url: string;
  readonly processId: number;
  readonly frameToken: string;
  readonly isTopFrame: boolean;
}

export function frameIdentity(
  frame: Pick<WebFrameMain, "url" | "processId" | "frameToken" | "parent">,
): FrameIdentity {
  return {
    url: frame.url,
    processId: frame.processId,
    frameToken: frame.frameToken,
    isTopFrame: frame.parent === null,
  };
}

export type PortRequestVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "no-window" | "no-frame" | "not-main-frame" | "foreign-origin";
    };

/**
 * A port goes only to the main frame of Sondine's own window, showing a page
 * from the app's origin. Subframes, other windows, and navigated-away pages
 * are refused.
 */
export function judgePortRequest(
  sender: FrameIdentity | null,
  mainFrame: FrameIdentity | null,
  isAppUrl: UrlGuard,
): PortRequestVerdict {
  if (mainFrame === null) return { ok: false, reason: "no-window" };
  if (sender === null) return { ok: false, reason: "no-frame" };
  const sameFrame =
    sender.isTopFrame &&
    sender.processId === mainFrame.processId &&
    sender.frameToken === mainFrame.frameToken;
  if (!sameFrame) return { ok: false, reason: "not-main-frame" };
  if (!isAppUrl(sender.url)) return { ok: false, reason: "foreign-origin" };
  return { ok: true };
}
