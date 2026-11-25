import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  APP_INFO_ARGUMENT,
  NOTIFICATION_PERMISSION_CHANNEL,
  NOTIFICATION_SETTINGS_CHANNEL,
  EDIT_COMMAND_CHANNEL,
  APP_ICON_CHANNEL,
  NAVIGABLE_PATH,
  NAVIGATE_CHANNEL,
  NOTCH_LAB_CHANGED_CHANNEL,
  NOTCH_LAB_CHANNEL,
  PASTED_FILES_CHANNEL,
  PICK_APP_CHANNEL,
  LOGIN_ITEM_CHANNEL,
  PORT_REPLY_CHANNEL,
  PORT_REQUEST_CHANNEL,
  PORT_WINDOW_MESSAGE,
  type AppInfo,
  type EditCommand,
  type NotchLabBridge,
  type SondineBridge,
} from "../shared/bridge";

// Sandboxed preload: no Node, only the Electron modules a sandbox allows. It
// exposes to the page and nothing else: the app info main passed in argv, a
// way to ask for a MessagePort to core, the Edit menu's undo and redo, the
// pages main shows from the menu bar, the login item, app icons and files.

function readAppInfo(): AppInfo {
  const fallback: AppInfo = {
    locale: "en",
    appVersion: "0.0.0",
    platform: "darwin",
    isPackaged: false,
  };
  const raw = process.argv.find((argument) => argument.startsWith(APP_INFO_ARGUMENT));
  if (raw === undefined) return fallback;
  try {
    const value: unknown = JSON.parse(raw.slice(APP_INFO_ARGUMENT.length));
    if (typeof value !== "object" || value === null) return fallback;
    const field = (key: string) => (key in value ? Reflect.get(value, key) : undefined);
    const locale = field("locale");
    const appVersion = field("appVersion");
    const platform = field("platform");
    const isPackaged = field("isPackaged");
    return {
      locale: typeof locale === "string" ? locale : fallback.locale,
      appVersion: typeof appVersion === "string" ? appVersion : fallback.appVersion,
      platform: typeof platform === "string" ? platform : fallback.platform,
      isPackaged: typeof isPackaged === "boolean" ? isPackaged : fallback.isPackaged,
    };
  } catch {
    return fallback;
  }
}

// A MessagePort cannot cross the context bridge; it is transferred to the
// page with window.postMessage, restricted to the page's own origin.
ipcRenderer.on(PORT_REPLY_CHANNEL, (event) => {
  const [port] = event.ports;
  if (port === undefined) return;
  window.postMessage(PORT_WINDOW_MESSAGE, window.location.origin, [port]);
});

// Development only, left out of production builds. Main and the page are the
// same build, so what main answers is taken as it is.
const notchLab: NotchLabBridge = {
  run: (command) => ipcRenderer.invoke(NOTCH_LAB_CHANNEL, command),
  onChange: (listener) => {
    const relay = (_event: unknown, view: Parameters<typeof listener>[0]) => listener(view);
    ipcRenderer.on(NOTCH_LAB_CHANGED_CHANNEL, relay);
    return () => void ipcRenderer.removeListener(NOTCH_LAB_CHANGED_CHANNEL, relay);
  },
};

const bridge: SondineBridge = {
  info: Object.freeze(readAppInfo()),
  requestCorePort: () => ipcRenderer.send(PORT_REQUEST_CHANNEL),
  onEditCommand: (listener) => {
    const relay = (_event: unknown, command: unknown) => {
      if (command === "undo" || command === "redo") listener(command satisfies EditCommand);
    };
    ipcRenderer.on(EDIT_COMMAND_CHANNEL, relay);
    return () => void ipcRenderer.removeListener(EDIT_COMMAND_CHANNEL, relay);
  },
  onNavigate: (listener) => {
    const relay = (_event: unknown, path: unknown) => {
      if (typeof path === "string" && NAVIGABLE_PATH.test(path)) listener(path);
    };
    ipcRenderer.on(NAVIGATE_CHANNEL, relay);
    return () => void ipcRenderer.removeListener(NAVIGATE_CHANNEL, relay);
  },
  loginItem: async (open) => {
    const answer: unknown = await ipcRenderer.invoke(LOGIN_ITEM_CHANNEL, open);
    return answer === true;
  },
  appIcon: async (ref) => {
    const answer: unknown = await ipcRenderer.invoke(APP_ICON_CHANNEL, ref);
    return typeof answer === "string" && answer.startsWith("data:image/png;base64,")
      ? answer
      : null;
  },
  pathsOfFiles: (files) =>
    files.map((file) => webUtils.getPathForFile(file)).filter((path) => path !== ""),
  pastedFiles: async () => {
    const answer: unknown = await ipcRenderer.invoke(PASTED_FILES_CHANNEL);
    return Array.isArray(answer)
      ? answer.filter((path): path is string => typeof path === "string")
      : [];
  },
  notificationPermission: async () => {
    const answer: unknown = await ipcRenderer.invoke(NOTIFICATION_PERMISSION_CHANNEL);
    return answer === "allowed" || answer === "silent" || answer === "blocked" ? answer : "unknown";
  },
  openNotificationSettings: () => void ipcRenderer.invoke(NOTIFICATION_SETTINGS_CHANNEL),
  pickApp: async () => {
    const answer: unknown = await ipcRenderer.invoke(PICK_APP_CHANNEL);
    if (typeof answer !== "object" || answer === null) return null;
    const { bundleId, name } = answer as Record<string, unknown>;
    return typeof bundleId === "string" && typeof name === "string" ? { bundleId, name } : null;
  },
  ...(import.meta.env.DEV ? { notchLab } : {}),
};

contextBridge.exposeInMainWorld("sondine", bridge);
