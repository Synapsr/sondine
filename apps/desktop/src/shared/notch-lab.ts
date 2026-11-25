import * as z from "zod";

// Development only: the notch lab (`/notch-lab`) plays the island's flows on
// the real notch helper, from a call that does not exist. Core is left out:
// `labReduce` answers the clicks as core would (an answer is taken back, the
// intent before comes back with the call's end). Environment-free, so it is
// tested in Node.

export const LabApp = z.enum(["discord", "zoom", "facetime", "long"]);
export type LabApp = z.output<typeof LabApp>;

/** What the capture does, as the menu bar names it (`TrayState`). */
export const LabCapture = z.enum([
  "listening",
  "paused",
  "pause-unconfirmed",
  "partial",
  "connecting",
]);
export type LabCapture = z.output<typeof LabCapture>;

export const LabSettings = z.strictObject({
  app: LabApp,
  capture: LabCapture,
  /** How many people the call may be with. */
  people: z.int().min(0).max(4),
  /** Speech joined the call's recording. */
  recording: z.boolean(),
  openOnHover: z.boolean(),
  locale: z.enum(["fr", "en"]),
  /** How many times slower the island moves; needs the helper's debug build. */
  slow: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
});
export type LabSettings = z.output<typeof LabSettings>;
const LabPatch = LabSettings.partial();

export const LAB_SCENARIOS = {
  /** A call starts while Sondine listens. */
  listening: [
    [0, { type: "set", settings: { capture: "listening", people: 0, recording: false } }],
    [0, { type: "start" }],
    [4_000, { type: "set", settings: { recording: true } }],
  ],
  /** A call starts during a pause. */
  paused: [
    [0, { type: "set", settings: { capture: "paused", people: 0, recording: false } }],
    [0, { type: "start" }],
  ],
  /** From the call's start to its end card. */
  full: [
    [0, { type: "set", settings: { capture: "listening", people: 0, recording: false } }],
    [0, { type: "start" }],
    [4_000, { type: "set", settings: { recording: true } }],
    [11_000, { type: "set", settings: { people: 1 } }],
    [20_000, { type: "hang-up" }],
  ],
  /** Listened to during a pause: the pause comes back with the end card. */
  restored: [
    [0, { type: "set", settings: { capture: "paused", people: 0, recording: false } }],
    [0, { type: "start" }],
    [3_000, { type: "toggle", on: true }],
    [6_000, { type: "set", settings: { recording: true } }],
    [14_000, { type: "hang-up" }],
  ],
  /** What changes as the island moves: it must never jump. */
  interrupted: [
    [0, { type: "set", settings: { capture: "listening", people: 0, recording: false } }],
    [0, { type: "start" }],
    [150, { type: "toggle", on: false }],
    [350, { type: "set", settings: { people: 1 } }],
    [500, { type: "toggle", on: true }],
    [700, { type: "set", settings: { recording: true } }],
    [900, { type: "set", settings: { people: 3 } }],
    [1_200, { type: "hang-up" }],
    [1_500, { type: "start" }],
  ],
} as const satisfies Record<string, readonly (readonly [number, LabStep])[]>;
export type LabScenario = keyof typeof LAB_SCENARIOS;

export type LabStep =
  | { readonly type: "set"; readonly settings: z.output<typeof LabPatch> }
  | { readonly type: "start" }
  | { readonly type: "hang-up" }
  | { readonly type: "remind" }
  | { readonly type: "hide" }
  /** The call's switch, as a click on it. */
  | { readonly type: "toggle"; readonly on: boolean }
  | { readonly type: "end-episode" }
  | { readonly type: "mute" }
  | { readonly type: "dismiss" }
  | { readonly type: "resume" }
  | { readonly type: "card-done" };

