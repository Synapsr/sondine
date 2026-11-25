import * as z from "zod";
import { named } from "./registry";

// The island beside the notch (ADR 025, ADR 036): main starts `sondine-notch`
// while a call goes on, or for a card (a call that ended, a forgotten pause),
// and tells it what to show: the call with its switch, whom it may be with,
// or the card. The helper says what the user clicked, and when a card has had
// its time. Every word comes from main, translated, and the app's icon too;
// the helper has no strings of its own and reads no file.
//
//   main → helper   NotchCommand, one per line; closing stdin hides the notch
//                   and the helper exits
//   helper → main   NotchEvent, one per line
//
// Each `show` carries a view number; a click names the view it was made on,
// so main ignores a click on a view it has since replaced.

/** Longest label: a name with « ? », a day and time, a menu item. */
export const NOTCH_LABEL_MAX = 200;
/**
 * Longest first words of a conversation (main clips them, as in the menu).
 * Lengths on this wire are in code points, as zod counts them.
 */
export const NOTCH_WORDS_MAX = 44;
/** Most people a call suggests, and conversations shown for each. */
export const NOTCH_PEOPLE_MAX = 4;
export const NOTCH_CONVERSATIONS_MAX = 3;
/** Longest initial: one character a person reads, which an emoji may spell in several. */
export const NOTCH_MONOGRAM_MAX = 16;
/** Longest icon: a small PNG, in base64. */
export const NOTCH_ICON_MAX = 24 * 1024;
/** Most buttons a card has. */
export const NOTCH_CARD_ACTIONS_MAX = 2;
/** Longest line either way, newline excluded. */
export const NOTCH_LINE_MAX = 64 * 1024;

const RowId = named(
  "RowId",
  "A row id in Sondine's database.",
  z.int().min(1).max(Number.MAX_SAFE_INTEGER),
);

const ViewNumber = named(
  "ViewNumber",
  "Which `show` a click was made on; main counts them from 1.",
  z.int().min(1).max(Number.MAX_SAFE_INTEGER),
);

const Label = named(
  "NotchLabel",
  "Text main translated, shown as is.",
  z.string().min(1).max(NOTCH_LABEL_MAX),
);

const NotchConversation = named(
  "NotchConversation",
  "One earlier conversation with the person.",
  z.strictObject({
    episodeId: RowId,
    /** « Hier 18:30 ». */
    when: Label,
    /** Its first words, clipped; null when it has none. */
    words: z.string().min(1).max(NOTCH_WORDS_MAX).nullable(),
  }),
);

const NotchPerson = named(
  "NotchPerson",
  "A person the call may be with.",
  z.strictObject({
    personId: RowId,
    /** « Marie ? »: always a guess. */
    label: Label,
    /** Her initial, beside the notch. */
    monogram: z.string().min(1).max(NOTCH_MONOGRAM_MAX),
    conversations: z.array(NotchConversation).max(NOTCH_CONVERSATIONS_MAX),
    /** « Aucune conversation avant » when there is none, else null. */
    none: Label.nullable(),
  }),
);

const CallKey = named(
  "CallKey",
  "The call or the card shown; the same one keeps its key.",
  z.string().min(1).max(64),
);

/** The app's icon, a PNG in base64; null shows its initial. */
const Icon = z.base64().min(1).max(NOTCH_ICON_MAX).nullable();
const Monogram = z.string().min(1).max(NOTCH_MONOGRAM_MAX);

const NotchCall = named(
  "NotchCall",
  "The call going on, with its switch.",
  z.strictObject({
    callId: CallKey,
    /** « Appel Discord ». */
    title: Label,
    /** « Sondine écoute », « En pause ». */
    detail: Label,
    icon: Icon,
    monogram: Monogram,
    /** Sondine may be recording it. */
    on: z.boolean(),
    /** What the switch is, for VoiceOver: « Écouter cet appel ». */
    toggle: Label,
    /** It has just started: the island says it, with the switch. */
    announce: z.boolean(),
    /** The recording going on, and what may be done with it. */
    episode: z.strictObject({ episodeId: RowId, open: Label, end: Label }).nullable(),
    /** « Ne plus prévenir pour Discord ». */
    mute: Label,
  }),
);

const NotchCardAction = named(
  "NotchCardAction",
  "A button of a card.",
  z.strictObject({
    action: z.enum(["open-episode", "end-episode", "resume"]),
    label: Label,
    /** The recording it is for; null for `resume`. */
    episodeId: RowId.nullable(),
  }),
);

const NotchCard = named(
  "NotchCard",
  "Something said once: a call that ended, a forgotten pause.",
  z.strictObject({
    key: CallKey,
    title: Label,
    detail: Label,
    icon: Icon,
    monogram: Monogram.nullable(),
    actions: z.array(NotchCardAction).max(NOTCH_CARD_ACTIONS_MAX),
  }),
);

/** What the notch shows; it replaces the previous `show`. A card shows alone. */
const ShowCommand = z.strictObject({
  type: z.literal("show"),
  view: ViewNumber,
  call: NotchCall.nullable(),
  /** Whom the call may be with; the first one is named beside the notch. */
  people: z.array(NotchPerson).max(NOTCH_PEOPLE_MAX),
  /** « Masquer pour cet appel »: hides the people; null without any. */
  dismiss: z.strictObject({ label: Label, callId: RowId }).nullable(),
  card: NotchCard.nullable(),
  /** Resting the pointer on it opens it; otherwise a click does, and the pointer peeks. */
  openOnHover: z.boolean(),
});

export const NotchCommand = named(
  "NotchCommand",
  "One line main sends sondine-notch.",
  z.discriminatedUnion("type", [ShowCommand]),
);
export type NotchCommand = z.output<typeof NotchCommand>;
export type NotchCommandType = NotchCommand["type"];
export const NOTCH_COMMAND_TYPES: readonly NotchCommandType[] = NotchCommand.options.map(
  (option) => option.shape.type.value,
);

export const NotchEvent = named(
  "NotchEvent",
  "One line sondine-notch sends main.",
  z.discriminatedUnion("type", [
    /** Shown beside the notch of a screen. */
    z.strictObject({ type: z.literal("ready") }),
    /** No screen has a notch (now, or any more): the helper exits. */
    z.strictObject({ type: z.literal("no-notch") }),
    z.strictObject({ type: z.literal("open-person"), view: ViewNumber, personId: RowId }),
    z.strictObject({ type: z.literal("open-episode"), view: ViewNumber, episodeId: RowId }),
    z.strictObject({ type: z.literal("dismiss"), view: ViewNumber, callId: RowId }),
    /** The call's switch: what it asks for. */
    z.strictObject({
      type: z.literal("toggle"),
      view: ViewNumber,
      callId: CallKey,
      on: z.boolean(),
    }),
    z.strictObject({ type: z.literal("mute"), view: ViewNumber, callId: CallKey }),
    z.strictObject({ type: z.literal("end-episode"), view: ViewNumber, episodeId: RowId }),
    z.strictObject({ type: z.literal("resume"), view: ViewNumber }),
    /** The card has had its time, or was answered. */
    z.strictObject({ type: z.literal("done"), view: ViewNumber, key: CallKey }),
  ]),
);
export type NotchEvent = z.output<typeof NotchEvent>;
export type NotchEventType = NotchEvent["type"];
export const NOTCH_EVENT_TYPES: readonly NotchEventType[] = NotchEvent.options.map(
  (option) => option.shape.type.value,
);
