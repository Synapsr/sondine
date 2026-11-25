// One frame for every screen (ADR 037): the same width and title, so titles
// line up from one screen to the next.

/** A screen's column inside the card. */
export const screenClassName = "mx-auto flex w-full max-w-[56rem] flex-col gap-l";

/**
 * A screen's title. A description under it sits in a column with `gap-xs`,
 * so the title's descenders never touch it.
 */
export const titleClassName = "font-display font-heavy text-display-m";

/** « ‹ Aujourd'hui », « ‹ Personnes »: where a screen was opened from. */
export const backLinkClassName =
  "flex w-fit items-center gap-xxs corner-xs font-body font-medium text-body-s text-cte-text-muted focus-ring control-hover:text-cte-text";

/** The layer over the screen's card, for hints at its edges. */
export const SCREEN_OVERLAY_ID = "screen-overlay";
