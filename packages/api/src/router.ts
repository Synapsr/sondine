import {
  implement,
  ORPCError,
  type ORPCErrorConstructorMap,
  type RouterClient,
} from "@orpc/server";
import type { UsageError } from "@sondine/protocol";
import { contract } from "./contract";
import { ServiceFailure, type apiErrors } from "./errors";
import type { ApiContext } from "./services";

/** Sondine's own failures, as the statistics name them; a refused request is not one. */
function failureCode(error: unknown): UsageError | null {
  if (!(error instanceof ORPCError)) return "api_internal";
  switch (error.code) {
    case "HELPER_UNAVAILABLE":
      return "api_helper_unavailable";
    case "HELPER_REJECTED":
      return "api_helper_rejected";
    case "TIMEOUT":
      return "api_timeout";
    case "INTERNAL_SERVER_ERROR":
      return "api_internal";
    default:
      return null;
  }
}

/**
 * In front of every procedure, the one place use is counted (ADR 042): the
 * event's name on success, the error's code on failure, never the input or
 * the output. Without the user's yes it does nothing.
 */
const os = implement(contract)
  .$context<ApiContext>()
  .use(async ({ context, next, procedure, signal }) => {
    const { usage } = context;
    const begun = usage?.counter.begin() ?? null;
    if (usage === undefined || begun === null) return next();
    try {
      const result = await next();
      usage.counter.succeeded(begun, usage.surface, procedure["~orpc"].meta.event);
      return result;
    } catch (error) {
      const code = signal?.aborted === true ? null : failureCode(error);
      if (code !== null) usage.counter.failed(begun, code);
      throw error;
    }
  });

type ApiErrorConstructors = ORPCErrorConstructorMap<typeof apiErrors>;

/** Turns an expected service failure into the matching typed error. */
async function guard<T>(errors: ApiErrorConstructors, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ServiceFailure)) throw error;
    switch (error.code) {
      case "helper-unavailable":
        throw errors.HELPER_UNAVAILABLE({ message: error.message, cause: error });
      case "helper-rejected":
        throw errors.HELPER_REJECTED({
          message: error.message,
          data: { code: error.helperCode ?? "unknown" },
          cause: error,
        });
      case "timeout":
        throw errors.TIMEOUT({ message: error.message, cause: error });
      case "not-found":
        throw errors.NOT_FOUND({ message: error.message, cause: error });
      case "invalid-input":
        throw errors.INVALID_INPUT({ message: error.message, cause: error });
    }
  }
}

