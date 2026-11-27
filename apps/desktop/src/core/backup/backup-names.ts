import { DATA_LAYOUT } from "../../shared/data-layout";

// The files a backup may hold (ADR 048), by their path in the data
// directory. A restore refuses any other name before writing a byte of it,
// so a crafted backup cannot write outside the staging folder.

/** The Mac's identity for its phones (ADR 008), in `lan/`. */
export const LAN_FILES = ["cert.pem", "identity.p12", "identity.pass"] as const;

/** The window's settings (language, appearance, shortcuts), as JSON. */
export const RENDERER_FILE = "renderer.json";

/** A directory name the helper or core wrote: no separator, not `.` or `..`, nothing hidden. */
const SEGMENT = "[A-Za-z0-9_@:+-][A-Za-z0-9_.@:+-]{0,199}";
const SHA = "[0-9a-f]{64}";

const PATTERNS = [
  new RegExp(`^${DATA_LAYOUT.archiveDir}/${SEGMENT}/${SEGMENT}/\\d{4,9}\\.pcm$`),
  new RegExp(`^${DATA_LAYOUT.contextDir}/${SHA}$`),
  new RegExp(`^${DATA_LAYOUT.contextPreviewDir}/${SHA}\\.(jpg|png)$`),
];

/** Whether a restore may write `name` into its staging folder. */
export function isRestorableName(name: string): boolean {
  if (name === DATA_LAYOUT.database || name === RENDERER_FILE) return true;
  if ((LAN_FILES as readonly string[]).some((file) => name === `${DATA_LAYOUT.lanDir}/${file}`)) {
    return true;
  }
  return (
    !name.split("/").some((part) => part === ".." || part === ".") &&
    PATTERNS.some((pattern) => pattern.test(name))
  );
}
