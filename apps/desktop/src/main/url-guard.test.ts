import { describe, expect, it } from "vitest";
import { frameIdentity, judgePortRequest, type FrameIdentity } from "./port-request";
import {
  appUrlGuard,
  externalLinkGuard,
  mediaInitiatorGuard,
  originOf,
  requestGuard,
} from "./url-guard";

describe("url guards", () => {
  it("reads the origin of the app's custom scheme, which WHATWG URL reports as null", () => {
    expect(new URL("sondine://app/index.html").origin).toBe("null");
    expect(originOf("sondine://app/index.html#/design-system")).toBe("sondine://app");
    expect(originOf("not a url")).toBeNull();
    expect(originOf("data:text/plain,x")).toBeNull();
  });

  it("lets the window show only the app (and the dev server in development)", () => {
    const production = appUrlGuard(undefined);
    expect(production("sondine://app/index.html")).toBe(true);
    expect(production("sondine://other/index.html")).toBe(false);
    expect(production("https://example.com/")).toBe(false);
    expect(production("file:///etc/passwd")).toBe(false);
    expect(production("http://localhost:5173/")).toBe(false);

    const development = appUrlGuard("http://localhost:5173");
    expect(development("http://localhost:5173/#/design-system")).toBe(true);
    expect(development("http://localhost:5174/")).toBe(false);
    // Episode audio is fetched, never shown as a page.
    expect(production("sondine-media://episode/3?g=1")).toBe(false);
    expect(development("sondine-media://episode/3?g=1")).toBe(false);
  });

  it("lets the session fetch episode audio, and nothing else on that scheme", () => {
    for (const guard of [requestGuard(undefined), requestGuard("http://localhost:5173")]) {
      expect(guard("sondine-media://episode/3?g=1")).toBe(true);
      expect(guard("sondine-media://context/3?v=0123456789abcdef")).toBe(true);
      expect(guard("sondine-media://other/3?g=1")).toBe(false);
      expect(guard("sondine-media:episode/3")).toBe(false);
    }
  });

  it("hands the browser only the exact pages listed, over https", () => {
    const license = "https://huggingface.co/org/repo/blob/abc/LICENSE";
    const guard = externalLinkGuard([license, "http://example.com/LICENSE"]);
    expect(guard(license)).toBe(true);
    expect(guard(`${license}?x=1`)).toBe(false);
    expect(guard(`${license}#top`)).toBe(false);
    expect(guard("https://huggingface.co/org/repo/blob/abc/README.md")).toBe(false);
    expect(guard("http://example.com/LICENSE")).toBe(false);
    expect(guard("sondine://app/index.html")).toBe(false);
  });

  it("serves episode audio only to the app's own pages", () => {
    const production = mediaInitiatorGuard(undefined);
    expect(production("sondine://app")).toBe(true);
    expect(production(undefined)).toBe(false);
    expect(production("null")).toBe(false);
    expect(production("http://localhost:5173")).toBe(false);
    expect(production("https://example.com")).toBe(false);
    const development = mediaInitiatorGuard("http://localhost:5173/");
    expect(development("http://localhost:5173")).toBe(true);
    expect(development("sondine://app")).toBe(true);
    expect(development("http://localhost:5174")).toBe(false);
  });

  it("allows the hot-reload socket and devtools in development only", () => {
    const production = requestGuard(undefined);
    expect(production("sondine://app/assets/index.js")).toBe(true);
    expect(production("data:image/png;base64,AA==")).toBe(true);
    expect(production("ws://localhost:5173/")).toBe(false);
    expect(production("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(production("https://example.com/telemetry")).toBe(false);

    const development = requestGuard("http://localhost:5173/");
    expect(development("ws://localhost:5173/?token=x")).toBe(true);
    expect(development("devtools://devtools/bundled/inspector.html")).toBe(true);
    expect(development("ws://localhost:9999/")).toBe(false);
  });
});

describe("port requests", () => {
  const isAppUrl = appUrlGuard(undefined);
  const main: FrameIdentity = {
    url: "sondine://app/index.html",
    processId: 7,
    frameToken: "a",
    isTopFrame: true,
  };

  it("gives a port only to the main frame of Sondine's window", () => {
    expect(judgePortRequest(main, main, isAppUrl)).toEqual({ ok: true });
    expect(judgePortRequest(main, null, isAppUrl)).toEqual({ ok: false, reason: "no-window" });
    expect(judgePortRequest(null, main, isAppUrl)).toEqual({ ok: false, reason: "no-frame" });
  });

  it("refuses subframes, other windows and foreign pages", () => {
    expect(judgePortRequest({ ...main, isTopFrame: false }, main, isAppUrl)).toMatchObject({
      reason: "not-main-frame",
    });
    expect(judgePortRequest({ ...main, frameToken: "b" }, main, isAppUrl)).toMatchObject({
      reason: "not-main-frame",
    });
    expect(judgePortRequest({ ...main, processId: 8 }, main, isAppUrl)).toMatchObject({
      reason: "not-main-frame",
    });
    const navigated = { ...main, url: "https://example.com/" };
    expect(judgePortRequest(navigated, navigated, isAppUrl)).toMatchObject({
      reason: "foreign-origin",
    });
  });

  it("reads a frame's identity", () => {
    const frame = { url: "sondine://app/", processId: 3, frameToken: "t", parent: null };
    expect(frameIdentity(frame)).toEqual({
      url: "sondine://app/",
      processId: 3,
      frameToken: "t",
      isTopFrame: true,
    });
  });
});
