import { cn } from "@sondine/ui";
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "@sondine/ui/icon";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { SCREEN_OVERLAY_ID } from "../shell/screen";
import { m } from "../../paraglide/messages.js";
import {
  gestureAxis,
  ORDER,
  rubberBand,
  settled,
  springStep,
  zoomTransition,
  type Zoom,
} from "./calendar-view";

// Moving through the calendar (Téo, 2026-11-19): the switch in each header
// and ⌘− / ⌘+ zoom between a day, a week and a month; a trackpad pinch
// zooms too, which Chromium hands the page as a wheel with Ctrl held (the
// window's own zoom stays off); a two-finger swipe goes to the day, week or
// month before or after. The screen stays under the fingers and the page
// turns when they leave past the step (Téo, 2026-11-19: no spring back while
// swiping). Chromium tells no lift: momentum (ever smaller deltas) past the
// step, or the wheel quiet a while, stands for it. After a step, its
// momentum is ignored, but a clearly stronger push, once settled, starts the
// next swipe, so two deliberate swipes make two steps and one does not.

/** How much pinch makes one step, in wheel delta. */
const PINCH_STEP = 40;
/** How far a sideways swipe goes for a step. */
const SWIPE_STEP = 110;
/** A pause this long between wheel events ends a gesture (ms). */
const GESTURE_GAP_MS = 140;
/**
 * One step per touch (Téo, 2026-11-19: holding on and swiping on turned
 * page after page). After a step, a new swipe starts only once the fingers
 * have left and come back: momentum that stops (fingers back on the
 * trackpad cut it) with a pause of `RETOUCH_MS`, or the wheel quiet for
 * `LIFT_MS`. A continuous swipe, however slow, sends events closer than that.
 */
const RETOUCH_MS = 40;
const LIFT_MS = 260;

/** Sent on the window when a swipe starts, so hover previews close. */
export const SWIPE_START_EVENT = "sondine:swipe-start";

/** Where a day is shown: Today's own screen, or the calendar's day. */
export type Place = "today" | "calendar";

export interface CalendarGestures {
  readonly onZoom: (direction: "in" | "out") => void;
  /** `next` for fingers moving left, as a page turns. */
  readonly onSwipe: (direction: "previous" | "next") => void;
  /** Whether there is a page after this one (none after today). */
  readonly hasNext: boolean;
}

interface SwipeState {
  /** 0 to 1: how far toward a step. */
  readonly share: number;
  /** -1 toward the previous page, 1 toward the next, 0 when still. */
  readonly side: -1 | 0 | 1;
  /** Nothing lies that way (after today): the hint is greyed and the screen springs back. */
  readonly blocked: boolean;
}

const STILL: SwipeState = { share: 0, side: 0, blocked: false };
/** Past the step, the screen gives only this much more; where nothing lies, this much in all. */
const BEYOND_PX = 36;
const BLOCKED_PX = 36;
/** Where the next page comes in from, before it springs into place. */
const ENTER_PX = 72;
/** That far away, the screen is this much smaller and this blurred (px). */
const SWIPE_SHRINK = 0.015;
const SWIPE_BLUR_PX = 1.8;
/** Wheel quiet this long, the fingers are taken as lifted (Chromium gives no lift event). */
const RELEASE_MS = 220;
/** This many shrinking deltas in a row are momentum: the fingers have left. */
const MOMENTUM_EVENTS = 4;

/**
 * Wires ⌘− / ⌘+, a pinch and a sideways swipe while the screen is shown.
 * Returns the swipe's hint to render, and a ref for the screen's content,
 * which follows the fingers with a rubber band, brings the next page in
 * with a spring, and bounces back where nothing lies (Téo, 2026-11-19: an
 * organic feel). Reduced motion keeps the hint and leaves the screen still.
 */
