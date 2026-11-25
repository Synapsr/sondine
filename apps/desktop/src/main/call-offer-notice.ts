import type { CallOffer } from "@sondine/api";
import { m } from "../renderer/paraglide/messages.js";
import type { IslandCard, IslandCardAction } from "../shared/call-island";
import type { TrayLocale } from "./tray-state";

// What the island says, as macOS notifications where no island shows it
// (ADR 036): a call that starts, a call that ended, a pause forgotten.
// Electron's Notification uses the User Notifications framework since
// Electron 42, which needs a signed app and the user's authorization:
// otherwise it emits `failed`, and the menu bar item offers the same thing.
// `shown` is logged only once macOS has taken the notification (Electron's
// `show` event), never on the mere request. Each is shown once: a call once
// whatever becomes of its offer, removed when the offer goes (the call ended,
// the user answered, the intent changed); a card once, removed when it goes.
//
// A call during a pause (`listen`): « Écouter cet appel », « Reprendre
// l'écoute », « Pas pour <app> ». While Sondine listens (`skip`): « Ne pas
// écouter cet appel », « Pas pour <app> ». macOS shows the buttons under
// « Options » on a banner. A click on the notification itself does nothing
// more than macOS does.

export type CallOfferAnswer = "listen" | "resume" | "skip" | "mute";

/** The buttons of each kind, in order: their index is the answer. */
const ANSWERS: Readonly<Record<CallOffer["kind"], readonly CallOfferAnswer[]>> = {
  listen: ["listen", "resume", "mute"],
  skip: ["skip", "mute"],
};

export interface NotificationOptions {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly actions: readonly { readonly type: "button"; readonly text: string }[];
}

/** What this module uses of Electron's Notification. */
export interface NoticeHandle {
  onAction(listener: (actionIndex: number) => void): void;
  /** macOS took the notification. */
  onShow(listener: () => void): void;
  onFailed(listener: (error: string) => void): void;
  show(): void;
  close(): void;
}

export interface CallOfferNoticeOptions {
  readonly locale: TrayLocale;
  readonly answer: (callId: string, answer: CallOfferAnswer) => void;
  readonly card: (action: IslandCardAction) => void;
  readonly create: (options: NotificationOptions) => NoticeHandle;
  /** Electron says notifications can be shown here. */
  readonly supported: () => boolean;
  /** Categories only: never an app's name. */
  readonly log: (event: string, fields?: Record<string, string | number | boolean>) => void;
}

export interface CallOfferNotice {
  /** What to say now without the island; null withdraws the one shown. */
  update(offer: CallOffer | null, card: IslandCard | null): void;
}

/** Every notification of this module: main removes those left by an earlier run. */
export const NOTICE_ID_PREFIX = "call-offer-";

/** The id of an offer's notification. */
export const noticeId = (offer: Pick<CallOffer, "callId" | "kind">) =>
  `${NOTICE_ID_PREFIX}${offer.kind}-${offer.callId}`;

const cardId = (card: IslandCard) => `${NOTICE_ID_PREFIX}card-${card.key}`;

interface Notice {
  readonly kind: string;
  /** Said once, whatever its buttons become. */
  readonly subject: string;
  readonly options: NotificationOptions;
  readonly answer: (index: number) => string | null;
}

export function createCallOfferNotice(options: CallOfferNoticeOptions): CallOfferNotice {
  const { locale, log } = options;
  let shown: { readonly id: string; readonly handle: NoticeHandle } | null = null;
  /** What was already said: once each, even if it comes back. */
  const notified = new Set<string>();

  const withdraw = () => {
    shown?.handle.close();
    shown = null;
  };

  const offerNotice = (offer: CallOffer): Notice => {
    const app = offer.name;
    const text = { locale };
    const mute = { type: "button" as const, text: m.call_offer_mute({ app }, text) };
    return {
      kind: offer.kind,
      subject: offer.callId,
      options:
        offer.kind === "listen"
          ? {
              id: noticeId(offer),
              title: m.call_offer_title({ app }, text),
              body: m.call_offer_body({}, text),
              actions: [
                { type: "button", text: m.call_offer_listen({}, text) },
                { type: "button", text: m.tray_resume({}, text) },
                mute,
              ],
            }
          : {
              id: noticeId(offer),
              title: m.call_notice_title({}, text),
              body: m.call_notice_body({ app }, text),
              actions: [{ type: "button", text: m.call_notice_skip({}, text) }, mute],
            },
      answer: (index) => {
        const answer = ANSWERS[offer.kind][index];
        if (answer === undefined) return null;
        options.answer(offer.callId, answer);
        return answer;
      },
    };
  };

  const cardNotice = (card: IslandCard): Notice => ({
    kind: "card",
    subject: card.key,
    options: {
      id: cardId(card),
      title: card.title,
      body: card.detail,
      actions: card.actions.map(({ label }) => ({ type: "button", text: label })),
    },
    answer: (index) => {
      const action = card.actions[index];
      if (action === undefined) return null;
      options.card(action);
      return action.action;
    },
  });

  return {
    update(offer, card) {
      const notice = offer !== null ? offerNotice(offer) : card !== null ? cardNotice(card) : null;
      if (notice?.options.id !== shown?.id) withdraw();
      if (notice === null || notified.has(notice.subject)) return;
      notified.add(notice.subject);
      const { kind } = notice;
      const { id } = notice.options;
      if (!options.supported()) {
        log("call-offer.notice", { kind, shown: false, reason: "unsupported" });
        return;
      }
      const handle = options.create(notice.options);
      handle.onAction((index) => {
        const answer = notice.answer(index);
        if (answer === null) return;
        log("call-offer.answer", { kind, answer });
        if (shown?.id === id) shown = null;
      });
      handle.onShow(() => log("call-offer.notice", { kind, shown: true }));
      handle.onFailed((error) => {
        // Unsigned, or notifications refused: the menu bar still offers it.
        log("call-offer.notice", { kind, shown: false, reason: error.slice(0, 120) });
        if (shown?.id === id) shown = null;
      });
      shown = { id, handle };
      handle.show();
    },
  };
}
