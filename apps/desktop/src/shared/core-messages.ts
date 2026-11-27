import * as z from "zod";

/** What an open panel is for: its message and starting folder. */
export const PickPurpose = z.enum(["model", "audio", "backup"]);
export type PickPurpose = z.output<typeof PickPurpose>;
import { MEDIA_SLICE_BYTES } from "./byte-range";
import { STATS_ENDPOINT } from "./stats";
import { TEST_UPDATE_FEED, UPDATE_BLOCKS } from "./updates";

// Messages between Electron main and the core utility process over
// `process.parentPort`. Both sides validate everything they receive: a
// MessagePort carries structured clones, not types. MessagePorts travel in
// the event's `ports`, never in the payload.

export const PowerEventName = z.enum([
  "suspend",
  "resume",
  "on-ac",
  "on-battery",
  "lock-screen",
  "unlock-screen",
  "thermal-state-change",
  "shutdown",
]);
export type PowerEventName = z.output<typeof PowerEventName>;

export const HelperProcessInfo = z.strictObject({
  state: z.enum(["starting", "running", "restarting", "crash-loop", "missing", "stopped"]),
  pid: z.int().positive().nullable(),
  restarts: z.int().min(0),
  lastExit: z
    .strictObject({
      code: z.int().nullable(),
      signal: z.string().nullable(),
      atMs: z.number(),
    })
    .nullable(),
  /** When the supervisor will try again, while restarting. */
  nextAttemptAtMs: z.number().nullable(),
});
export type HelperProcessInfo = z.output<typeof HelperProcessInfo>;

/** A byte range of an episode's playback WAV, as main parsed it from the window's `Range` header. */
export const ByteRangeSpec = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("range"),
    start: z.int().min(0),
    end: z.int().min(0).nullable(),
  }),
  z.strictObject({ kind: z.literal("suffix"), length: z.int().min(0) }),
]);

/** Pairs a voice read's recording with its levels and its end (ADR 034). */
export const VoiceReadId = z.string().regex(/^[0-9a-f-]{36}$/u);

/** Pairs a `media-read` with its reply and its `media-cancel`. */
const MediaRequestId = z.int().positive();

export const MediaReadRequest = z.strictObject({
  type: z.literal("media-read"),
  requestId: MediaRequestId,
  episodeId: z.int().positive(),
  /** The `g` of the media URL: the episode's input generation it was planned from. */
  generation: z.int().positive(),
  range: ByteRangeSpec,
});
export type MediaReadRequest = z.output<typeof MediaReadRequest>;

/** An image added to a conversation, for the window (ADR 024): its preview's bytes. */
export const ContextReadRequest = z.strictObject({
  type: z.literal("context-read"),
  requestId: MediaRequestId,
  itemId: z.int().positive(),
  /** The `v` of the URL: the start of the file's SHA-256. */
  version: z.string().regex(/^[0-9a-f]{16}$/),
  range: ByteRangeSpec,
});
export type ContextReadRequest = z.output<typeof ContextReadRequest>;

/** What `media-bytes` holds: an episode's WAV, or a context image's preview. */
export const MediaType = z.enum(["audio/wav", "image/jpeg", "image/png"]);
export type MediaType = z.output<typeof MediaType>;

/** What main found on the clipboard for `read-clipboard` (ADR 024). */
export const ClipboardContent = z.strictObject({
  /** Files copied in Finder. */
  files: z.array(z.string().min(1).max(4096)).max(20),
  /** An image on the clipboard (a screenshot), written by main as PNG into the context staging folder. */
  imagePath: z.string().min(1).max(4096).nullable(),
  text: z.string().max(1_000_000).nullable(),
});
export type ClipboardContent = z.output<typeof ClipboardContent>;

/** Why core sent no bytes; main answers the window with the matching HTTP status. */
export const MediaFailure = z.enum([
  /** No such episode (deleted, or never there): 404. */
  "not-found",
  /** The episode's generation moved past the URL's: 409. */
  "stale",
  /** The range starts past the end: 416. */
  "unsatisfiable",
  /** Too many reads waiting: 503. */
  "busy",
  /** No audio reader, or core is shutting down: 503. */
  "unavailable",
  "cancelled",
  /** Reading failed (an I/O error): 500. */
  "failed",
]);
export type MediaFailure = z.output<typeof MediaFailure>;

