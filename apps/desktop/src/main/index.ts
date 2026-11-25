import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  webContents,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import type { CallContext, ContextOngoingResult, KeepRecentResult } from "@sondine/api";
import { MODEL_CATALOG } from "@sondine/engines";
// oxlint-disable-next-line import/default -- electron-vite turns `?modulePath` into the bundle's path.
import coreModulePath from "../core/index?modulePath";
import { m } from "../renderer/paraglide/messages.js";
import {
  EDIT_COMMAND_CHANNEL,
  NOTCH_LAB_CHANGED_CHANNEL,
  NOTCH_LAB_CHANNEL,
  NAVIGATE_CHANNEL,
  APP_ICON_CHANNEL,
  PASTED_FILES_CHANNEL,
  PICK_APP_CHANNEL,
  LOGIN_ITEM_CHANNEL,
  NOTIFICATION_PERMISSION_CHANNEL,
  NOTIFICATION_SETTINGS_CHANNEL,
  PORT_REQUEST_CHANNEL,
  type AppInfo,
  type EditCommand,
} from "../shared/bridge";
import { islandCard, islandView, type IslandCardAction } from "../shared/call-island";
import { callMenu, callView } from "../shared/call-menu";
import { KEEP_RECENT_SHORTCUT, keepFeedback } from "../shared/keep-recent";
import {
  ackFrom,
  isReleaseBuild,
  isReleasePage,
  relaunchFrom,
  releasePage,
  testUpdateFeed,
  type Relaunch,
} from "../shared/updates";
import { statsEndpoint } from "../shared/stats";
import { isContactMail, ISSUES_PAGE } from "../shared/contact";
import { isCloudWaitlist } from "../shared/cloud";
import type { CoreToMain, HelperProcessInfo, PrivacyPane } from "../shared/core-messages";
import { DATA_LAYOUT } from "../shared/data-layout";
import { isGraphicalSignIn } from "../shared/graphical";
import { iconTarget } from "./app-icon-ref";
import { appIcon } from "./app-icons";
import { applicationMenu } from "./app-menu";
import { isOpenCopy, readClipboard } from "./context-files";
import { pastedFiles } from "./pasted-files";
import { pickApp } from "./pick-app";
import { startCoreProcess } from "./core-process";
import { createCoreStatusTracker } from "./core-status";
import {
  dataPaths,
  resolveDataDirectory,
  sandboxedHelperCanReach,
  TEAM_ID,
} from "./data-directory";
import { loadGroupContainerAccess } from "./group-container";
import { runWindowSmoke } from "./dev-smoke";
import { createHelperSupervisor, type HelperCommand } from "./helper-supervisor";
import { launchReason, openedByLoginwindow, whenInFront, type FrontApp } from "./launch";
import { log } from "./log";
import { createMediaRelay, handleMediaRequest } from "./media-protocol";
import { createIslandIcons } from "./island-icons";
import { createNotch } from "./notch";
import { loadNotificationPermission } from "./notification-permission";
import {
  createCallOfferNotice,
  NOTICE_ID_PREFIX,
  noticeId,
  type CallOfferAnswer,
} from "./call-offer-notice";
import { installVadModel, modelsDirectory } from "./models-directory";
import { ownProcessIds, sameIds } from "./own-processes";
import { refreshPidsOnPlayback } from "./playback-refresh";
import {
  agentRelay,
  browserExtension,
  browserRelay,
  bundledVadModel,
  fakeHelperScript,
  helperExecutable,
  migrationsDirectory,
  notchTool,
  phoneRelay,
  preloadScript,
  rendererDirectory,
  speechExecutable,
  textServer,
  voiceTool,
  trayIconDirectory,
} from "./paths";
import { brokerPort } from "./port-broker";
import { frameIdentity, judgePortRequest } from "./port-request";
import { forwardPowerEvents, idleSnapshot, powerSnapshot } from "./power";
import {
  hardenSession,
  hardenWebContents,
  registerSchemes,
  serveEpisodeMedia,
  serveRenderer,
} from "./security";
import { ExportConfirmations, exportEpisodeAudio, exportText, removeSharedFiles } from "./exports";
import { confirmAndForget } from "./forget";
import { createSondineTray, trayLabel } from "./tray";
import { PASTE_CONTEXT_SHORTCUT, pasteFeedback } from "./paste-context";
import { mayRecord, trayLocale, trayState, type TrayLocale } from "./tray-state";
import {
  APP_ORIGIN,
  appUrlGuard,
  externalLinkGuard,
  mediaInitiatorGuard,
  requestGuard,
} from "./url-guard";
import { loadUpdateAddon } from "./update-addon";
import { installRefusal, relaunchCommand, startRelaunch, stillSigned } from "./update-install";
import { updateTarget } from "./update-target";
import { createVoiceRecorder } from "./voice-read";
import { createMainWindow } from "./window";

// Electron main: a thin supervisor (ADR 003). It owns the tray, the window,
// power events, the capture helper's process and the core utility process,
// and brokers one MessagePort per page between the renderer and core. It
// holds no business logic and no database, and is not on the capture path;
// for playback it only relays byte ranges between the window and core.

const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const useFakeHelper = !app.isPackaged && process.env.SONDINE_FAKE_HELPER === "1";
// SONDINE_HELPER_HAL=fake runs the real helper without audio hardware or
// permission prompts. Development only: a packaged app always uses Core Audio.
const helperHal = process.env.SONDINE_HELPER_HAL;
const useFakeHal = !app.isPackaged && helperHal === "fake";

