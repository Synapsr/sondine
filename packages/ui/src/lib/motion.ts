import type { Transition } from "motion/react";

// Motion for React needs numbers, so the theme's motion values are mirrored
// here. motion.test.ts keeps them equal to the --motion-* variables in
// graphical/generated/theme.css.

/** Small motion: controls, menus, small popovers. */
export const smallTransition = {
  type: "tween",
  duration: 0.2,
  ease: [0.16, 1, 0.3, 1],
} as const satisfies Transition;

/** Large motion: dialogs, drawers, toasts, navigation surfaces, disclosure panels. */
export const largeTransition = {
  type: "tween",
  duration: 0.36,
  ease: [0.22, 1, 0.36, 1],
} as const satisfies Transition;

/** Scale a popup enters from and exits to. */
export const popupScale = 0.96;

/** Distance in pixels a pressed control moves down. */
export const pressDistance = 1;
