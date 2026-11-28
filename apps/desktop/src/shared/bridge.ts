import type { LabCommand as FlowLabCommand, LabView as FlowLabView } from "./flow-lab";
import type { LabCommand, LabView } from "./notch-lab";

// The renderer ⇄ preload contract. Environment-free: the renderer compiles it
// with DOM types only.

/** Preload → main: ask for a MessagePort to core. */
export const PORT_REQUEST_CHANNEL = "sondine:port-request";
/** Main → preload: the renderer's end of the channel, in `event.ports`. */
export const PORT_REPLY_CHANNEL = "sondine:port";
/** Preload → page, through window.postMessage with the port transferred. */
export const PORT_WINDOW_MESSAGE = "sondine:core-port";
/** Main → preload: Édition ▸ Annuler or Rétablir, from the menu or ⌘Z / ⇧⌘Z. */
export const EDIT_COMMAND_CHANNEL = "sondine:edit-command";

export type EditCommand = "undo" | "redo";

/** Main → preload: show this page (`/episode/<id>`, `/people/<id>`), from the menu bar. */
export const NAVIGATE_CHANNEL = "sondine:navigate";

/** The pages main may open: a conversation or a person. */
export const NAVIGABLE_PATH = /^\/(episode|people)\/\d+$/u;

/** Preload ⇄ main (invoke): « Ouvrir Sondine à l'ouverture de session », read or set. */
export const LOGIN_ITEM_CHANNEL = "sondine:login-item";

/** Preload ⇄ main (invoke): an app's icon, as a PNG data URL. */
export const APP_ICON_CHANNEL = "sondine:app-icon";

/** Preload ⇄ main (invoke): an open panel for one app, for Settings ▸ Dictées. */
export const PICK_APP_CHANNEL = "sondine:pick-app";

/** Preload ⇄ main (invoke): the files copied in Finder, for a paste on « Importés ». */
export const PASTED_FILES_CHANNEL = "sondine:pasted-files";

/** Preload ⇄ main (invoke): whether macOS lets Sondine's notifications reach the screen (ADR 036). */
export const NOTIFICATION_PERMISSION_CHANNEL = "sondine:notification-permission";

/** Preload ⇄ main (invoke): System Settings ▸ Notifications, where macOS allows Sondine's. */
export const NOTIFICATION_SETTINGS_CHANNEL = "sondine:notification-settings";

/**
 * Sondine's notifications as macOS lets them through: on screen (`allowed`),
 * kept in Notification Center only (`silent`), refused or never allowed
 * (`blocked`), or not known (a development build).
 */
export type NotificationPermission = "allowed" | "silent" | "blocked" | "unknown";

/** An app the user chose in the open panel. */
export interface PickedApp {
  readonly bundleId: string;
  /** As Finder shows it. */
  readonly name: string;
}

/** An app by its bundle ID, or by its bundle's path (what the memory bar knows). */
export type AppIconRef = { readonly bundleId: string } | { readonly appPath: string };

export interface AppInfo {
  /** `app.getLocale()`, for example `fr-FR`. */
  readonly locale: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly isPackaged: boolean;
}

/** Development only. Preload ⇄ main (invoke): a command of the notch lab, or null to read it. */
export const NOTCH_LAB_CHANNEL = "sondine:notch-lab";
/** Development only. Main → preload: the notch lab changed. */
export const NOTCH_LAB_CHANGED_CHANNEL = "sondine:notch-lab-changed";

/** Development only: the flow lab's HUD (ADR 049). */
export const FLOW_LAB_CHANNEL = "sondine:flow-lab";
/** Main tells the HUD what changed (a step put back, a problem). */
export const FLOW_LAB_CHANGED_CHANNEL = "sondine:flow-lab-changed";

export interface FlowLabBridge {
  /** Runs a command, or only reads; null outside the lab (`pnpm dev`). */
  run(command: FlowLabCommand | null): Promise<FlowLabView | null>;
  /** Returns the unsubscribe. */
  onChange(listener: (view: FlowLabView) => void): () => void;
}

export interface NotchLabBridge {
  /** Runs a command, or only reads. */
  run(command: LabCommand | null): Promise<LabView>;
  /** Returns the unsubscribe. */
  onChange(listener: (view: LabView) => void): () => void;
}

/** Exposed on `window.sondine` by the preload script. */
export interface SondineBridge {
  readonly info: AppInfo;
  /** Asks main for a fresh port to core; it arrives as a window message. */
  requestCorePort(): void;
  /**
   * Calls `listener` on Édition ▸ Annuler / Rétablir (⌘Z, ⇧⌘Z): the page
   * undoes typing in a field, or the last edit. Returns the unsubscribe.
   */
  onEditCommand(listener: (command: EditCommand) => void): () => void;
  /**
   * Calls `listener` when main shows a page in the window (a conversation or
   * a person, from the menu bar). Returns the unsubscribe.
   */
  onNavigate(listener: (path: string) => void): () => void;
  /**
   * Whether Sondine opens at login (a macOS login item); with `open`, sets it
   * first. Resolves to the state macOS reports.
   */
  loginItem(open?: boolean): Promise<boolean>;
  /** An app's icon as a PNG data URL; null when the app is not found. */
  appIcon(ref: AppIconRef): Promise<string | null>;
  /** Opens a panel on /Applications; the app chosen, or null when none was. */
  pickApp(): Promise<PickedApp | null>;
  /** Where dropped files are on this Mac; files with no path (not from the disk) are left out. */
  pathsOfFiles(files: readonly File[]): string[];
  /** The files copied in Finder, for a paste: their paths, none when the clipboard holds no file. */
  pastedFiles(): Promise<string[]>;
  /** Whether macOS lets Sondine's notifications reach the screen, read now. */
  notificationPermission(): Promise<NotificationPermission>;
  /** Opens System Settings ▸ Notifications. */
  openNotificationSettings(): void;
  /** Development only: the notch lab. */
  readonly notchLab?: NotchLabBridge;
  /** Development only: the flow lab. */
  readonly flowLab?: FlowLabBridge;
}

/** `additionalArguments` prefix main uses to hand AppInfo to the sandboxed preload. */
export const APP_INFO_ARGUMENT = "--sondine-app-info=";