const groupContainer = loadGroupContainerAccess();
const dataDirectory = resolveDataDirectory({
  isPackaged: app.isPackaged,
  appDataDir: app.getPath("appData"),
  override: process.env.SONDINE_DATA_DIR,
  groupContainer,
});
// Development keeps Chromium's own profile next to its data, away from a
// packaged Sondine's profile. This also scopes the single-instance lock.
if (!app.isPackaged) app.setPath("userData", join(dataDirectory.path, "electron"));

if (app.requestSingleInstanceLock()) {
  registerSchemes();
  // Closing the window destroys the renderer, not the app: it stays in the Dock and the menu bar.
  app.on("window-all-closed", () => undefined);
  // A throw inside start() must exit too, not leave a windowless process behind.
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      log.error("main.fatal", { message: error instanceof Error ? error.message : String(error) });
      app.exit(1);
    });
} else {
  app.quit();
}

const privacyPanes: Record<PrivacyPane, string> = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  // "Screen & System Audio Recording", which lists system audio capture.
  "system-audio": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

/** The VAD model the packaged helper can read (ADR 013); null in development or on failure. */
function installedVadModel(): string | null {
  const bundled = bundledVadModel();
  if (bundled === null) return null;
  const installed = installVadModel(bundled, modelsDirectory(app.getPath("home")));
  if (!installed.ok) {
    log.warn("models.vad-install-failed", { error: installed.error });
    return null;
  }
  log.info("models.vad", { path: installed.path, copied: installed.copied ? 1 : 0 });
  return installed.path;
}

