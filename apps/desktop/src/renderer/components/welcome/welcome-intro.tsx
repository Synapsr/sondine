import { SondineLogo } from "@sondine/ui/icon";
import { useEffect, useRef, useState } from "react";
import { m } from "../../paraglide/messages.js";
import { SkySurface } from "./sky-surface";

// The first run's opening (Téo, 2026-11-28, after Arc and Dia's first
// launch): on the window's own background, the site's moving sky
// (sky-surface.tsx) comes in; Sondine's wordmark arrives, « Bienvenue » under it, then a
// quiet line says to click. A click anywhere, or Return or Space, fades it
// all out onto the first question. Hovered, the wordmark catches a band of
// light and its disc turns, and the line to click shimmers. Shown each time the first run opens
// before anything is chosen; nothing is saved. Reduced motion keeps it
// still (renderer/styles.css).

const LEAVE_MS = 600;

export function WelcomeIntro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const begin = useRef<HTMLButtonElement>(null);
  // Return and Space begin at once; the ring shows only once the keyboard moves.
  useEffect(() => begin.current?.focus({ focusVisible: false }), []);
  const leave = () => {
    if (leaving) return;
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
        {/* Hovered, a band of the sky's colors glides over the wordmark and its disc turns. */}
        <span className="sondine-intro-logo relative block w-[18rem]">
          <SondineLogo className="block w-full" />
          <SondineLogo className="sondine-intro-shine absolute inset-zero block w-full" />
          <svg width={0} height={0} className="absolute">
            <defs>
              <linearGradient id="sondine-intro-shine" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="var(--color-4)" />
                <stop offset="0.5" stopColor="var(--color-3)" />
                <stop offset="1" stopColor="var(--color-2)" />
              </linearGradient>
            </defs>
          </svg>
        </span>
        <p className="sondine-intro-welcome font-display font-medium text-display-xs">
          {m.welcome_intro_welcome()}
        </p>
      </div>
      <button
        ref={begin}
        type="button"
        className="sondine-intro-begin absolute bottom-xxl corner-full px-m py-xs text-body-m focus-ring"
      >
        <span className="sondine-intro-shimmer">{m.welcome_intro_begin()}</span>
      </button>
    </div>
  );
}