export const MainToCore = z.discriminatedUnion("type", [
  /** ports[0]: the renderer's end of a fresh channel. */
  z.strictObject({ type: z.literal("renderer-port"), windowId: z.int() }),
  /** ports[0]: main's own oRPC client (tray actions). */
  z.strictObject({ type: z.literal("main-port") }),
  z.strictObject({
    type: z.literal("power"),
    event: PowerEventName,
    atMs: z.number(),
    onBattery: z.boolean(),
    thermalState: z.string().nullable(),
  }),
  /** Every PID Sondine owns, from app.getAppMetrics(). */
  z.strictObject({ type: z.literal("exclude-pids"), pids: z.array(z.int().positive()).max(1024) }),
  z.strictObject({ type: z.literal("helper-process"), info: HelperProcessInfo }),
  /** Answer to `idle-query`: seconds without user input, and whether the screen is locked. */
  z.strictObject({
    type: z.literal("idle"),
    idleSeconds: z.number().min(0),
    locked: z.boolean(),
    atMs: z.number(),
  }),
  /** Playback bytes for the `sondine-media:` scheme (architecture §11): core answers with one slice. */
  MediaReadRequest,
  /** A context image's preview for the same scheme, answered like `media-read`. */
  ContextReadRequest,
  /** The window dropped that response: core skips the read if it has not started. */
  z.strictObject({ type: z.literal("media-cancel"), requestId: MediaRequestId }),
  /** Answer to `pick-files`: the files chosen, none when the panel was closed. */
  z.strictObject({
    type: z.literal("files-picked"),
    requestId: z.string().min(1).max(64),
    paths: z.array(z.string().min(1).max(4096)).max(20),
  }),
  /** Answer to `read-clipboard`; null when it could not be read. */
  z.strictObject({
    type: z.literal("clipboard-read"),
    requestId: z.string().min(1).max(64),
    content: ClipboardContent.nullable(),
  }),
  /** Answer to `backup-save`: where the user chose to save the backup, or null. */
  z.strictObject({
    type: z.literal("backup-save-picked"),
    requestId: z.string().min(1).max(64),
    path: z.string().min(1).max(4096).nullable(),
  }),
  /** Answer to `pick-file`: the chosen file, or null when the panel was closed. */
  z.strictObject({
    type: z.literal("file-picked"),
    requestId: z.string().min(1).max(64),
    path: z.string().min(1).max(4096).nullable(),
  }),
  /**
   * `export-text`: the user chose where (or the clipboard); may main write?
   * Core answers `export-go`.
   */
  z.strictObject({ type: z.literal("export-ready"), requestId: z.string().min(1).max(64) }),
  /** Answer to `export-audio` or `export-text`. */
  z.strictObject({
    type: z.literal("exported"),
    requestId: z.string().min(1).max(64),
    outcome: z.enum(["saved", "copied", "shared", "cancelled", "stale", "failed"]),
  }),
  /**
   * The voice read's recorder (ADR 034), every ~100 ms: how much it wrote to
   * its file, and the loudness of the last block (RMS and peak, 0 to 1). Never
   * audio: the PCM stays in the file.
   */
  z.strictObject({
    type: z.literal("voice-read-level"),
    readId: VoiceReadId,
    ms: z.int().min(0),
    rms: z.number().min(0).max(1),
    peak: z.number().min(0).max(1),
  }),
  /** The recorder exited: `ok` when it stopped as asked (or at its limit) and closed its file. */
  z.strictObject({
    type: z.literal("voice-read-ended"),
    readId: VoiceReadId,
    ok: z.boolean(),
    message: z.string().max(2000).nullable(),
  }),
  /** Answer to `network-query`: whether a download may use the network now (ADR 045). */
  z.strictObject({
    type: z.literal("network"),
    network: z.enum(["free", "metered", "offline", "unknown"]),
  }),
  /** `install-update` could not replace the app: nothing changed. */
  z.strictObject({ type: z.literal("update-failed"), reason: z.string().max(64) }),
  z.strictObject({ type: z.literal("shutdown") }),
]);
export type MainToCore = z.output<typeof MainToCore>;

export const PrivacyPane = z.enum(["microphone", "system-audio"]);
export type PrivacyPane = z.output<typeof PrivacyPane>;