function start(): void {
  // Sondine is in the Dock (ADR 003). A development build is Electron.app,
  // which stays out of it.
  if (!app.isPackaged) app.setActivationPolicy("accessory");
  /** The page decides: undo typing in a field, or the user's last edit (⌘Z history). */
  const sendEdit = (command: EditCommand) =>
    webContents.getFocusedWebContents()?.send(EDIT_COMMAND_CHANNEL, command);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenu(trayLocale(app.getLocale()), {
        edit: sendEdit,
        development: !app.isPackaged,
      }),
    ),
  );

  const reachable = !app.isPackaged || sandboxedHelperCanReach(dataDirectory);
  // A packaged helper is sandboxed: outside the group container it cannot start.
  (reachable ? log.info : log.warn)("data.directory", {
    path: dataDirectory.path,
    kind: dataDirectory.kind,
    reason: dataDirectory.reason,
  });
  const paths = dataPaths(dataDirectory.path);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });

  const isAppUrl = appUrlGuard(devServerUrl);
  const licenses = externalLinkGuard(MODEL_CATALOG.map((artifact) => artifact.license.url));
  // Model licenses, the release pages the update check points to, the cloud's
  // sign-up page (shared/cloud.ts), and in development the sign-in page of
  // Graphical's theme editor (ADR 033).
  const isExternalLink = (url: string) =>
    licenses(url) ||
    isReleasePage(url) ||
    isContactMail(url) ||
    url === ISSUES_PAGE ||
    isCloudWaitlist(url) ||
    (import.meta.env.DEV && devServerUrl !== undefined && isGraphicalSignIn(url));
  hardenSession(session.defaultSession, requestGuard(devServerUrl));
  app.on("web-contents-created", (_event, contents) =>
    hardenWebContents(contents, isAppUrl, isExternalLink),
  );
  if (devServerUrl === undefined) serveRenderer(rendererDirectory());
  // Episode audio, in development too: main relays byte ranges, core reads them.
  const media = createMediaRelay({ send: (message) => core.send(message) });
  // A transcript is written only once core says nothing was deleted meanwhile.
  const confirmations = new ExportConfirmations((message) => core.post(message));
  const isMediaInitiator = mediaInitiatorGuard(devServerUrl);
  serveEpisodeMedia((request) =>
    handleMediaRequest(request, { relay: media, isAllowedInitiator: isMediaInitiator }),
  );

  const appInfo: AppInfo = {
    locale: app.getLocale(),
    appVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
  };

  let window: BrowserWindow | null = null;
  let quitting = false;
  let updateAcknowledged = false;
  /** Development only. */
  let stopNotchLab: () => void = () => undefined;
  let helperInfo: HelperProcessInfo | null = null;
  let reportedPids: readonly number[] = [];
  let coreStarts = 0;
  /** Core's exits nobody asked for that no core has heard of yet. */
  let coreCrashes = 0;

  const locale = trayLocale(appInfo.locale);
  const tray = createSondineTray(trayIconDirectory(), locale, {
    pause: (untilMs) =>
      void core
        .client()
        ?.listening.pause(untilMs === null ? { scope: "all" } : { scope: "all", untilMs })
        .catch(logFailure("tray.pause")),
    resume: () =>
      void core.client()?.listening.resume({ scope: "all" }).catch(logFailure("tray.resume")),
    forget: (minutes) => {
      const client = core.client();
      if (client === null) return;
      void confirmAndForget(client, minutes, locale).catch(logFailure("tray.forget"));
    },
    open: () => openWindow(),
    openEpisode: (episodeId) => openWindow(`/episode/${episodeId}`),
    openPerson: (personId) => openWindow(`/people/${personId}`),
    dismissCall: (callId) =>
      void core.client()?.calls.dismiss({ callId }).catch(logFailure("tray.dismiss-call")),
    answerCall: (callId, answer) => answerCallOffer(callId, answer),
    lift: (occurrenceIds) => {
      const client = core.client();
      for (const occurrenceId of occurrenceIds) {
        void client?.privacy.lift({ occurrenceId }).catch(logFailure("tray.lift"));
      }
    },
    installUpdate: () =>
      void core.client()?.updates.install().catch(logFailure("tray.install-update")),
    pasteContext: () => void pasteContext(),
    keepRecent: () => void keepRecent(),
    quit: () => app.quit(),
  });
  /** ⌃⌥⌘V or the menu bar: the clipboard, to the conversation going on (ADR 024). */
  async function pasteContext(): Promise<void> {
    const client = core.client();
    let result: ContextOngoingResult | null = null;
    try {
      result = client === null ? null : await client.context.pasteOngoing();
    } catch (error) {
      logFailure("tray.paste-context")(error);
    }
    tray.flash(pasteFeedback(result, locale));
  }
  /** ⌃⌥⌘K or the menu bar: the last 2 minutes are kept (plan.md, Later 1). */
  async function keepRecent(): Promise<void> {
    const client = core.client();
    let result: KeepRecentResult | null = null;
    try {
      result = client === null ? null : await client.episodes.keepRecent();
    } catch (error) {
      logFailure("tray.keep-recent")(error);
    }
    tray.flash(keepFeedback(result, locale));
  }
  // Another app holding a shortcut keeps it: the menu bar item still works.
  for (const [shortcut, run] of [
    [PASTE_CONTEXT_SHORTCUT, pasteContext],
    [KEEP_RECENT_SHORTCUT, keepRecent],
  ] as const) {
    if (!globalShortcut.register(shortcut, () => void run())) {
      log.warn("shortcut.taken", { shortcut });
    }
  }
  const coreStatus = createCoreStatusTracker({
    onChange: () => updateTray(),
    onStreamEnd: (message) => log.info("tray.status-stream-ended", { message }),
  });
  // Who the call going on may be with (ADR 025), for the menu bar and the
  // notch. A stream that ends takes the call with it: nothing shows that
  // core no longer maintains.
  const callContext = createCoreStatusTracker<CallContext>({
    onChange: () => updateTray(),
    onStreamEnd: (message) => log.info("tray.call-stream-ended", { message }),
    clearOnEnd: true,
  });
  /** The island's cards already said (ADR 036). */
  const cardsDone = new Set<string>();
  const notch = createNotch({
    binary: notchTool(),
    actions: {
      openEpisode: (episodeId) => openWindow(`/episode/${episodeId}`),
      openPerson: (personId) => openWindow(`/people/${personId}`),
      dismissCall: (callId) =>
        void core.client()?.calls.dismiss({ callId }).catch(logFailure("notch.dismiss-call")),
      setCall: (callId, on) => answerCallOffer(callId, on ? "listen" : "skip"),
      muteCall: (callId) => answerCallOffer(callId, "mute"),
      endEpisode: (episodeId) => void endEpisode(episodeId),
      resume: () =>
        void core.client()?.listening.resume({ scope: "all" }).catch(logFailure("notch.resume")),
      cardDone: (key) => {
        cardsDone.add(key);
        updateTray();
      },
    },
    icon: createIslandIcons(() => updateTray()),
    onAvailable: () => updateTray(),
    log: (event, fields) => log.info(event, fields),
  });
  /** « Terminer » (ADR 044), from the island or a notification. */
  async function endEpisode(episodeId: number): Promise<void> {
    try {
      const result = await core.client()?.episodes.end({ episodeId });
      if (result?.ended === true) tray.flash(m.episode_ended({}, { locale }));
    } catch (error) {
      logFailure("notch.end-episode")(error);
    }
  }
  function cardAction({ action, episodeId }: IslandCardAction): void {
    if (action === "resume") {
      void core.client()?.listening.resume({ scope: "all" }).catch(logFailure("notice.resume"));
    } else if (episodeId !== null) {
      if (action === "end-episode") void endEpisode(episodeId);
      else openWindow(`/episode/${episodeId}`);
    }
  }
  // What the island says, as notifications where it does not show (ADR 036).
  const callOfferNotice = createCallOfferNotice({
    locale,
    answer: (callId, answer) => answerCallOffer(callId, answer),
    card: cardAction,
    supported: () => Notification.isSupported(),
    create: (options) => {
      const notification = new Notification({
        id: options.id,
        title: options.title,
        body: options.body,
        actions: [...options.actions],
      });
      return {
        onAction: (listener) =>
          notification.on("action", (details) => listener(details.actionIndex)),
        onShow: (listener) => notification.on("show", () => listener()),
        onFailed: (listener) => notification.on("failed", (_event, error) => listener(error)),
        show: () => notification.show(),
        close: () => {
          notification.close();
          Notification.remove(options.id);
        },
      };
    },
    log: (event, fields) => log.info(event, fields),
  });
  // An offer left in Notification Center by an earlier run has no one to
  // answer it: the current offer, if any, is shown again.
  if (Notification.isSupported()) {
    void Notification.getHistory()
      .then((delivered) => {
        const offer = coreStatus.current()?.listening.callOffer;
        const current = offer === undefined || offer === null ? null : noticeId(offer);
        const stale = delivered
          .map((n) => n.id)
          .filter((id) => id.startsWith(NOTICE_ID_PREFIX) && id !== current);
        if (stale.length > 0) Notification.remove(stale);
      })
      .catch(logFailure("call-offer.history"));
  }
  /** The user's answer to a call notice, from the island, the notification or the menu bar. */
  function answerCallOffer(callId: string, answer: CallOfferAnswer): void {
    const client = core.client();
    if (client === null) return;
    switch (answer) {
      case "listen":
        void client.callOffers.listen({ callId }).catch(logFailure("call-offer.listen"));
        return;
      case "skip":
        void client.callOffers.skip({ callId }).catch(logFailure("call-offer.skip"));
        return;
      case "resume":
        void client.listening.resume({ scope: "all" }).catch(logFailure("call-offer.resume"));
        return;
      case "mute":
        void client.callOffers
          .decline({ callId, forApp: true })
          .catch(logFailure("call-offer.mute"));
        return;
    }
  }
  // A lid opened or a display plugged in may bring a notch back.
  screen.on("display-added", () => notch.screensChanged());
  screen.on("display-removed", () => notch.screensChanged());
  screen.on("display-metrics-changed", () => notch.screensChanged());
  function updateTray(): void {
    const status = coreStatus.current();
    const context = callContext.current();
    const call = callView(context, locale, Date.now());
    // Only while core is down: a running core reports the spool's own state.
    tray.update(
      status,
      helperInfo,
      coreStatus.crashLoop(),
      status === null && dataDiskFull(paths.root),
      callMenu(call),
    );
    const state = trayState(status, helperInfo, coreStatus.crashLoop(), false);
    const listening = status?.listening ?? null;
    const card = listening === null ? null : islandCard(listening, locale, Date.now(), cardsDone);
    notch.update(
      islandView({
        listening,
        capture: {
          mayRecord: mayRecord(state),
          paused: state === "paused",
          label: trayLabel(state, locale, listening?.pausedUntilMs ?? null),
        },
        people: call,
        card,
        openOnHover: context?.notch.openOnHover ?? true,
        locale,
      }),
    );
    const offer = listening?.callOffer ?? null;
    const island = notch.available();
    // Not known yet: the helper answers in a moment, and this runs again.
    if (island === null && (offer !== null || card !== null)) return;
    // With another display, the one in use may not be the notch's.
    // What the island said before its helper failed is not said again.
    const elsewhere = (subject: string) =>
      island === true ? screen.getAllDisplays().length > 1 : !notch.said(subject);
    callOfferNotice.update(
      offer !== null && elsewhere(offer.callId) ? offer : null,
      card !== null && elsewhere(card.key) ? card : null,
    );
  }

  function helperCommand(): HelperCommand {
    if (helperHal !== undefined && !useFakeHal)
      log.warn("helper.hal-ignored", { hal: helperHal, packaged: app.isPackaged ? 1 : 0 });
    const args = [
      "serve",
      "--socket",
      paths.audioSocket,
      "--data",
      paths.root,
      ...(useFakeHal ? ["--hal", "fake"] : []),
    ];
    const fake = useFakeHelper ? fakeHelperScript() : null;
    if (useFakeHelper && fake === null)
      log.warn("helper.fake-missing", { hint: "run through electron-vite dev" });
    if (fake !== null) {
      log.info("helper.fake", { script: fake });
      // Electron's own binary runs the fake as plain Node (development only: the fuse is off when packaged).
      return {
        executable: process.execPath,
        args: [fake, ...args],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      };
    }
    const model = installedVadModel();
    return {
      executable: helperExecutable(),
      args,
      env: model === null ? process.env : { ...process.env, SONDINE_VAD_MODEL: model },
    };
  }

  const helper = createHelperSupervisor({
    command: helperCommand(),
    log: (event, fields) => log.info(event, fields),
    onChange: (info) => {
      helperInfo = info;
      core.post({ type: "helper-process", info });
      updateTray();
      refreshOwnPids();
    },
  });

  const speechBinary = speechExecutable();
  log.info("speech.executable", { path: speechBinary });
  const voice = voiceTool();
  log.info("voice.tool", { path: voice?.binary ?? null });
  const text = textServer(app.getPath("home"));
  log.info("text.server", { path: text?.binary ?? null });
  const relay = agentRelay(sandboxedHelperCanReach(dataDirectory));
  log.info("agents.relay", { path: relay?.path ?? null });
  const browserHost = browserRelay(sandboxedHelperCanReach(dataDirectory));
  const extension = browserExtension();
  log.info("browser.relay", { path: browserHost?.path ?? null, extension: extension !== null });
  const lan = phoneRelay(sandboxedHelperCanReach(dataDirectory));
  log.info("phone.relay", { path: lan?.path ?? null });
  // Updates (ADR 045): whether this app can replace itself, and how.
  const updateAddon = loadUpdateAddon();
  const testFeed = testUpdateFeed();
  const updateApp = updateTarget({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    released: updateAddon !== null && (isReleaseBuild() || testFeed !== null),
    team: groupContainer?.teamIdentifier() ?? null,
    expectedTeam: TEAM_ID,
    dataDirectory: paths.root,
  });
  log.info("updates.target", { blocked: updateApp.blocked });
  // The voice read's recorder (ADR 034): the helper's binary, on the same hardware.
  const recorderExecutable = helperExecutable();
  const voiceRecorder =
    useFakeHelper || !existsSync(recorderExecutable)
      ? null
      : createVoiceRecorder({
          executable: recorderExecutable,
          args: useFakeHal ? ["--hal", "fake"] : [],
          directory: join(paths.root, DATA_LAYOUT.voiceReadDir),
          post: (message) => core.post(message),
          log: (event, fields) => log.info(event, fields),
        });
  const core = startCoreProcess({
    modulePath: coreModulePath,
    args: {
      dataDir: paths.root,
      migrationsDir: migrationsDirectory(),
      helperSocket: paths.audioSocket,
      appVersion: app.getVersion(),
      macosVersion: process.getSystemVersion(),
      statsEndpoint: statsEndpoint(app.isPackaged),
      updateBlock: updateApp.blocked,
      updateTestFeed: testFeed,
      modelsDir: modelsDirectory(app.getPath("home")),
      speechBinary,
      voiceBinary: voice?.binary ?? null,
      voiceModel: voice?.model ?? null,
      textServer: text?.binary ?? null,
      textSocket: text?.socket ?? null,
      agentRelay: relay?.path ?? null,
      agentRelaySocketArgument: relay?.socketArgument ?? false,
      browserRelay: browserHost?.path ?? null,
      browserRelaySocketArgument: browserHost?.socketArgument ?? false,
      browserExtension: extension,
      phoneRelay: lan?.path ?? null,
      phoneRelayLoopback: lan?.loopback ?? false,
      voiceRecorder: voiceRecorder !== null,
    },
    onMessage: handleCoreMessage,
    onStarted: (client) => {
      coreStarts += 1;
      core.post({ type: "helper-process", info: helper.info() });
      core.post(powerSnapshot(powerMonitor.isOnBatteryPower() ? "on-battery" : "on-ac"));
      reportedPids = [];
      refreshOwnPids();
      void coreStatus.follow(() => client.status.watch());
      void callContext.follow(() => client.calls.watch());
      // Core went away on its own: the next one hears each time (ADR 042).
      for (; coreCrashes > 0; coreCrashes -= 1) {
        void client.usage
          .processCrashed({ process: "core" })
          .catch(logFailure("usage.core-crashed"));
      }
      // The renderer's port died with the previous core; give it a new one.
      if (coreStarts > 1 && window !== null) brokerTo(window);
    },
    // Main's copy of the status died with core: the tray shows the controls
    // as unavailable until the next core reports. Playback reads fail.
    onStopped: ({ crashLoop }) => {
      coreCrashes = Math.min(coreCrashes + 1, 20);
      // The core that held the microphone for a voice read is gone, and the
      // next one gives the microphone back to the intent: the read stops now
      // and keeps nothing (ADR 034).
      voiceRecorder?.abort();
      coreStatus.stopped(crashLoop);
      callContext.stopped(false);
      media.stop();
    },
  });

  function handleCoreMessage(message: CoreToMain): void {
    switch (message.type) {
      case "ready":
        log.info("core.ready", { pid: core.pid() });
        acknowledgeUpdate();
        return;
      case "open-privacy-settings":
        void shell.openExternal(privacyPanes[message.pane]).catch(logFailure("privacy-settings"));
        return;
      // The page an episode came from (ADR 023): core vouches for it, main
      // opens only http(s), in the default browser, never in the window.
      case "open-page":
        if (/^https?:\/\//.test(message.url)) {
          void shell.openExternal(message.url).catch(logFailure("open-page"));
        }
        return;
      case "reveal-folder":
        if (message.path.startsWith(`${paths.root}/`)) shell.showItemInFolder(message.path);
        return;
      // A file added to a conversation (ADR 024), from core's private copy.
      case "open-file":
        if (isOpenCopy(message.path)) {
          void shell.openPath(message.path).then((problem) => {
            if (problem !== "") log.warn("context.open-failed", {});
          });
        }
        return;
      case "pick-files":
        void pickContextFiles(locale, window).then(
          (picked) =>
            core.post({ type: "files-picked", requestId: message.requestId, paths: picked }),
          (error: unknown) => {
            logFailure("context.pick")(error);
            core.post({ type: "files-picked", requestId: message.requestId, paths: [] });
          },
        );
        return;
      case "read-clipboard":
        void readClipboard(join(paths.root, DATA_LAYOUT.contextStagingDir)).then(
          (content) => core.post({ type: "clipboard-read", requestId: message.requestId, content }),
          (error: unknown) => {
            logFailure("context.clipboard")(error);
            core.post({ type: "clipboard-read", requestId: message.requestId, content: null });
          },
        );
        return;
      case "idle-query":
        core.post(idleSnapshot());
        return;
      case "media-bytes":
      case "media-failed":
        media.receive(message);
        return;
      case "export-go":
        confirmations.receive(message);
        return;
      case "export-audio":
      case "export-text":
        void (
          message.type === "export-audio"
            ? exportEpisodeAudio(message, media, window, locale)
            : exportText(message, confirmations, window, locale)
        )
          .catch((error: unknown) => {
            logFailure("episodes.export")(error);
            return "failed" as const;
          })
          .then((outcome) =>
            core.post({ type: "exported", requestId: message.requestId, outcome }),
          );
        return;
      case "pick-file":
        void pickFile(message, locale, window).then(
          (path) => core.post({ type: "file-picked", requestId: message.requestId, path }),
          (error: unknown) => {
            logFailure("file.pick")(error);
            core.post({ type: "file-picked", requestId: message.requestId, path: null });
          },
        );
        return;
      case "voice-read-record":
        if (voiceRecorder === null) {
          core.post({
            type: "voice-read-ended",
            readId: message.readId,
            ok: false,
            message: "no recorder",
          });
        } else voiceRecorder.record(message.readId, message.path, message.maxMs);
        return;
      case "voice-read-stop":
        voiceRecorder?.stop(message.readId);
        return;
      case "network-query":
        core.post({ type: "network", network: updateAddon?.network() ?? "unknown" });
        return;
      case "install-update":
        beginUpdate(message);
        return;
      case "fatal":
        log.error("core.fatal", { message: message.message });
        return;
      case "shutdown-complete":
        return;
    }
  }

  function refreshOwnPids(): void {
    const pids = ownProcessIds(helperInfo?.pid ?? null);
    if (sameIds(pids, reportedPids)) return;
    reportedPids = pids;
    core.post({ type: "exclude-pids", pids });
  }
  // Chromium spawns and reaps its service processes on its own schedule.
  setInterval(refreshOwnPids, 30_000).unref();
  app.on("child-process-gone", () => refreshOwnPids());
  // The anonymous statistics (ADR 042): core counts these only under the user's yes.
  app.on("browser-window-focus", () => {
    void core.client()?.usage.windowOpened().catch(logFailure("usage.window"));
  });
  app.on("render-process-gone", (_event, _contents, { reason }) => {
    if (reason === "clean-exit" || reason === "killed") return;
    void core
      .client()
      ?.usage.processCrashed({ process: "renderer" })
      .catch(logFailure("usage.renderer-crashed"));
  });

  function brokerTo(target: BrowserWindow): void {
    brokerPort(target, (port) => core.post({ type: "renderer-port", windowId: target.id }, [port]));
    log.info("port.brokered", { windowId: target.id });
  }

  ipcMain.on(PORT_REQUEST_CHANNEL, (event) => {
    const target = window !== null && !window.isDestroyed() ? window : null;
    const verdict = judgePortRequest(
      event.senderFrame === null ? null : frameIdentity(event.senderFrame),
      target === null ? null : frameIdentity(target.webContents.mainFrame),
      isAppUrl,
    );
    if (!verdict.ok || target === null) {
      log.warn("port.refused", { reason: verdict.ok ? "no-window" : verdict.reason });
      return;
    }
    brokerTo(target);
  });

  // « Ouvrir Sondine à l'ouverture de session »: only the app's own window asks.
  ipcMain.handle(APP_ICON_CHANNEL, (event, ref: unknown) => {
    const target = window !== null && !window.isDestroyed() ? window : null;
    const verdict = judgePortRequest(
      event.senderFrame === null ? null : frameIdentity(event.senderFrame),
      target === null ? null : frameIdentity(target.webContents.mainFrame),
      isAppUrl,
    );
    if (!verdict.ok) return null;
    const asked = iconTarget(ref);
    return asked === null ? null : appIcon(asked);
  });

  // « Ajouter une app… » in Settings ▸ Dictées: only the app's own window asks.
  ipcMain.handle(PICK_APP_CHANNEL, async (event) => {
    const target = window !== null && !window.isDestroyed() ? window : null;
    const verdict = judgePortRequest(
      event.senderFrame === null ? null : frameIdentity(event.senderFrame),
      target === null ? null : frameIdentity(target.webContents.mainFrame),
      isAppUrl,
    );
    if (!verdict.ok) {
      log.warn("pick-app.refused", { reason: verdict.reason });
      return null;
    }
    const picked = await pickApp(target, m.settings_dictation_pick_message({}, { locale }));
    log.info("pick-app.picked", { chosen: picked === null ? 0 : 1 });
    return picked;
  });

  // A paste on « Importés »: only the app's own window asks.
  ipcMain.handle(PASTED_FILES_CHANNEL, (event) => {
    const target = window !== null && !window.isDestroyed() ? window : null;
    const verdict = judgePortRequest(
      event.senderFrame === null ? null : frameIdentity(event.senderFrame),
      target === null ? null : frameIdentity(target.webContents.mainFrame),
      isAppUrl,
    );
    if (!verdict.ok) return [];
    return pastedFiles();
  });

  /** Whether an invoke comes from the window's own page. */
  function fromWindow(event: IpcMainInvokeEvent): boolean {
    const target = window !== null && !window.isDestroyed() ? window : null;
    return judgePortRequest(
      event.senderFrame === null ? null : frameIdentity(event.senderFrame),
      target === null ? null : frameIdentity(target.webContents.mainFrame),
      isAppUrl,
    ).ok;
  }

  const notificationPermission = loadNotificationPermission();
  // What macOS lets through, in the log of each launch (a refusal is otherwise silent until a call).
  void notificationPermission().then((permission) =>
    log.info("notifications.permission", { permission }),
  );
  ipcMain.handle(NOTIFICATION_PERMISSION_CHANNEL, (event) =>
    fromWindow(event) ? notificationPermission() : "unknown",
  );

  ipcMain.handle(NOTIFICATION_SETTINGS_CHANNEL, (event) => {
    if (!fromWindow(event)) return;
    void shell
      .openExternal(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=app.sondine",
      )
      .catch(logFailure("notification-settings.open"));
  });

  // Development only, left out of production builds: the notch lab.
  if (import.meta.env.DEV) {
    void import("./notch-lab").then(({ createNotchLab }) => {
      const lab = createNotchLab(
        {
          debug: join(app.getAppPath(), "../../native/.build/debug/sondine-notch"),
          release: notchTool(),
        },
        (view) => {
          if (window !== null && !window.isDestroyed())
            window.webContents.send(NOTCH_LAB_CHANGED_CHANNEL, view);
        },
      );
      stopNotchLab = () => lab.stop();
      ipcMain.handle(NOTCH_LAB_CHANNEL, async (event, command: unknown) => {
        if (!fromWindow(event)) return null;
        if (command === null) return lab.view();
        const { LabCommand } = await import("../shared/notch-lab");
        return lab.run(LabCommand.parse(command));
      });
    });
  }

  ipcMain.handle(LOGIN_ITEM_CHANNEL, (event, open: unknown) => {
    const target = window !== null && !window.isDestroyed() ? window : null;
    const verdict = judgePortRequest(
      event.senderFrame === null ? null : frameIdentity(event.senderFrame),
      target === null ? null : frameIdentity(target.webContents.mainFrame),
      isAppUrl,
    );
    if (!verdict.ok) {
      log.warn("login-item.refused", { reason: verdict.reason });
      return false;
    }
    if (typeof open === "boolean") {
      app.setLoginItemSettings({ openAtLogin: open });
      log.info("login-item.set", { open: open ? 1 : 0 });
    }
    return app.getLoginItemSettings().openAtLogin;
  });

  /** This start follows an update: the shell that opened it hears that core runs. */
  function acknowledgeUpdate(): void {
    const name = ackFrom(process.argv);
    if (name === null || updateAcknowledged) return;
    updateAcknowledged = true;
    try {
      writeFileSync(join(app.getPath("temp"), name), "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      logFailure("updates.acknowledge")(error);
    }
  }

  /** The update being installed: this process ends with it (ADR 045). */
  let updating: {
    readonly version: string;
    readonly app: string;
    readonly relaunch: Relaunch;
  } | null = null;

  /** Core checked the app and nothing would be cut: Sondine stops, then starts again updated. */
  function beginUpdate(request: { readonly version: string; readonly app: string }): void {
    const reason = quitting
      ? "quitting"
      : installRefusal(request, {
          target: updateAddon === null ? null : updateApp.app,
          current: app.getVersion(),
          updatesDirectory: join(paths.root, DATA_LAYOUT.updatesDir),
        });
    if (reason !== null) {
      log.warn("updates.refused", { reason });
      core.post({ type: "update-failed", reason });
      return;
    }
    const open = window !== null && !window.isDestroyed() ? window : null;
    const { hash } = new URL(open?.webContents.getURL() ?? "about:blank");
    updating = {
      ...request,
      relaunch: {
        window: open === null ? "closed" : open.isFocused() ? "front" : "behind",
        path: open === null || hash === "" ? null : hash.slice(1),
      },
    };
    const options = { locale };
    // Before anything stops: whatever happens next, the app opens again.
    const started = startRelaunch(
      relaunchCommand(
        process.pid,
        updateApp.app ?? "",
        updating.relaunch,
        { directory: app.getPath("temp"), name: `sondine-update-${randomUUID()}` },
        {
          title: m.update_not_started_title({ version: request.version }, options),
          body: m.update_not_started_body({}, options),
          close: m.update_not_started_close({}, options),
          open: m.update_not_started_open({}, options),
          page: releasePage(request.version),
        },
      ),
    );
    if (!started) {
      updating = null;
      log.warn("updates.refused", { reason: "relaunch" });
      core.post({ type: "update-failed", reason: "relaunch" });
      return;
    }
    log.info("updates.begin", { version: request.version, window: updating.relaunch.window });
    app.quit();
  }

  /** Sondine's processes have stopped: the new app takes this one's place, if it is still it. */
  function finishUpdate({ version, app: next }: NonNullable<typeof updating>): void {
    if (updateApp.app === null) return;
    const signed = stillSigned(next);
    // Not replaced, the same version opens again, and says so.
    const failure = signed ? (updateAddon?.swap(next, updateApp.app) ?? -1) : -1;
    log.info("updates.swapped", { version, signed, errno: failure });
  }

  /**
   * Shows the window, on `path` (a conversation or a person) when given;
   * `behind`, without taking the place of the app in front (after an update).
   */
  function openWindow(path?: string, behind = false): void {
    // The Dock icon stays while Sondine stops: a click has no core to show.
    if (quitting) return;
    if (window !== null && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      app.focus({ steal: true });
      if (path !== undefined) window.webContents.send(NAVIGATE_CHANNEL, path);
      return;
    }
    const opened = createMainWindow({
      url: `${devServerUrl ?? `${APP_ORIGIN}/index.html`}${path === undefined ? "" : `#${path}`}`,
      preload: preloadScript(),
      info: appInfo,
      behind,
      onClosed: () => {
        window = null;
        stopNotchLab();
        log.info("window.closed");
        // Its renderer process exits shortly after.
        setTimeout(refreshOwnPids, 2_000).unref();
      },
    });
    window = opened;
    if (!app.isPackaged) {
      opened.webContents.on("console-message", (event) =>
        log.info("renderer.console", { level: event.level, message: event.message.slice(0, 500) }),
      );
    }
    opened.webContents.once("did-finish-load", () => refreshOwnPids());
    // The first playback starts Chromium's audio service: exclude it from the tap now.
    refreshPidsOnPlayback(opened.webContents, refreshOwnPids);
    if (!behind) app.focus({ steal: true });
    log.info("window.opened", { id: opened.id });
  }

  app.on("second-instance", () => openWindow());
  const frontApp: FrontApp = {
    isActive: () => app.isActive(),
    onActive: (listener) => {
      app.on("did-become-active", listener);
      return () => app.off("did-become-active", listener);
    },
  };
  // Opening Sondine while it runs (Dock, Finder, Spotlight, `open`); in the
  // background (`open -g`, or a login that opens it twice), nothing shows.
  app.on("activate", () =>
    whenInFront(frontApp, (inFront) => {
      log.info("app.activate", { inFront });
      if (inFront) openWindow();
    }),
  );
  forwardPowerEvents(
    (message) => core.post(message),
    () => app.quit(),
  );

  app.on("will-quit", () => globalShortcut.unregisterAll());

  let readyToQuit = false;
  app.on("before-quit", (event) => {
    if (readyToQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void shutdown().finally(() => {
      readyToQuit = true;
      if (updating !== null) {
        try {
          finishUpdate(updating);
        } catch (error) {
          logFailure("updates.finish")(error);
        }
        // The shell waits for this process: it must go, whatever holds the quit.
        setTimeout(() => app.exit(0), 5_000);
      }
      app.quit();
    });
  });

  async function shutdown(): Promise<void> {
    log.info("main.shutdown");
    // Core asks the helper to commit and stop; it must not be restarted meanwhile.
    helper.retire();
    voiceRecorder?.stopAll();
    const notchStopped = notch.stop();
    window?.destroy();
    await core.stop();
    await helper.stop();
    await notchStopped;
    await removeSharedFiles();
    tray.destroy();
    log.info("main.shutdown-complete");
  }

  // A previous run's shared files, if it could not remove them.
  void removeSharedFiles();

  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());

  // A sandboxed helper that cannot reach the data directory exits at once:
  // leave it stopped (capture unavailable) instead of restarting it forever.
  if (reachable) helper.start();
  else
    log.warn("helper.not-started", {
      reason: "the sandboxed helper cannot reach the data directory",
    });
  const updated = relaunchFrom(process.argv);
  if (updated !== null) {
    log.info("updates.relaunched", {
      window: updated.window,
      openAtLogin: app.getLoginItemSettings().openAtLogin,
    });
    if (updated.window !== "closed") {
      openWindow(updated.path ?? undefined, updated.window === "behind");
    }
    return;
  }
  if (app.isPackaged) {
    const { wasOpenedAtLogin } = app.getLoginItemSettings();
    launchReason(frontApp, wasOpenedAtLogin || openedByLoginwindow(), (reason) => {
      log.info("app.launched", { reason });
      if (reason === "person") openWindow();
    });
    return;
  }
  // Development opens the window at launch (SONDINE_OPEN_WINDOW=0 keeps it
  // closed); SONDINE_SMOKE=1 opens and closes it on a timer instead.
  if (process.env.SONDINE_SMOKE === "1") {
    runWindowSmoke({
      open: openWindow,
      close: () => window?.close(),
      log: (event) => log.info(event),
    });
  } else if (process.env.SONDINE_OPEN_WINDOW !== "0") {
    // SONDINE_OPEN_PATH=/notch-lab opens it on a page.
    openWindow(process.env.SONDINE_OPEN_PATH);
  }
}

