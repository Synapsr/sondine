import { SondineLogo } from "@sondine/ui/icon";
import { useEffect, useRef, useState } from "react";
import { m } from "../../paraglide/messages.js";
import { SkySurface } from "./sky-surface";

// The first run's opening (Téo, 2026-11-28, after Arc and Dia's first
// launch): on the window's own background, the site's moving sky
// (sky-surface.tsx) comes in; Sondine's wordmark arrives, « Bienvenue » under it, then a
// quiet line says to click. A click anywhere, or Return or Space, fades it
// all out onto the first question, with a light tap of the trackpad.
// Hovered, the wordmark's disc turns, and the line to click shimmers; its
// shimmer, once started, runs to its end and does not start again before
// (Téo, 2026-11-28), and it shimmers by itself after 5 s without a click.
// Shown each time the first run opens before anything is chosen; nothing is
// saved. Reduced motion keeps it still (renderer/styles.css).

const LEAVE_MS = 600;
/** When the line to click has risen in (styles.css: its delay and length). */
const BEGIN_SHOWN_MS = 3100;
const IDLE_MS = 5000;

/** A shimmer that, once started, plays to its end: starting it again meanwhile does nothing. */
function useShimmer() {
  const [playing, setPlaying] = useState(false);
  return {
    playing,
    play: () => setPlaying(true),
    props: {
      "data-playing": playing || undefined,
      onAnimationEnd: () => setPlaying(false),
    },
  };
}

export function WelcomeIntro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const begin = useRef<HTMLButtonElement>(null);
  const beginShimmer = useShimmer();
  const shimmered = useRef(false);
  // Unclicked, the line shimmers 5 s after it shows, then 5 s after each shimmer.
  const { playing: shimmering, play: shimmer } = beginShimmer;
  useEffect(() => {
    if (shimmering) return;
    const wait = shimmered.current ? IDLE_MS : BEGIN_SHOWN_MS + IDLE_MS;
    shimmered.current = true;
    const timer = window.setTimeout(shimmer, wait);
    return () => window.clearTimeout(timer);
  }, [shimmering, shimmer]);
  // Return and Space begin at once; the ring shows only once the keyboard moves.
  useEffect(() => begin.current?.focus({ focusVisible: false }), []);
  const leave = () => {
    if (leaving) return;
    // Felt on the trackpad as it fades (native/haptic.m).
    window.sondine.haptic();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onDone();
    else {
      setLeaving(true);
      window.setTimeout(onDone, LEAVE_MS);
    }
  };
  return (
    <div
      className="sondine-intro fixed inset-zero flex cursor-pointer flex-col items-center justify-center overflow-hidden bg-cte-canvas"
      data-leaving={leaving || undefined}
      onClick={leave}
    >
      <SkySurface className="sondine-intro-sky absolute inset-zero" />
      {/* No title bar: the top edge still drags the window. */}
      <div
        aria-hidden
        className="absolute inset-x-zero top-zero h-[2.5rem] [-webkit-app-region:drag]"
      />
      <h1 className="sr-only">{m.welcome_intro_title()}</h1>
      <div aria-hidden className="relative flex flex-col items-center gap-l px-l text-center">
        {/* Hovered, the disc turns. */}
        <SondineLogo className="sondine-intro-logo w-[18rem]" />
        <p className="sondine-intro-welcome font-display font-medium text-display-xs">
          {m.welcome_intro_welcome()}
        </p>
      </div>
      <button
        ref={begin}
        type="button"
        className="sondine-intro-begin absolute bottom-xxl corner-full px-m py-xs text-body-m focus-ring"
        onPointerEnter={shimmer}
      >
        <span className="sondine-intro-shimmer" {...beginShimmer.props}>
          {m.welcome_intro_begin()}
        </span>
      </button>
    </div>
  );
}
