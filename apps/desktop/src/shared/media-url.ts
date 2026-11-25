// The `sondine-media:` scheme (architecture §11): one URL per episode
// timeline, `sondine-media://episode/<id>?g=<generation>`, and one per image
// added to a conversation, `sondine-media://context/<itemId>?v=<version>`
// (its preview, ADR 024). Core makes them; main parses them and relays byte
// ranges to core, which owns the files. No other URL is served. No Electron
// import, so the rules are unit-tested.

export const MEDIA_SCHEME = "sondine-media";
export const MEDIA_HOST = "episode";
export const MEDIA_ORIGIN = `${MEDIA_SCHEME}://${MEDIA_HOST}`;

export interface EpisodeMediaTarget {
  readonly episodeId: number;
  /** The episode's input generation the timeline was planned from. */
  readonly generation: number;
}

export function episodeMediaUrl(target: EpisodeMediaTarget): string {
  return `${MEDIA_ORIGIN}/${target.episodeId}?g=${target.generation}`;
}

// Exactly the shape `episodeMediaUrl` makes: no other path, query or fragment.
const MEDIA_URL = /^sondine-media:\/\/episode\/([1-9]\d{0,15})\?g=([1-9]\d{0,15})$/;

/** The episode and generation a media URL names, or null for any other URL. */
export function parseEpisodeMediaUrl(url: string): EpisodeMediaTarget | null {
  const match = MEDIA_URL.exec(url);
  if (match === null) return null;
  const episodeId = Number(match[1]);
  const generation = Number(match[2]);
  if (!Number.isSafeInteger(episodeId) || !Number.isSafeInteger(generation)) return null;
  return { episodeId, generation };
}

export const CONTEXT_MEDIA_ORIGIN = `${MEDIA_SCHEME}://context`;

export interface ContextMediaTarget {
  readonly itemId: number;
  /** The first 16 hex digits of the file's SHA-256: a URL for other bytes never matches. */
  readonly version: string;
}

export function contextMediaUrl(target: ContextMediaTarget): string {
  return `${CONTEXT_MEDIA_ORIGIN}/${target.itemId}?v=${target.version}`;
}

const CONTEXT_URL = /^sondine-media:\/\/context\/([1-9]\d{0,15})\?v=([0-9a-f]{16})$/;

/** The item and version a context URL names, or null for any other URL. */
export function parseContextMediaUrl(url: string): ContextMediaTarget | null {
  const match = CONTEXT_URL.exec(url);
  if (match === null) return null;
  const itemId = Number(match[1]);
  if (!Number.isSafeInteger(itemId) || match[2] === undefined) return null;
  return { itemId, version: match[2] };
}
