import type { UpdateBlock } from "@sondine/api";
import * as z from "zod";

// Where Sondine's releases are published (ADR 002: GitHub Releases of its own
// repository since 0.8.0, ADR 041), how a release names its version and
// its files, the hosts an update may come from (ADR 045), and the only
// release pages the window may hand to the browser.

export const RELEASES_REPO = "Synapsr/sondine";

/** The file each release carries beside its disk image, which the update check reads. */
export const UPDATE_FEED_NAME = "sondine-mac.json";

/**
 * The newest published release's file (drafts and pre-releases left out by
 * GitHub): a public redirect of github.com, outside the API and its 60
 * requests an hour for everyone behind one address.
 */
export const LATEST_UPDATE_FEED = `https://github.com/${RELEASES_REPO}/releases/latest/download/${UPDATE_FEED_NAME}`;

/** Where github.com redirects a release's file: its own storage, and nothing else (ADR 045). */
export const UPDATE_HOSTS: readonly string[] = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

/** The feed a test build reads instead (`SONDINE_UPDATE_FEED`, build-mac.mjs): this Mac's own server, never a release's. */
export const TEST_UPDATE_FEED = /^http:\/\/127\.0\.0\.1:\d{2,5}\/sondine-mac\.json$/u;

declare const COMPILED_UPDATE_FEED: string | undefined;
declare const COMPILED_RELEASE: boolean | undefined;

/** A test build's own feed; null in any other build (not defined in tests and scripts). */
export function testUpdateFeed(): string | null {
  return typeof COMPILED_UPDATE_FEED === "string" && TEST_UPDATE_FEED.test(COMPILED_UPDATE_FEED)
    ? COMPILED_UPDATE_FEED
    : null;
}

/** Whether `release:mac` built this app. */
export function isReleaseBuild(): boolean {
  return typeof COMPILED_RELEASE === "boolean" && COMPILED_RELEASE;
}

const VERSION = /^(?:0|[1-9]\d{0,3})(?:\.(?:0|[1-9]\d{0,3})){2}$/u;
const TAG = /^desktop-v(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/u;

/** An archive past this is not Sondine's: the app is under 400 MB. */
export const MAX_UPDATE_BYTES = 1024 ** 3;

/** What the file of a release says. A later version may add fields: they are ignored. */
export const UpdateFeed = z.object({
  format: z.literal("sondine-update"),
  formatVersion: z.literal(1),
  version: z.string().regex(VERSION),
  /** The oldest macOS that opens it. */
  minimumMacos: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){1,2}$/u),
  archive: z.object({
    sizeBytes: z.int().positive().max(MAX_UPDATE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
});
export type UpdateFeed = z.output<typeof UpdateFeed>;

/** The archive's name in its release. */
export const updateArchiveName = (version: string) => `Sondine-${version}-arm64.zip`;

/** Where a release's archive is: its own tag, or beside a test build's feed. */
export function updateArchiveUrl(version: string, testFeed: string | null): string {
  const name = updateArchiveName(version);
  return testFeed === null
    ? `https://github.com/${RELEASES_REPO}/releases/download/desktop-v${version}/${name}`
    : new URL(name, testFeed).href;
}

/** `desktop-v0.3.1` → `0.3.1`; null for any other tag. */
export function versionOfTag(tag: string): string | null {
  const match = TAG.exec(tag);
  return match === null ? null : `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

const RELEASE_PAGES = `https://github.com/${RELEASES_REPO}/releases/tag/`;

export function releasePage(version: string): string {
  return `${RELEASE_PAGES}desktop-v${version}`;
}

/** A release page of the repository, exactly; nothing else on GitHub. */
export function isReleasePage(url: string): boolean {
  return url.startsWith(RELEASE_PAGES) && versionOfTag(url.slice(RELEASE_PAGES.length)) !== null;
}

/** Whether `candidate` is a later `major.minor.patch` than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10));
  const a = parts(candidate);
  const b = parts(current);
  for (let index = 0; index < 3; index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

/** As `UpdateBlock` of the API says them (why Sondine does not install its updates itself here). */
export const UPDATE_BLOCKS = [
  "development",
  "unreleased",
  "test-copy",
  "move",
] as const satisfies readonly UpdateBlock[];

/** The file the new version makes once core runs, in the user's temporary folder: the shell waits for it. */
export const UPDATE_ACK_ARGUMENT = "--sondine-update-ack=";
export const UPDATE_ACK_NAME = /^sondine-update-[0-9a-f-]{36}$/u;

/** How the app starts again after an update: its window closed, behind, or in front, on its page. */
export type RelaunchWindow = "closed" | "behind" | "front";

export const UPDATED_ARGUMENT = "--sondine-updated=";
const RELAUNCH = /^(closed|behind|front)(\/[a-z0-9/-]{0,120})?$/u;

export function ackFrom(argv: readonly string[]): string | null {
  const name = argv
    .find((value) => value.startsWith(UPDATE_ACK_ARGUMENT))
    ?.slice(UPDATE_ACK_ARGUMENT.length);
  return name !== undefined && UPDATE_ACK_NAME.test(name) ? name : null;
}

export interface Relaunch {
  readonly window: RelaunchWindow;
  readonly path: string | null;
}

export function relaunchArgument({ window, path }: Relaunch): string {
  const value = `${window}${path ?? ""}`;
  return `${UPDATED_ARGUMENT}${RELAUNCH.test(value) ? value : window}`;
}

/** What the version before asked of this start; null when nothing updated it. */
export function relaunchFrom(argv: readonly string[]): Relaunch | null {
  const argument = argv.find((value) => value.startsWith(UPDATED_ARGUMENT));
  const match =
    argument === undefined ? null : RELAUNCH.exec(argument.slice(UPDATED_ARGUMENT.length));
  const window = match?.[1];
  if (window !== "closed" && window !== "behind" && window !== "front") return null;
  return { window, path: match?.[2] ?? null };
}
