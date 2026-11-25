// The few extension APIs this extension uses, typed by hand under Chrome's
// names. Helium offers them as `chrome`; Yab (WKWebExtension) offers them as
// `browser` and through a `chrome` shim. Every field a browser may leave out
// is optional, and the calls that return a promise in Chrome may return
// nothing elsewhere.

export interface Tab {
  id?: number;
  url?: string;
  title?: string;
  audible?: boolean;
  incognito?: boolean;
  mutedInfo?: { muted?: boolean };
}

/** What `tabs.onUpdated` says changed. */
export interface TabChange {
  audible?: boolean;
  url?: string;
  title?: string;
  mutedInfo?: { muted?: boolean };
  discarded?: boolean;
}

export interface ExtensionEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** A native messaging port (`runtime.connectNative`). */
export interface Port {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ExtensionEvent<(message: unknown) => void>;
  onDisconnect: ExtensionEvent<() => void>;
}

export interface MessageSender {
  id?: string;
  tab?: Tab;
  frameId?: number;
}

export interface Runtime {
  id?: string;
  lastError?: { message?: string } | null;
  getManifest(): { version: string };
  connectNative?(application: string): Port;
  sendMessage(message: unknown): Promise<unknown> | undefined;
  onMessage: ExtensionEvent<
    (message: unknown, sender: MessageSender, sendResponse?: (response: unknown) => void) => void
  >;
}

export interface Tabs {
  query(filter: Record<string, never>): Promise<Tab[]>;
  sendMessage(tabId: number, message: unknown): Promise<unknown> | undefined;
  onUpdated: ExtensionEvent<(tabId: number, change: TabChange, tab?: Tab) => void>;
  onRemoved: ExtensionEvent<(tabId: number) => void>;
  onReplaced: ExtensionEvent<(addedTabId: number, removedTabId: number) => void>;
}

export interface Alarms {
  create(name: string, info: { periodInMinutes: number }): Promise<void> | undefined;
  clear(name: string): Promise<boolean> | undefined;
  onAlarm: ExtensionEvent<(alarm: { name: string }) => void>;
}

export interface ExtensionApi {
  runtime: Runtime;
  tabs?: Tabs;
  alarms?: Alarms;
}

declare global {
  var chrome: ExtensionApi | undefined;
  var browser: ExtensionApi | undefined;
}

/** The browser's extension API: `chrome` where it has a runtime, else `browser`. */
export function extensionApi(): ExtensionApi | undefined {
  const chrome = globalThis.chrome;
  return chrome?.runtime === undefined ? globalThis.browser : chrome;
}

/** Calls an API whose failure only means "not now": swallows a throw or a rejected promise. */
export function quietly(call: () => Promise<unknown> | undefined): void {
  try {
    call()?.catch(() => undefined);
  } catch {
    // The API is missing or the extension context is gone.
  }
}
