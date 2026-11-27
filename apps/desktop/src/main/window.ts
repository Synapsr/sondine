import { app, BrowserWindow, nativeTheme } from "electron";
import { APP_INFO_ARGUMENT, type AppInfo } from "../shared/bridge";

export interface MainWindowOptions {
  readonly url: string;
  readonly preload: string;
  readonly info: AppInfo;
  /** Shown without taking the place of the app in front (after an update, ADR 045). */
  readonly behind: boolean;
  readonly onClosed: () => void;
}

/**
 * The only window. It is created on demand and destroyed on close, so the
 * renderer process exists only while it is open (ADR 003).
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Sondine",
    // No title bar (ADR 037): the traffic lights sit over the sidebar, and the
    // window's own top edges are its drag areas (`app-region: drag`).
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    // The sidebar's ground (neutral-2), so the first frame does not flash.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1e" : "#fbfbfb",
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      additionalArguments: [`${APP_INFO_ARGUMENT}${JSON.stringify(options.info)}`],
    },
  });
  window.once("ready-to-show", () => (options.behind ? window.showInactive() : window.show()));
  window.once("closed", options.onClosed);
  void window.loadURL(options.url);
  return window;
}
