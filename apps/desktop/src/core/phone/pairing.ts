import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  PAIRING_ANSWER_MS,
  PAIRING_TOKEN_MS,
  type PairAnswer,
  type PhoneErrorCode,
} from "@sondine/protocol";
import { pairingDigits } from "./pairing-digits";

// One pairing at a time (ADR 008). « Appairer un iPhone… » opens it with a
// one-time token (32 random bytes, 5 minutes); the first presentation
// consumes it, whatever follows, so a second phone scanning the same QR is
// refused. The phone's request is then held on its connection until the
// user answers on the Mac, for 2 minutes at most; closing that connection
// ends the pairing too.

/** Timers the pairing uses; tests drive them by hand. */
export interface PairingClock {
  now(): number;
  /** Runs `fn` after `ms`; the function returned cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export const systemClock: PairingClock = {
  now: () => Date.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** What Settings ▸ Téléphone shows of the pairing under way. */
export type PairingView =
  | { readonly phase: "waiting"; readonly token: string; readonly expiresAtMs: number }
  | {
      readonly phase: "asked";
      readonly token: string;
      readonly expiresAtMs: number;
      readonly deviceName: string;
      readonly digits: string;
    };

export type PairingOutcome =
  | { readonly kind: "paired"; readonly answer: PairAnswer }
  | { readonly kind: "refused"; readonly error: PhoneErrorCode };

export interface PairingRequest {
  readonly token: string;
  readonly deviceId: string;
  readonly deviceName: string;
}

interface Open {
  readonly token: string;
  readonly tokenHash: Buffer;
  readonly expiresAtMs: number;
  cancelExpiry: () => void;
  asked: {
    readonly request: PairingRequest;
    readonly digits: string;
    readonly answerByMs: number;
    readonly connection: object;
    readonly settle: (outcome: PairingOutcome) => void;
    readonly cancelTimeout: () => void;
  } | null;
}

const hashOf = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** Tokens presented once are remembered this long, to answer `pairing-used` rather than `pairing-closed`. */
const USED_KEPT = 16;

export interface PairingDesk {
  /** Opens a pairing (closing any other) and returns its token. `pin` is the Mac's key pin now. */
  open(pin: string): string;
  /** The phone presents a token on `connection`: the outcome once the user answered, or a refusal. */
  present(request: PairingRequest, connection: object): Promise<PairingOutcome>;
  /** The user's « Appairer » (true) or « Annuler » (false); false when nothing waits for it. */
  answer(accept: boolean): boolean;
  /** Closes the pairing under way, if any (« Annuler » before a phone asked, a reset). */
  cancel(): void;
  /** The connection a phone asked on closed. */
  connectionClosed(connection: object): void;
  view(): PairingView | null;
}

export function makePairingDesk(options: {
  readonly clock: PairingClock;
  /** Makes the credential and stores the phone's row: run on « Appairer ». */
  readonly complete: (request: PairingRequest) => PairAnswer;
  /** The pairing opened, was asked, or closed: the relay may start or stop. */
  readonly changed: () => void;
}): PairingDesk {
  const { clock } = options;
  let open: Open | null = null;
  let pin = "";
  const used: Buffer[] = [];

  const close = (outcome: PairingOutcome) => {
    const current = open;
    if (current === null) return;
    open = null;
    current.cancelExpiry();
    if (current.asked !== null) {
      current.asked.cancelTimeout();
      current.asked.settle(outcome);
    }
    options.changed();
  };

  const remember = (hash: Buffer) => {
    used.push(hash);
    if (used.length > USED_KEPT) used.shift();
  };

  return {
    open(currentPin) {
      close({ kind: "refused", error: "pairing-closed" });
      pin = currentPin;
      const token = randomBytes(32).toString("base64url");
      const opened: Open = {
        token,
        tokenHash: hashOf(token),
        expiresAtMs: clock.now() + PAIRING_TOKEN_MS,
        cancelExpiry: () => undefined,
        asked: null,
      };
      // Until presented, the token lives 5 minutes; then the answer has 2.
      opened.cancelExpiry = clock.after(PAIRING_TOKEN_MS, () => {
        if (open === opened && opened.asked === null) {
          close({ kind: "refused", error: "pairing-closed" });
        }
      });
      open = opened;
      options.changed();
      return token;
    },

    present(request, connection) {
      const hash = hashOf(request.token);
      const current = open;
      if (used.some((seen) => timingSafeEqual(seen, hash))) {
        return Promise.resolve({ kind: "refused", error: "pairing-used" });
      }
      if (
        current === null ||
        !timingSafeEqual(current.tokenHash, hash) ||
        clock.now() >= current.expiresAtMs
      ) {
        return Promise.resolve({ kind: "refused", error: "pairing-closed" });
      }
      // Consumed now, whatever follows.
      remember(hash);
      if (current.asked !== null) {
        return Promise.resolve({ kind: "refused", error: "pairing-used" });
      }
      return new Promise<PairingOutcome>((settle) => {
        current.cancelExpiry();
        const cancelTimeout = clock.after(PAIRING_ANSWER_MS, () => {
          if (open === current) close({ kind: "refused", error: "pairing-closed" });
        });
        current.asked = {
          request,
          digits: pairingDigits(request.token, request.deviceId, pin),
          answerByMs: clock.now() + PAIRING_ANSWER_MS,
          connection,
          settle,
          cancelTimeout,
        };
        options.changed();
      });
    },

    answer(accept) {
      const current = open;
      if (current === null) return false;
      if (!accept) {
        close({ kind: "refused", error: "pairing-refused" });
        return true;
      }
      if (current.asked === null) return false;
      let outcome: PairingOutcome;
      try {
        outcome = { kind: "paired", answer: options.complete(current.asked.request) };
      } catch (error) {
        close({ kind: "refused", error: "pairing-closed" });
        throw error;
      }
      close(outcome);
      return true;
    },

    cancel() {
      close({ kind: "refused", error: "pairing-closed" });
    },

    connectionClosed(connection) {
      if (open?.asked?.connection === connection) {
        close({ kind: "refused", error: "pairing-closed" });
      }
    },

    view() {
      if (open === null) return null;
      const { token, expiresAtMs, asked } = open;
      // Before a phone asks, the token's 5 minutes; after, the answer's 2.
      return asked === null
        ? { phase: "waiting", token, expiresAtMs }
        : {
            phase: "asked",
            token,
            expiresAtMs: asked.answerByMs,
            deviceName: asked.request.deviceName,
            digits: asked.digits,
          };
    },
  };
}