export const CoreToMain = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), databasePath: z.string() }),
  /** OS actions belong to main; core asks for them. */
  z.strictObject({ type: z.literal("open-privacy-settings"), pane: PrivacyPane }),
  /** `episodes.openPage`: a page an episode's media came from, in the default browser (ADR 023). */
  z.strictObject({
    type: z.literal("open-page"),
    url: z
      .string()
      .max(2048)
      .regex(/^https?:\/\/[^\s]+$/),
  }),
  /** `browser.showExtension`: the unpacked extension's folder, shown in the Finder. */
  z.strictObject({ type: z.literal("reveal-folder"), path: z.string().min(1).max(1024) }),
  /**
   * `context.open`: a file added to a conversation, in its default app, from
   * a copy core made in its private temporary folder (ADR 024); main opens
   * only paths there.
   */
  z.strictObject({ type: z.literal("open-file"), path: z.string().min(1).max(4096) }),
  /** « Choisir des fichiers… » for a conversation's context: any file, up to 20. */
  z.strictObject({ type: z.literal("pick-files"), requestId: z.string().min(1).max(64) }),
  /** ⌘V on a conversation: what the clipboard holds (files, an image, text). */
  z.strictObject({ type: z.literal("read-clipboard"), requestId: z.string().min(1).max(64) }),
  /** Analysis admission asks for the idle state only while jobs wait (ADR 016). */
  z.strictObject({ type: z.literal("idle-query") }),
  /**
   * One slice of a `media-read`: `bytes` are the WAV's bytes from `start`, at
   * most `MEDIA_SLICE_BYTES`; `end` is the last byte (inclusive) of the range
   * the request resolved to, `total` the WAV's length. `bytes` must own its
   * whole buffer: a structured clone copies the buffer, not the view.
   */
  z.strictObject({
    type: z.literal("media-bytes"),
    requestId: MediaRequestId,
    mediaType: MediaType,
    total: z.int().min(0),
    start: z.int().min(0),
    end: z.int().min(0),
    bytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= MEDIA_SLICE_BYTES),
  }),
  z.strictObject({
    type: z.literal("media-failed"),
    requestId: MediaRequestId,
    reason: MediaFailure,
    /** The WAV's length, for a `416`'s `Content-Range`. */
    total: z.int().min(0).nullable(),
  }),
  /**
   * An open panel for one file, limited to its extensions: a model file
   * (`models.pick`) or an audio file to import (`imports.pick`).
   */
  z.strictObject({
    type: z.literal("pick-file"),
    requestId: z.string().min(1).max(64),
    purpose: PickPurpose,
    label: z.string().min(1).max(200),
    extensions: z
      .array(z.string().regex(/^[a-z0-9]{1,16}$/))
      .min(1)
      .max(16),
  }),
  /**
   * `backup.export` (ADR 048): a save panel for the backup; core writes the
   * file itself at the path main answers (`backup-save-picked`).
   */
  z.strictObject({
    type: z.literal("backup-save"),
    requestId: z.string().min(1).max(64),
    fileName: z.string().regex(/^[\w .-]{1,120}\.sondine$/),
  }),
  /**
   * A restore is staged (ADR 048): main quits and relaunches Sondine, and
   * swaps the data before it starts the helper and core again.
   */
  z.strictObject({ type: z.literal("backup-restart") }),
  /**
   * `episodes.exportAudio`: a save panel, then main writes the episode's WAV
   * by reading it slice by slice, as playback does (audio never crosses oRPC).
   */
  z.strictObject({
    type: z.literal("export-audio"),
    requestId: z.string().min(1).max(64),
    episodeId: z.int().positive(),
    generation: z.int().positive(),
    fileName: z.string().regex(/^[\w .-]{1,120}\.wav$/),
  }),
  /**
   * `episodes.exportText`: the transcript the window wrote, to the clipboard,
   * or to a file through a save panel. Main asks again (`export-ready`) right
   * before it writes, so nothing deleted meanwhile leaves.
   */
  z.strictObject({
    type: z.literal("export-text"),
    requestId: z.string().min(1).max(64),
    destination: z.enum(["file", "clipboard", "share"]),
    fileName: z.string().regex(/^[\w .-]{1,120}\.(md|srt|vtt|json)$/),
    text: z.string().min(1).max(16_000_000),
  }),
  /** Answer to `export-ready`: false when something was deleted since the window read it. */
  z.strictObject({
    type: z.literal("export-go"),
    requestId: z.string().min(1).max(64),
    go: z.boolean(),
  }),
  z.strictObject({ type: z.literal("shutdown-complete") }),
  /** What the network is, asked only while an update is to download (ADR 045). */
  z.strictObject({ type: z.literal("network-query") }),
  /**
   * Nothing would be cut: main stops Sondine, puts `app` (checked by core, in
   * the data directory's `updates` folder) in its place and starts it again.
   */
  z.strictObject({
    type: z.literal("install-update"),
    version: z.string().min(1).max(32),
    app: z.string().min(1).max(4096),
  }),
  /**
   * The voice read (ADR 034): main spawns `sondine-audio read-voice`, so macOS
   * credits Sondine.app for the microphone as it does the helper, writing
   * 16 kHz PCM16 to `path` (a file in the data directory's `voice-read`
   * folder, which main checks) for at most `maxMs`.
   */
  z.strictObject({
    type: z.literal("voice-read-record"),
    readId: VoiceReadId,
    path: z.string().min(1).max(4096),
    maxMs: z.int().min(1_000).max(120_000),
  }),
  /** Ends that recording: the recorder closes its file and exits. */
  z.strictObject({ type: z.literal("voice-read-stop"), readId: VoiceReadId }),
  z.strictObject({ type: z.literal("fatal"), message: z.string() }),
]);
export type CoreToMain = z.output<typeof CoreToMain>;