// SQLite needs room to open its WAL, the spool 64 KB/s per track: below
// this, the data volume counts as full.
const LOW_DISK_BYTES = 16 * 1024 * 1024;

function dataDiskFull(path: string): boolean {
  try {
    const volume = statfsSync(path);
    return volume.bavail * volume.bsize < LOW_DISK_BYTES;
  } catch {
    return false;
  }
}

/**
 * The open panel core asks for (`models.pick`, `imports.pick`), limited to
 * the file's extensions; a sheet on the window when one is open. Opening a
 * file the user chose also lets Sondine read it in Downloads or Documents
 * without another prompt.
 */
async function pickFile(
  request: Extract<CoreToMain, { type: "pick-file" }>,
  locale: TrayLocale,
  window: BrowserWindow | null,
): Promise<string | null> {
  const options: OpenDialogOptions = {
    properties: ["openFile"],
    message:
      request.purpose === "model"
        ? m.model_pick_message({ name: request.label }, { locale })
        : m.imports_pick_message({}, { locale }),
    filters: [{ name: request.label, extensions: request.extensions }],
    defaultPath: app.getPath("downloads"),
  };
  app.focus({ steal: true });
  const parent = window !== null && !window.isDestroyed() && window.isVisible() ? window : null;
  const result =
    parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
  log.info("file.picked", { purpose: request.purpose, chosen: result.canceled ? 0 : 1 });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** « Choisir des fichiers… » for a conversation's context: any files, up to 20. */
async function pickContextFiles(
  locale: TrayLocale,
  window: BrowserWindow | null,
): Promise<string[]> {
  const options: OpenDialogOptions = {
    properties: ["openFile", "multiSelections"],
    message: m.context_pick_message({}, { locale }),
  };
  app.focus({ steal: true });
  const parent = window !== null && !window.isDestroyed() && window.isVisible() ? window : null;
  const result =
    parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
  log.info("context.picked", { chosen: result.canceled ? 0 : result.filePaths.length });
  return result.canceled ? [] : result.filePaths.slice(0, 20);
}

function logFailure(event: string) {
  return (error: unknown) =>
    log.warn(event, { message: error instanceof Error ? error.message : String(error) });
}