export const router = os.router({
  status: {
    get: os.status.get.handler(({ context, errors }) =>
      guard(errors, () => context.services.status.get()),
    ),
    watch: os.status.watch.handler(async function* ({ context, signal }) {
      for await (const status of context.services.status.watch(signal)) yield status;
    }),
  },
  listening: {
    pause: os.listening.pause.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.listening.pause(input)),
    ),
    resume: os.listening.resume.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.listening.resume(input)),
    ),
  },
  callOffers: {
    listen: os.callOffers.listen.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.callOffers.listen(input)),
    ),
    skip: os.callOffers.skip.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.callOffers.skip(input)),
    ),
    decline: os.callOffers.decline.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.callOffers.decline(input)),
    ),
    settings: os.callOffers.settings.handler(({ context, errors }) =>
      guard(errors, () => context.services.callOffers.settings()),
    ),
    setEnabled: os.callOffers.setEnabled.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.callOffers.setEnabled(input)),
    ),
    allowApp: os.callOffers.allowApp.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.callOffers.allowApp(input)),
    ),
  },
  permissions: {
    request: os.permissions.request.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.permissions.request(input)),
    ),
  },
  episodes: {
    day: os.episodes.day.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.day(input)),
    ),
    list: os.episodes.list.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.list(input)),
    ),
    get: os.episodes.get.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.get(input)),
    ),
    playback: os.episodes.playback.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.playback(input)),
    ),
    exportAudio: os.episodes.exportAudio.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.exportAudio(input)),
    ),
    exportText: os.episodes.exportText.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.exportText(input)),
    ),
    openPage: os.episodes.openPage.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.openPage(input)),
    ),
    end: os.episodes.end.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.end(input)),
    ),
    split: os.episodes.split.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.split(input)),
    ),
    setKind: os.episodes.setKind.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.setKind(input)),
    ),
    setJournalSource: os.episodes.setJournalSource.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.setJournalSource(input)),
    ),
    keepAudio: os.episodes.keepAudio.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.keepAudio(input)),
    ),
    merge: os.episodes.merge.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.merge(input)),
    ),
    delete: os.episodes.delete.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.delete(input)),
    ),
    setRecognition: os.episodes.setRecognition.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.setRecognition(input)),
    ),
    deletePassage: os.episodes.deletePassage.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.deletePassage(input)),
    ),
    forgetPreview: os.episodes.forgetPreview.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.forgetPreview(input)),
    ),
    forget: os.episodes.forget.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.episodes.forget(input)),
    ),
    keepRecent: os.episodes.keepRecent.handler(({ context, errors }) =>
      guard(errors, () => context.services.episodes.keepRecent()),
    ),
  },
  people: {
    list: os.people.list.handler(({ context, errors }) =>
      guard(errors, () => context.services.people.list()),
    ),
    get: os.people.get.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.people.get(input)),
    ),
    rename: os.people.rename.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.people.rename(input)),
    ),
    merge: os.people.merge.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.people.merge(input)),
    ),
    delete: os.people.delete.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.people.delete(input)),
    ),
    unnamed: os.people.unnamed.handler(({ context, errors }) =>
      guard(errors, () => context.services.people.unnamed()),
    ),
    doubts: os.people.doubts.handler(({ context, errors }) =>
      guard(errors, () => context.services.people.doubts()),
    ),
    recognition: os.people.recognition.handler(({ context, errors }) =>
      guard(errors, () => context.services.people.recognition()),
    ),
    setRecognition: os.people.setRecognition.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.people.setRecognition(input)),
    ),
    dictationLearning: os.people.dictationLearning.handler(({ context, errors }) =>
      guard(errors, () => context.services.people.dictationLearning()),
    ),
    setDictationLearning: os.people.setDictationLearning.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.people.setDictationLearning(input)),
    ),
  },
  transcript: {
    edit: os.transcript.edit.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.transcript.edit(input)),
    ),
    restore: os.transcript.restore.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.transcript.restore(input)),
    ),
  },
  history: {
    undo: os.history.undo.handler(({ context, errors }) =>
      guard(errors, () => context.services.history.undo()),
    ),
    redo: os.history.redo.handler(({ context, errors }) =>
      guard(errors, () => context.services.history.redo()),
    ),
  },
  chat: {
    status: os.chat.status.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.chat.status(input)),
    ),
    setEnabled: os.chat.setEnabled.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.chat.setEnabled(input)),
    ),
    watch: os.chat.watch.handler(async function* ({ context, input, signal }) {
      for await (const view of context.services.chat.watch(input, signal)) yield view;
    }),
    send: os.chat.send.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.chat.send(input)),
    ),
    stop: os.chat.stop.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.chat.stop(input)),
    ),
    remove: os.chat.remove.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.chat.remove(input)),
    ),
    setLimited: os.chat.setLimited.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.chat.setLimited(input)),
    ),
  },
  agents: {
    status: os.agents.status.handler(({ context, errors }) =>
      guard(errors, () => context.services.agents.status()),
    ),
    setEnabled: os.agents.setEnabled.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.agents.setEnabled(input)),
    ),
    create: os.agents.create.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.agents.create(input)),
    ),
    connectApp: os.agents.connectApp.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.agents.connectApp(input)),
    ),
    revoke: os.agents.revoke.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.agents.revoke(input)),
    ),
    remove: os.agents.remove.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.agents.remove(input)),
    ),
  },
  speakers: {
    name: os.speakers.name.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.speakers.name(input)),
    ),
    unname: os.speakers.unname.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.speakers.unname(input)),
    ),
    refuse: os.speakers.refuse.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.speakers.refuse(input)),
    ),
    likeness: os.speakers.likeness.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.speakers.likeness(input)),
    ),
    merge: os.speakers.merge.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.speakers.merge(input)),
    ),
  },
  calls: {
    context: os.calls.context.handler(({ context, errors }) =>
      guard(errors, () => context.services.calls.context()),
    ),
    watch: os.calls.watch.handler(async function* ({ context, signal }) {
      for await (const call of context.services.calls.watch(signal)) yield call;
    }),
    dismiss: os.calls.dismiss.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.calls.dismiss(input)),
    ),
    notch: os.calls.notch.handler(({ context, errors }) =>
      guard(errors, () => context.services.calls.notch()),
    ),
    setNotch: os.calls.setNotch.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.calls.setNotch(input)),
    ),
  },
  search: {
    query: os.search.query.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.search.query(input)),
    ),
    foregroundApps: os.search.foregroundApps.handler(({ context, errors }) =>
      guard(errors, () => context.services.search.foregroundApps()),
    ),
  },
  analysis: {
    request: os.analysis.request.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.analysis.request(input)),
    ),
    check: os.analysis.check.handler(({ context, errors }) =>
      guard(errors, () => context.services.analysis.check()),
    ),
    setWaitFor: os.analysis.setWaitFor.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.analysis.setWaitFor(input)),
    ),
  },
  compute: {
    get: os.compute.get.handler(({ context, errors }) =>
      guard(errors, () => context.services.compute.get()),
    ),
    choose: os.compute.choose.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.compute.choose(input)),
    ),
    connect: os.compute.connect.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.compute.connect(input)),
    ),
    disconnect: os.compute.disconnect.handler(({ context, errors }) =>
      guard(errors, () => context.services.compute.disconnect()),
    ),
    joinBeta: os.compute.joinBeta.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.compute.joinBeta(input)),
    ),
    leaveBeta: os.compute.leaveBeta.handler(({ context, errors }) =>
      guard(errors, () => context.services.compute.leaveBeta()),
    ),
    quota: os.compute.quota.handler(({ context, errors }) =>
      guard(errors, () => context.services.compute.quota()),
    ),
    wave: os.compute.wave.handler(({ context, errors }) =>
      guard(errors, () => context.services.compute.wave()),
    ),
    openBilling: os.compute.openBilling.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.compute.openBilling(input)),
    ),
  },
  live: {
    setEnabled: os.live.setEnabled.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.live.setEnabled(input)),
    ),
    partial: os.live.partial.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.live.partial(input)),
    ),
  },
  imports: {
    pick: os.imports.pick.handler(({ context, errors }) =>
      guard(errors, () => context.services.imports.pick()),
    ),
    add: os.imports.add.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.imports.add(input)),
    ),
    list: os.imports.list.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.imports.list(input)),
    ),
  },
  context: {
    add: os.context.add.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.context.add(input)),
    ),
    paste: os.context.paste.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.context.paste(input)),
    ),
    pick: os.context.pick.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.context.pick(input)),
    ),
    edit: os.context.edit.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.context.edit(input)),
    ),
    unpin: os.context.unpin.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.context.unpin(input)),
    ),
    remove: os.context.remove.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.context.remove(input)),
    ),
    open: os.context.open.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.context.open(input)),
    ),
    transcribe: os.context.transcribe.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.context.transcribe(input)),
    ),
    pasteOngoing: os.context.pasteOngoing.handler(({ context, errors }) =>
      guard(errors, () => context.services.context.pasteOngoing()),
    ),
    get: os.context.get.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.context.get(input)),
    ),
  },
  journal: {
    day: os.journal.day.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.journal.day(input)),
    ),
    commitments: os.journal.commitments.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.journal.commitments(input)),
    ),
    mark: os.journal.mark.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.journal.mark(input)),
    ),
    request: os.journal.request.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.journal.request(input)),
    ),
    claude: os.journal.claude.handler(({ context, errors }) =>
      guard(errors, () => context.services.journal.claude()),
    ),
    settings: os.journal.settings.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.journal.settings(input)),
    ),
  },
  player: {
    state: os.player.state.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.player.state(input)),
    ),
  },
  phone: {
    status: os.phone.status.handler(({ context, errors }) =>
      guard(errors, () => context.services.phone.status()),
    ),
    setEnabled: os.phone.setEnabled.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.phone.setEnabled(input)),
    ),
    setTailnet: os.phone.setTailnet.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.phone.setTailnet(input)),
    ),
    pair: os.phone.pair.handler(({ context, errors }) =>
      guard(errors, () => context.services.phone.pair()),
    ),
    answer: os.phone.answer.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.phone.answer(input)),
    ),
    revoke: os.phone.revoke.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.phone.revoke(input)),
    ),
    reset: os.phone.reset.handler(({ context, errors }) =>
      guard(errors, () => context.services.phone.reset()),
    ),
  },
  browser: {
    status: os.browser.status.handler(({ context, errors }) =>
      guard(errors, () => context.services.browser.status()),
    ),
    setEnabled: os.browser.setEnabled.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.browser.setEnabled(input)),
    ),
    showExtension: os.browser.showExtension.handler(({ context, errors }) =>
      guard(errors, () => context.services.browser.showExtension()),
    ),
  },
  privacy: {
    status: os.privacy.status.handler(({ context, errors }) =>
      guard(errors, () => context.services.privacy.status()),
    ),
    addZone: os.privacy.addZone.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.privacy.addZone(input)),
    ),
    updateZone: os.privacy.updateZone.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.privacy.updateZone(input)),
    ),
    removeZone: os.privacy.removeZone.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.privacy.removeZone(input)),
    ),
    setMediaSite: os.privacy.setMediaSite.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.privacy.setMediaSite(input)),
    ),
    setDuration: os.privacy.setDuration.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.privacy.setDuration(input)),
    ),
    lift: os.privacy.lift.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.privacy.lift(input)),
    ),
  },
  dictation: {
    apps: os.dictation.apps.handler(({ context, errors }) =>
      guard(errors, () => context.services.dictation.apps()),
    ),
    setApp: os.dictation.setApp.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.dictation.setApp(input)),
    ),
    setText: os.dictation.setText.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.dictation.setText(input)),
    ),
  },
  updates: {
    setAutomatic: os.updates.setAutomatic.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.updates.setAutomatic(input)),
    ),
    check: os.updates.check.handler(({ context, errors }) =>
      guard(errors, () => context.services.updates.check()),
    ),
    install: os.updates.install.handler(({ context, errors }) =>
      guard(errors, () => context.services.updates.install()),
    ),
    closeNote: os.updates.closeNote.handler(({ context, errors }) =>
      guard(errors, () => context.services.updates.closeNote()),
    ),
  },
  models: {
    status: os.models.status.handler(({ context, errors }) =>
      guard(errors, () => context.services.models.status()),
    ),
    watch: os.models.watch.handler(async function* ({ context, signal }) {
      for await (const models of context.services.models.watch(signal)) yield models;
    }),
    import: os.models.import.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.models.import(input)),
    ),
    pick: os.models.pick.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.models.pick(input)),
    ),
    download: os.models.download.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.models.download(input)),
    ),
    cancel: os.models.cancel.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.models.cancel(input)),
    ),
  },
  voiceRead: {
    get: os.voiceRead.get.handler(({ context, errors }) =>
      guard(errors, () => context.services.voiceRead.get()),
    ),
    watch: os.voiceRead.watch.handler(async function* ({ context, signal }) {
      for await (const status of context.services.voiceRead.watch(signal)) yield status;
    }),
    start: os.voiceRead.start.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.voiceRead.start(input)),
    ),
    finish: os.voiceRead.finish.handler(({ context, errors }) =>
      guard(errors, () => context.services.voiceRead.finish()),
    ),
    cancel: os.voiceRead.cancel.handler(({ context, errors }) =>
      guard(errors, () => context.services.voiceRead.cancel()),
    ),
    forget: os.voiceRead.forget.handler(({ context, errors }) =>
      guard(errors, () => context.services.voiceRead.forget()),
    ),
  },
  onboarding: {
    get: os.onboarding.get.handler(({ context, errors }) =>
      guard(errors, () => context.services.onboarding.get()),
    ),
    advance: os.onboarding.advance.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.onboarding.advance(input)),
    ),
    complete: os.onboarding.complete.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.onboarding.complete(input)),
    ),
  },
  display: {
    get: os.display.get.handler(({ context, errors }) =>
      guard(errors, () => context.services.display.get()),
    ),
    update: os.display.update.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.display.update(input)),
    ),
  },
  vocabulary: {
    list: os.vocabulary.list.handler(({ context, errors }) =>
      guard(errors, () => context.services.vocabulary.list()),
    ),
    add: os.vocabulary.add.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.vocabulary.add(input)),
    ),
    update: os.vocabulary.update.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.vocabulary.update(input)),
    ),
    remove: os.vocabulary.remove.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.vocabulary.remove(input)),
    ),
  },
  tags: {
    list: os.tags.list.handler(({ context, errors }) =>
      guard(errors, () => context.services.tags.list()),
    ),
    set: os.tags.set.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.tags.set(input)),
    ),
    rename: os.tags.rename.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.tags.rename(input)),
    ),
    delete: os.tags.delete.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.tags.delete(input)),
    ),
  },
  statistics: {
    get: os.statistics.get.handler(({ context, errors }) =>
      guard(errors, () => context.services.statistics.get()),
    ),
    month: os.statistics.month.handler(({ context, errors, input }) =>
      guard(errors, () => context.services.statistics.month(input)),
    ),
  },
  usage: {
    get: os.usage.get.handler(({ context, errors }) =>
      guard(errors, () => context.services.usage.get()),
    ),
    setSharing: os.usage.setSharing.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.usage.setSharing(input)),
    ),
    // The middleware counts them; there is nothing else to do.
    windowOpened: os.usage.windowOpened.handler(() => ({})),
    conversationOpened: os.usage.conversationOpened.handler(() => ({})),
    processCrashed: os.usage.processCrashed.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.usage.processCrashed(input)),
    ),
  },
  diagnostics: {
    report: os.diagnostics.report.handler(({ context, errors }) =>
      guard(errors, () => context.services.diagnostics.report()),
    ),
    health: os.diagnostics.health.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.diagnostics.health(input)),
    ),
    spans: os.diagnostics.spans.handler(({ context, input, errors }) =>
      guard(errors, () => context.services.diagnostics.spans(input)),
    ),
  },
});

export type AppRouter = typeof router;
/** The client every transport hands out (renderer, tray, MCP bridge). */
export type AppClient = RouterClient<AppRouter>;
