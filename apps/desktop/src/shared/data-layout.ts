/** Layout of the data directory, relative to its root (ADR 013). */
export const DATA_LAYOUT = {
  database: "sondine.db",
  /** 0700; holds the sockets. */
  runDir: "run",
  audioSocket: "run/audio.sock",
  /** Agents' MCP sessions (ADR 011), open only while agent access is on. */
  agentSocket: "run/mcp.sock",
  /** The browser extension's link (ADR 023), open only while the user's switch is on. */
  browserSocket: "run/browser.sock",
  /** Paired phones' connections, relayed by `sondine-lan` (ADR 008). */
  phoneSocket: "run/phone.sock",
  /** The Mac's TLS identity for phones (ADR 008): 0700, its files 0600. */
  lanDir: "lan",
  /** Recordings on their way in from a phone: `<recordingId>.part` (ADR 008). */
  phoneInboxDir: "phone-inbox",
  /** The unpacked extension a browser loads (« Charger l'extension non empaquetée »). */
  browserExtensionDir: "browser-extension",
  /** Root of the helper's spool; `commit.file` paths are relative to it. */
  spoolDir: "spool",
  /** Speech chunks kept after their spool file expires (ADR 016): `<trackDir>/<runId>/NNNN.pcm`. */
  archiveDir: "archive",
  /** Audio files being imported, decoded here and emptied at each start (ADR 021). */
  importStagingDir: "import-staging",
  /** Files added to conversations, named by their SHA-256 (ADR 024). */
  contextDir: "context",
  /** Their images' previews: `<sha256>.jpg` or `.png`. */
  contextPreviewDir: "context/previews",
  /** Files on their way in (a pasted image main writes, a copy being hashed); emptied at each start. */
  contextStagingDir: "context/staging",
  /** A voice read being recorded (ADR 034): 0700, its file deleted once embedded, emptied at each start. */
  voiceReadDir: "voice-read",
  /** An update being downloaded, unpacked, or ready (ADR 045): 0700, one folder per archive. */
  updatesDir: "updates",
  /** A backup's database copy while it is written (ADR 048): 0700, emptied at each start. */
  backupWorkDir: "backup-work",
  /** A restore being unpacked, then staged (ADR 048); main swaps it in at launch. */
  restoreStagingDir: "restore-staging",
  /** Written last by core: the staging is complete and verified. */
  restoreMarker: "restore-staging/READY.json",
  /** The data a restore replaced, one folder per restore, until the user deletes it. */
  beforeRestoreDir: "before-restore",
  diagnosticsDir: "diagnostics",
  spansFile: "diagnostics/spans.jsonl",
  /** The browser link's trace (ADR 023): links, reads and plays, never a page. */
  browserTraceFile: "diagnostics/browser-link.jsonl",
} as const;

/** macOS limits `sun_path` to 104 bytes including the terminator. */
export const MAX_SOCKET_PATH_BYTES = 103;
