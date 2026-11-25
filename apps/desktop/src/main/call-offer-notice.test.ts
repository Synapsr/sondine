import type { CallOffer } from "@sondine/api";
import { describe, expect, it } from "vitest";
import type { IslandCard, IslandCardAction } from "../shared/call-island";
import {
  createCallOfferNotice,
  type CallOfferAnswer,
  type NoticeHandle,
  type NotificationOptions,
} from "./call-offer-notice";

const offer = (
  callId: string,
  name = "Discord",
  kind: CallOffer["kind"] = "listen",
): CallOffer => ({
  kind,
  callId,
  bundleId: "com.hnc.Discord",
  name,
  sinceMs: 1_793_610_000_000,
});

interface Handlers {
  action?: (index: number) => void;
  show?: () => void;
  failed?: (error: string) => void;
}

function harness(supported = true) {
  const created: { options: NotificationOptions; closed: boolean; shown: boolean }[] = [];
  const handlers: Handlers[] = [];
  const answers: [string, CallOfferAnswer][] = [];
  const cardActions: IslandCardAction[] = [];
  const logs: [string, Record<string, string | number | boolean> | undefined][] = [];
  const notice = createCallOfferNotice({
    locale: "fr",
    supported: () => supported,
    answer: (callId, answer) => answers.push([callId, answer]),
    card: (action) => cardActions.push(action),
    create: (options): NoticeHandle => {
      const entry = { options, closed: false, shown: false };
      const handler: Handlers = {};
      created.push(entry);
      handlers.push(handler);
      return {
        onAction: (listener) => {
          handler.action = listener;
        },
        onShow: (listener) => {
          handler.show = listener;
        },
        onFailed: (listener) => {
          handler.failed = listener;
        },
        show: () => {
          entry.shown = true;
        },
        close: () => {
          entry.closed = true;
        },
      };
    },
    log: (event, fields) => logs.push([event, fields]),
  });
  return { notice, created, handlers, answers, cardActions, logs };
}

describe("call offer notice", () => {
  it("shows one notification per call with three buttons, and withdraws it with the offer", () => {
    const { notice, created } = harness();
    notice.update(offer("a"), null);
    notice.update(offer("a"), null);
    expect(created).toHaveLength(1);
    expect(created[0]?.shown).toBe(true);
    expect(created[0]?.options).toMatchObject({
      id: "call-offer-listen-a",
      title: "Appel Discord en cours",
      actions: [
        { type: "button", text: "Écouter cet appel" },
        { type: "button", text: "Reprendre l’écoute" },
        { type: "button", text: "Pas pour Discord" },
      ],
    });
    notice.update(null, null);
    expect(created[0]?.closed).toBe(true);
    // The same call offered again is not notified twice.
    notice.update(offer("a"), null);
    expect(created).toHaveLength(1);
  });

  it("says a call Sondine listens to, with « Ne pas écouter cet appel »", () => {
    const { notice, created, handlers, answers } = harness();
    notice.update(offer("a", "Discord", "skip"), null);
    expect(created[0]?.options).toEqual({
      id: "call-offer-skip-a",
      title: "Sondine écoute cet appel",
      body: "Appel Discord",
      actions: [
        { type: "button", text: "Ne pas écouter cet appel" },
        { type: "button", text: "Pas pour Discord" },
      ],
    });
    // Withdrawn when the call ends.
    notice.update(null, null);
    expect(created[0]?.closed).toBe(true);

    notice.update(offer("b", "Discord", "skip"), null);
    handlers[1]?.action?.(0);
    handlers[1]?.action?.(1);
    handlers[1]?.action?.(2);
    expect(answers).toEqual([
      ["b", "skip"],
      ["b", "mute"],
    ]);
  });

  it("answers with the button's meaning and replaces an older call's notification", () => {
    const { notice, created, handlers, answers } = harness();
    notice.update(offer("a"), null);
    handlers[0]?.action?.(2);
    handlers[0]?.action?.(7);
    expect(answers).toEqual([["a", "mute"]]);
    notice.update(offer("b", "Zoom"), null);
    expect(created).toHaveLength(2);
    expect(created[1]?.options.title).toBe("Appel Zoom en cours");
    handlers[1]?.action?.(0);
    expect(answers.at(-1)).toEqual(["b", "listen"]);
  });

  it("logs shown only once macOS took it, and survives a failure", () => {
    const unsupported = harness(false);
    unsupported.notice.update(offer("a"), null);
    expect(unsupported.created).toHaveLength(0);

    const { notice, handlers, logs } = harness();
    notice.update(offer("a", "Discord", "skip"), null);
    expect(logs).toEqual([]);
    handlers[0]?.show?.();
    expect(logs).toEqual([["call-offer.notice", { kind: "skip", shown: true }]]);

    const failing = harness();
    failing.notice.update(offer("a"), null);
    failing.handlers[0]?.failed?.("Notifications are not allowed for this application");
    expect(failing.logs.at(-1)).toEqual([
      "call-offer.notice",
      {
        kind: "listen",
        shown: false,
        reason: "Notifications are not allowed for this application",
      },
    ]);
    failing.notice.update(null, null);
    expect(failing.created[0]?.closed).toBe(false);
  });

  it("says a call once, even when its buttons change", () => {
    const { notice, created } = harness();
    notice.update(offer("a"), null);
    // The user resumed from the window: the old offer goes, nothing new is said.
    notice.update(offer("a", "Discord", "skip"), null);
    expect(created).toHaveLength(1);
    expect(created[0]?.closed).toBe(true);
  });

  it("says a card once, with its buttons, after the call's offer", () => {
    const { notice, created, handlers, cardActions } = harness();
    const card: IslandCard = {
      key: "ended:1",
      bundleId: "com.hnc.Discord",
      title: "Appel Discord terminé",
      detail: "32 min enregistrées",
      monogram: "D",
      actions: [
        { action: "open-episode", label: "Ouvrir", episodeId: 31 },
        { action: "end-episode", label: "Terminer", episodeId: 31 },
      ],
    };
    notice.update(offer("a"), card);
    notice.update(null, card);
    notice.update(null, card);
    expect(created.map((entry) => entry.options.id)).toEqual([
      "call-offer-listen-a",
      "call-offer-card-ended:1",
    ]);
    handlers[1]?.action?.(1);
    handlers[1]?.action?.(2);
    expect(cardActions).toEqual([card.actions[1]]);
    notice.update(null, null);
    expect(created).toHaveLength(2);
  });
});
