import { describe, expect, it } from "vitest";
import { LATEST_UPDATE_FEED, releasePage } from "../../shared/updates";
import { availableRelease, latestRelease } from "./update-check";

const feed = {
  format: "sondine-update",
  formatVersion: 1,
  version: "0.8.0",
  minimumMacos: "27.0",
  archive: { sizeBytes: 160_000_000, sha256: "a".repeat(64) },
  // A later version's field: ignored.
  later: true,
};

const asset = "https://release-assets.githubusercontent.com/x?sig=1";
const tagged = "https://github.com/Synapsr/sondine/releases/download/desktop-v0.8.0/f";

/** Answers each URL as given; records what was asked. */
function server(answers: Record<string, () => Response>) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetched: typeof fetch = async (input, init) => {
    const url = String(input);
    asked.push({ url, headers: Object.fromEntries(new Headers(init?.headers)) });
    expect(init?.redirect).toBe("manual");
    const answer = answers[url];
    if (answer === undefined) throw new TypeError(`unexpected ${url}`);
    return answer();
  };
  return { fetched, asked };
}
const to = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("update check", () => {
  it("reads the newest release's file, through GitHub's redirects, without the API", async () => {
    const { fetched, asked } = server({
      [LATEST_UPDATE_FEED]: to(tagged),
      [tagged]: to(asset),
      [asset]: json(feed),
    });
    const answer = await latestRelease(fetched);
    const { later: _later, ...read } = feed;
    expect(answer).toEqual({ ok: true, feed: read });
    expect(asked.map(({ url }) => new URL(url).hostname)).toEqual([
      "github.com",
      "github.com",
      "release-assets.githubusercontent.com",
    ]);
    // A generic agent: nothing about the user or the Mac.
    for (const { headers } of asked) {
      expect(headers).toEqual({ accept: "application/json", "user-agent": "Sondine" });
    }
  });

  it.each([
    "https://api.github.com/x",
    "https://evil.example/x",
    "http://github.com/x",
    "https://github.com.evil.example/x",
    "https://user@github.com/x",
    "https://github.com:8443/x",
  ])("refuses a redirect to %s", async (location) => {
    const { fetched, asked } = server({ [LATEST_UPDATE_FEED]: to(location) });
    expect(await latestRelease(fetched)).toEqual({ ok: false, problem: "bad_response" });
    expect(asked).toHaveLength(1);
  });

  it("stops after five redirects", async () => {
    const { fetched, asked } = server({ [LATEST_UPDATE_FEED]: to(LATEST_UPDATE_FEED) });
    expect(await latestRelease(fetched)).toEqual({ ok: false, problem: "bad_response" });
    expect(asked).toHaveLength(6);
  });

  it("tells GitHub's refusal from an answer it cannot read, and from no answer", async () => {
    const ask = (answer: () => Response) =>
      latestRelease(server({ [LATEST_UPDATE_FEED]: answer }).fetched);
    for (const status of [403, 429]) {
      expect(await ask(json("slow down", status))).toEqual({ ok: false, problem: "refused" });
    }
    for (const answer of [
      json("Not Found", 404),
      json("no json"),
      json({ ...feed, version: "nightly" }),
      json({ ...feed, version: "0.8.0-beta" }),
      json({ ...feed, archive: { ...feed.archive, sha256: "A" } }),
      json({ ...feed, archive: { ...feed.archive, sizeBytes: 2 ** 40 } }),
      json("x".repeat(20_000)),
    ]) {
      expect(await ask(answer)).toEqual({ ok: false, problem: "bad_response" });
    }
    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await latestRelease(offline)).toEqual({ ok: false, problem: "network" });
  });

  it("shows a later version only", () => {
    expect(availableRelease("0.8.0", "0.7.0")).toEqual({
      version: "0.8.0",
      url: releasePage("0.8.0"),
    });
    expect(availableRelease("0.8.0", "0.8.0")).toBeNull();
    expect(availableRelease("0.7.0", "0.8.0")).toBeNull();
    expect(availableRelease(null, "0.8.0")).toBeNull();
  });
});