export function useCalendarGestures(gestures: CalendarGestures): {
  readonly hint: ReactNode;
  readonly contentRef: RefObject<HTMLDivElement | null>;
} {
  const latest = useRef(gestures);
  latest.current = gestures;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [swipe, setSwipe] = useState<SwipeState>(STILL);
  useEffect(() => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Away from its place, the screen shrinks a touch and blurs lightly, the next page clearing as it settles.
    const spring = createSpring((x) => {
      const element = contentRef.current;
      if (element === null) return;
      const depth = Math.min(Math.abs(x) / ENTER_PX, 1);
      const still = Math.abs(x) < 0.5;
      element.style.translate = still ? "" : `${x}px 0`;
      element.style.scale = still ? "" : String(1 - depth * SWIPE_SHRINK);
      element.style.filter = still ? "" : `blur(${(depth * SWIPE_BLUR_PX).toFixed(2)}px)`;
      element.style.willChange = still ? "" : "translate, scale, filter";
      // Moving under a still pointer, the screen would hover what slides by (a day's preview).
      element.style.pointerEvents = still ? "" : "none";
    });
    const follow = (x: number) => {
      if (!calm.matches) spring.jump(x);
    };
    const settle = (from?: number) => {
      if (calm.matches) return;
      if (from !== undefined) spring.jump(from);
      spring.to(0);
    };
    let ended: ReturnType<typeof setTimeout> | undefined;
    let pinched = 0;
    let swipedX = 0;
    let swipedY = 0;
    let done = false;
    let lastAt = Number.NEGATIVE_INFINITY;
    let lastX = 0;
    const restart = () => {
      pinched = 0;
      swipedX = 0;
      swipedY = 0;
      done = false;
      coasted = false;
      announced = false;
      axis = null;
    };
    let shrinking = 0;
    /** Since the step, momentum has run: the fingers left. */
    let coasted = false;
    /** The swipe's start was told (SWIPE_START_EVENT). */
    let announced = false;
    /** What this gesture is, once its first pixels said so: a swipe (x) or a scroll (y). */
    let axis: "x" | "y" | null = null;
    /** The fingers have left: past the step the page turns, short of it the screen springs back. */
    const release = () => {
      clearTimeout(ended);
      if (done || swipedX === 0) return;
      const side = swipedX > 0 ? 1 : -1;
      const blocked = side === 1 && !latest.current.hasNext;
      done = true;
      setSwipe(STILL);
      if (blocked || Math.abs(swipedX) < SWIPE_STEP) {
        settle();
        return;
      }
      // A page turned on momentum: the fingers have already left.
      coasted = shrinking >= MOMENTUM_EVENTS;
      latest.current.onSwipe(side === 1 ? "next" : "previous");
      // The next page comes in from the side the fingers came from.
      requestAnimationFrame(() => settle(side * ENTER_PX));
    };
    const wheel = (event: WheelEvent) => {
      const gap = event.timeStamp - lastAt;
      lastAt = event.timeStamp;
      if (pinched !== 0 && gap > GESTURE_GAP_MS) restart();
      if (done && swipedX !== 0 && (gap >= LIFT_MS || (coasted && gap >= RETOUCH_MS))) restart();
      // A scroll left alone: the next movement is a new gesture.
      if (!done && axis !== null && gap >= LIFT_MS) restart();
      if (event.ctrlKey) {
        event.preventDefault();
        if (done) return;
        pinched += event.deltaY;
        if (Math.abs(pinched) < PINCH_STEP) return;
        done = true;
        // Fingers apart (a negative delta) zoom in.
        latest.current.onZoom(pinched < 0 ? "in" : "out");
        return;
      }
      const x = Math.abs(event.deltaX);
      shrinking = x > 0 && x < lastX ? shrinking + 1 : 0;
      lastX = x;
      // Momentum (ever smaller deltas) after a step means the fingers have left.
      if (done && shrinking >= MOMENTUM_EVENTS) coasted = true;
      if (done) {
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.preventDefault();
        return;
      }
      swipedX += event.deltaX;
      swipedY += event.deltaY;
      // The first few pixels say what the gesture is: clearly sideways, a swipe; else a scroll,
      // and the rest of it, momentum included, never turns into a swipe (Téo, 2026-11-19).
      if (axis === null) {
        axis = gestureAxis(swipedX, swipedY);
        if (axis === null) return;
      }
      if (axis === "y") return;
      event.preventDefault();
      // A swipe starting closes what hovering opened.
      if (!announced) {
        announced = true;
        window.dispatchEvent(new Event(SWIPE_START_EVENT));
      }
      const side = swipedX > 0 ? 1 : -1;
      const blocked = side === 1 && !latest.current.hasNext;
      const distance = Math.abs(swipedX);
      // The screen stays under the fingers up to the step, then gives only a little more.
      const offset = blocked
        ? rubberBand(distance, BLOCKED_PX)
        : distance <= SWIPE_STEP
          ? distance
          : SWIPE_STEP + rubberBand(distance - SWIPE_STEP, BEYOND_PX);
      follow(-side * offset);
      setSwipe({ share: blocked ? 0 : Math.min(distance / SWIPE_STEP, 1), side, blocked });
      // Fingers gone: past the step, momentum (ever smaller deltas) turns the page at once;
      // otherwise the wheel quiet a while. Slowing down short of the step never springs back.
      if (!blocked && distance >= SWIPE_STEP && shrinking >= MOMENTUM_EVENTS) release();
      else {
        clearTimeout(ended);
        ended = setTimeout(release, RELEASE_MS);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey) return;
      if (event.key === "-") latest.current.onZoom("out");
      else if (event.key === "=" || event.key === "+") latest.current.onZoom("in");
      else return;
      event.preventDefault();
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(ended);
      spring.stop();
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return { hint: <SwipeHint swipe={swipe} />, contentRef };
}

/** A damped spring driving one number through `apply`, frame by frame. */
function createSpring(apply: (value: number) => void) {
  let value = 0;
  let velocity = 0;
  let target = 0;
  let frame = 0;
  let last = 0;
  const tick = (now: number) => {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    [value, velocity] = springStep(value, velocity, target, dt);
    apply(value);
    frame = settled(value, velocity, target) ? 0 : requestAnimationFrame(tick);
    if (frame === 0) apply((value = target));
  };
  return {
    jump(next: number) {
      cancelAnimationFrame(frame);
      frame = 0;
      value = next;
      velocity = 0;
      apply(next);
    },
    to(next: number) {
      target = next;
      if (frame !== 0) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/** The ring's circumference, for a 2.75rem circle (44 px) with a 20 px radius. */
const RING = 2 * Math.PI * 20;

/**
 * At the screen's edge the swipe leads to: a chevron in a ring that fills as
 * the fingers go; in ink once letting go turns the page, greyed where
 * nothing lies.
 */
function SwipeHint({ swipe }: { swipe: SwipeState }) {
  // The layer over the screen's card, so the hint sits at its edges rather than the window's.
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  useEffect(() => setLayer(document.getElementById(SCREEN_OVERLAY_ID)), []);
  // The side it was on, kept while it fades out.
  const [kept, setKept] = useState<SwipeState>(swipe);
  if (swipe.side !== 0 && swipe !== kept) setKept(swipe);
  const active = swipe.side !== 0;
  const next = kept.side > 0;
  const { share, blocked } = active ? swipe : { share: kept.share, blocked: kept.blocked };
  const reached = share >= 1;
  if (layer === null) return null;
  return createPortal(
    <div
      aria-hidden
      className={cn(
        "absolute top-1/2 flex -translate-y-1/2 items-center gap-xs",
        "transition-opacity duration-motion ease-motion motion-reduce:transition-none",
        next ? "end-m flex-row-reverse" : "start-m flex-row",
      )}
      style={{
        opacity: active ? (blocked ? 0.8 : Math.min(1, 0.25 + share)) : 0,
        transform: `translateX(${(next ? 1 : -1) * (1 - (blocked ? 0.6 : share)) * 24}px)`,
      }}
    >
      <span
        className={cn(
          "relative flex size-[2.75rem] items-center justify-center corner-full shadow-m",
          "transition-[background-color,color,scale] duration-motion ease-motion motion-reduce:transition-none",
          blocked
            ? "bg-neutral-3 text-neutral-6"
            : reached
              ? "scale-110 bg-cte-text text-cte-canvas"
              : "bg-cte-canvas text-cte-text",
        )}
      >
        <svg viewBox="0 0 44 44" className="absolute inset-0 size-full -rotate-90">
          <circle cx="22" cy="22" r="20" fill="none" stroke="var(--neutral-4)" strokeWidth="2" />
          <circle
            cx="22"
            cy="22"
            r="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - share)}
            className={reached || blocked ? "opacity-0" : ""}
          />
        </svg>
        {next ? <ChevronRightIcon /> : <ChevronLeftIcon />}
      </span>
    </div>,
    layer,
  );
}

const label: Record<Zoom, () => string> = {
  day: () => m.calendar_zoom_day(),
  week: () => m.calendar_zoom_week(),
  month: () => m.calendar_zoom_month(),
};

const segmentClassName = cn(
  "corner-s px-s py-xxs font-body font-medium text-body-s text-cte-text-muted",
  "transition-[background-color,color] duration-motion ease-motion motion-reduce:transition-none",
  "control-hover:text-cte-text focus-ring",
  "aria-[current=page]:bg-cte-canvas aria-[current=page]:text-cte-text aria-[current=page]:shadow-s",
);

/** Jour · Semaine · Mois, around `day`; in the calendar, its day stays in the calendar. */
export function ZoomSwitch({
  zoom,
  day,
  place = "calendar",
}: {
  zoom: Zoom;
  day: string | undefined;
  place?: Place;
}) {
  return (
    <nav
      aria-label={m.calendar_zoom()}
      className="flex items-center gap-xxs corner-m bg-neutral-3 p-xxs"
    >
      {ORDER.map((each) =>
        each === "day" && place === "today" ? (
          <Link
            key={each}
            to="/"
            search={day === undefined ? {} : { day }}
            aria-current={zoom === each ? "page" : undefined}
            viewTransition={zoomTransition(zoom, each)}
            className={segmentClassName}
          >
            {label[each]()}
          </Link>
        ) : (
          <Link
            key={each}
            to="/calendar"
            search={{ zoom: each, ...(day === undefined ? {} : { day }) }}
            aria-current={zoom === each ? "page" : undefined}
            viewTransition={zoomTransition(zoom, each)}
            className={segmentClassName}
          >
            {label[each]()}
          </Link>
        ),
      )}
    </nav>
  );
}