/** Arguments main passes to `utilityProcess.fork`; core parses them back. */
export const CoreArguments = z.strictObject({
  dataDir: z.string().min(1),
  migrationsDir: z.string().min(1),
  helperSocket: z.string().min(1),
  appVersion: z.string().min(1),
  macosVersion: z.string().min(1),
  /** Where the anonymous statistics go (ADR 042); null but in a packaged release. */
  statsEndpoint: z.string().regex(STATS_ENDPOINT).nullable(),
  /** Why this app cannot replace itself (ADR 045); null when it can. */
  updateBlock: z.enum(UPDATE_BLOCKS).nullable(),
  /** A test build's own update feed; null in any other build. */
  updateTestFeed: z.string().regex(TEST_UPDATE_FEED).nullable(),
  /** The model store, outside the group container (ADR 013). */
  modelsDir: z.string().min(1),
  /** The speech.cpp executable; null when this build has none (see main/paths.ts). */
  speechBinary: z.string().min(1).nullable(),
  /** sondine-voice and its WeSpeaker model; null when this build has none (see main/paths.ts). */
  voiceBinary: z.string().min(1).nullable(),
  voiceModel: z.string().min(1).nullable(),
  /** llama.cpp's `llama-server` for the daily journal (ADR 028); null when this build has none. */
  textServer: z.string().min(1).nullable(),
  /** The Unix socket it listens on: inside its own sandbox container when packaged. */
  textSocket: z.string().min(1).nullable(),
  /** sondine-mcp, the relay agents start (ADR 011); null when this build has none that reaches the data. */
  agentRelay: z.string().min(1).nullable(),
  /** Whether agents must give the relay `--socket` (development data lives outside the group container). */
  agentRelaySocketArgument: z.boolean(),
  /** sondine-browser, the native messaging host browsers start (ADR 023); null when none reaches the data. */
  browserRelay: z.string().min(1).nullable(),
  /** Whether the browser's relay needs `--socket` (given by a wrapper script in development). */
  browserRelaySocketArgument: z.boolean(),
  /** The unpacked browser extension this build carries; null when it has none. */
  browserExtension: z.string().min(1).nullable(),
  /** sondine-lan, the relay paired phones reach (ADR 008); null when this build has none that reaches the data. */
  phoneRelay: z.string().min(1).nullable(),
  /** A development build: the relay also accepts loopback peers. */
  phoneRelayLoopback: z.boolean(),
  /** Main can record a voice read (ADR 034): this build has `sondine-audio` on real hardware or its fake HAL. */
  voiceRecorder: z.boolean(),
});
export type CoreArguments = z.output<typeof CoreArguments>;

export function coreArgv(args: CoreArguments): string[] {
  return [
    `--data-dir=${args.dataDir}`,
    `--migrations-dir=${args.migrationsDir}`,
    `--helper-socket=${args.helperSocket}`,
    `--app-version=${args.appVersion}`,
    `--macos-version=${args.macosVersion}`,
    ...(args.statsEndpoint === null ? [] : [`--stats-endpoint=${args.statsEndpoint}`]),
    ...(args.updateBlock === null ? [] : [`--update-block=${args.updateBlock}`]),
    ...(args.updateTestFeed === null ? [] : [`--update-test-feed=${args.updateTestFeed}`]),
    `--models-dir=${args.modelsDir}`,
    ...(args.speechBinary === null ? [] : [`--speech-binary=${args.speechBinary}`]),
    ...(args.voiceBinary === null ? [] : [`--voice-binary=${args.voiceBinary}`]),
    ...(args.voiceModel === null ? [] : [`--voice-model=${args.voiceModel}`]),
    ...(args.textServer === null ? [] : [`--text-server=${args.textServer}`]),
    ...(args.textSocket === null ? [] : [`--text-socket=${args.textSocket}`]),
    ...(args.agentRelay === null ? [] : [`--agent-relay=${args.agentRelay}`]),
    ...(args.agentRelaySocketArgument ? ["--agent-relay-socket-argument"] : []),
    ...(args.browserRelay === null ? [] : [`--browser-relay=${args.browserRelay}`]),
    ...(args.browserRelaySocketArgument ? ["--browser-relay-socket-argument"] : []),
    ...(args.browserExtension === null ? [] : [`--browser-extension=${args.browserExtension}`]),
    ...(args.phoneRelay === null ? [] : [`--phone-relay=${args.phoneRelay}`]),
    ...(args.phoneRelayLoopback ? ["--phone-relay-loopback"] : []),
    ...(args.voiceRecorder ? ["--voice-recorder"] : []),
  ];
}