export const LabCommand = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set"), settings: LabPatch }),
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({ type: z.literal("hang-up") }),
  z.strictObject({ type: z.literal("remind") }),
  z.strictObject({ type: z.literal("hide") }),
  z.strictObject({
    type: z.literal("scenario"),
    name: z.enum(["listening", "paused", "full", "restored", "interrupted"]),
  }),
]);
export type LabCommand = z.output<typeof LabCommand>;

export interface LabState {
  readonly settings: LabSettings;
  /** The call going on; its number makes its id. */
  readonly call: number | null;
  /** Answered: the capture that comes back, and which answer. */
  readonly answer: { readonly kind: "listen" | "skip"; readonly before: LabCapture } | null;
  /** Not answered yet: the island says it. */
  readonly offered: boolean;
  readonly card: {
    readonly kind: "ended" | "paused";
    readonly atMs: number;
    readonly recorded: boolean;
    readonly open: boolean;
    readonly restored: "listening" | "paused" | null;
  } | null;
  readonly calls: number;
}

/** What the page shows. */
export interface LabView {
  readonly state: LabState;
  /** `slow` needs the helper's debug build. */
  readonly canSlow: boolean;
  /** No helper built, or no notch. */
  readonly problem: "no-helper" | "no-notch" | null;
  /** What the helper said and what was played, the latest first. */
  readonly log: readonly { readonly atMs: number; readonly line: string }[];
}

export const LAB_START: LabState = {
  settings: {
    app: "discord",
    capture: "listening",
    people: 0,
    recording: true,
    openOnHover: true,
    locale: "fr",
    slow: 1,
  },
  call: null,
  answer: null,
  offered: false,
  card: null,
  calls: 0,
};

const capture = (state: LabState, value: LabCapture): LabState => ({
  ...state,
  settings: { ...state.settings, capture: value },
});

export function labReduce(state: LabState, step: LabStep, nowMs: number): LabState {
  switch (step.type) {
    case "set": {
      const patch = Object.entries(step.settings).filter(([, value]) => value !== undefined);
      const settings = LabSettings.parse({ ...state.settings, ...Object.fromEntries(patch) });
      // The user's own pause or resume drops the answer, as in core.
      const answer = step.settings.capture === undefined ? state.answer : null;
      return { ...state, settings, answer };
    }
    case "start":
      return {
        ...state,
        call: state.calls + 1,
        calls: state.calls + 1,
        offered: true,
        answer: null,
        card: null,
      };
    case "hang-up": {
      if (state.call === null) return state;
      const { answer } = state;
      const recorded = state.settings.recording;
      const restored = answer === null ? null : answer.before === "paused" ? "paused" : "listening";
      const after = answer === null ? state : capture(state, answer.before);
      return {
        ...after,
        call: null,
        answer: null,
        offered: false,
        card:
          recorded || restored !== null
            ? { kind: "ended", atMs: nowMs, recorded, open: recorded, restored }
            : null,
      };
    }
    case "remind":
      return {
        ...capture(state, "paused"),
        call: null,
        answer: null,
        offered: false,
        card: { kind: "paused", atMs: nowMs, recorded: false, open: false, restored: null },
      };
    case "hide":
      return { ...state, call: null, answer: null, offered: false, card: null };
    case "toggle": {
      if (state.call === null) return state;
      const kind = step.on ? "listen" : "skip";
      const { answer } = state;
      if (answer !== null && answer.kind !== kind) {
        // Taken back.
        return { ...capture(state, answer.before), answer: null };
      }
      return {
        ...capture(state, step.on ? "listening" : "paused"),
        answer: { kind, before: state.settings.capture },
        offered: false,
      };
    }
    case "end-episode":
      return {
        ...state,
        settings: { ...state.settings, recording: false },
        card: state.card === null ? null : { ...state.card, open: false },
      };
    case "mute":
      return { ...state, call: null, answer: null, offered: false };
    case "dismiss":
      return { ...state, settings: { ...state.settings, people: 0 } };
    case "resume":
      return { ...capture(state, "listening"), answer: null };
    case "card-done":
      return { ...state, card: null };
  }
}
