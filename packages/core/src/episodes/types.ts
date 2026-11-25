/** Source kind of a capture track (architecture §3, "Tracks and timing"). */
export type TrackKind = "input" | "app" | "system" | "phone";

/** Where an episode's speech came from, computed after echo flags and dedup (ADR 007). */
export type EpisodeContext = "call" | "in_person" | "media" | "mixed" | "dictation" | "imported";

/** Who wrote a constraint: the user, or a later automatic stage. Manual always wins. */
export type ConstraintOrigin = "auto" | "manual";

/** App attribution attached to a speech region when it was captured. */
export interface AppContext {
  /** The app whose lane the region belongs to: an app track's own app. */
  readonly bundleId?: string;
  /**
   * A `system` region only: the one app the system track's attribution named
   * when the region started (`single-active`); absent when the attribution
   * was ambiguous or unknown. Matching only: it decides whether the region
   * hears a call, never which media lane it joins.
   */
  readonly attributedBundleId?: string;
  /**
   * An app or `system` region only: the page its browser reported playing
   * sound at the region's midpoint, when exactly one did (ADR 023). Media of
   * another page starts the next episode; media with no page joins the one
   * going on.
   */
  readonly pageKey?: string;
  readonly isCallApp: boolean;
  /** A call app or call daemon had input running while this region was captured. */
  readonly callActive: boolean;
}

/**
 * Evidence that a region is not live speech of its own:
 * - `echo`: a mic copy of audio played on another track (speakers);
 * - `duplicate`: the same speech captured by another input (multi-mic, phone);
 * - `self-playback`: Sondine replaying a moment, never part of any episode.
 */
export type EchoFlag =
  | { readonly kind: "echo"; readonly ofTrackKey: string }
  | { readonly kind: "duplicate"; readonly ofTrackKey: string }
  | { readonly kind: "self-playback" };

/**
 * One VAD speech region on one track. Times are capture nanoseconds on the
 * shared cross-track timeline (continuous time), so they stay bigint.
 */
export interface SpeechRegion {
  readonly id: string;
  readonly trackKey: string;
  readonly trackKind: TrackKind;
  readonly startNs: bigint;
  readonly endNs: bigint;
  /** VAD speech inside the region, without pre-roll or post-roll. */
  readonly voicedMs: number;
  readonly appContext: AppContext;
  readonly echoFlag?: EchoFlag;
}

/** A call app or call daemon starting or stopping a call (helper `call` message). */
export interface CallTransition {
  readonly atNs: bigint;
  /**
   * Identifies one call source, usually the call app bundle ID. Intervals of
   * one source that overlap or restart within the rejoin window are one call.
   */
  readonly callKey: string;
  /**
   * The helper's id of one active span: its `active` and `ended` pair with
   * each other only, whatever their order (a call can end where it starts).
   * Without it, the transitions of a source pair in time order.
   */
  readonly callId?: string;
  readonly bundleId?: string;
  readonly state: "active" | "ended";
}

/**
 * A dictation app listening to the microphone over `[startNs, endNs]` (helper
 * `listen` spans of the apps the user counts as dictation).
 */
export interface DictationSpan {
  readonly bundleId: string;
  readonly startNs: bigint;
  /** Null while the app still listens. */
  readonly endNs: bigint | null;
}

/** An app track open over `[startNs, endNs]`: that app's audio is not on `system:other`. */
export interface AppTap {
  readonly bundleId: string;
  readonly startNs: bigint;
  /** Null while the tap is open. */
  readonly endNs: bigint | null;
}

export type SystemEventKind =
  | "sleep"
  | "wake"
  | "pause"
  | "resume"
  | "device-change"
  | "capture-restart";

export interface SystemEvent {
  readonly atNs: bigint;
  readonly kind: SystemEventKind;
  readonly trackKey?: string;
}
