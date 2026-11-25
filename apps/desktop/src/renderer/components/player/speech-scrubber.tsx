import { Slider } from "@base-ui/react/slider";
import { cn } from "@sondine/ui";
import { useState } from "react";
import type { Voice } from "../../lib/voices";
import type { SpeechLane } from "./player-time";

// The player's position control: an accessible slider (the thumb is a native
// range input, so arrows, Page Up/Down, Home and End work, and screen readers
// read the time) whose track shows where each voice speaks. A drag only moves
// the playhead; the player seeks when it is released, so a drag does not
// stream every position it crosses.

const laneColor = (voice: Voice) => {
  switch (voice.kind) {
    case "self":
      return "bg-color-1";
    case "person":
    case "other":
      return voice.number % 2 === 1 ? "bg-neutral-7" : "bg-neutral-5";
    case "unknown":
      return "bg-neutral-5";
    case "track":
      return voice.track === "microphone" ? "bg-neutral-7" : "bg-neutral-5";
  }
};

const first = (value: number | readonly number[]) =>
  typeof value === "number" ? value : (value[0] ?? 0);

export interface SpeechScrubberProps {
  readonly seconds: number;
  readonly durationSeconds: number;
  readonly lanes: readonly SpeechLane[];
  /** Search matches, as fractions of the timeline. */
  readonly marks?: readonly number[];
  readonly onSeek: (seconds: number) => void;
  readonly label: string;
  readonly valueText: (seconds: number) => string;
}

export function SpeechScrubber({
  seconds,
  durationSeconds,
  lanes,
  marks = [],
  onSeek,
  label,
  valueText,
}: SpeechScrubberProps) {
  const [held, setHeld] = useState<number | null>(null);
  const value = held ?? seconds;
  return (
    <Slider.Root
      value={Math.min(value, durationSeconds)}
      min={0}
      max={Math.max(durationSeconds, 1)}
      step={1}
      largeStep={10}
      onValueChange={(next) => setHeld(first(next))}
      onValueCommitted={(next) => {
        setHeld(null);
        onSeek(first(next));
      }}
      className="min-w-0 flex-1"
    >
      <Slider.Control className="relative flex h-xl w-full cursor-pointer touch-none items-center select-none">
        {marks.map((mark, index) => (
          <span
            key={index}
            aria-hidden
            className="pointer-events-none absolute -top-xxs size-xxs -translate-x-1/2 corner-full bg-color-1"
            style={{ left: `${mark * 100}%` }}
          />
        ))}
        <Slider.Track
          className={cn(
            "relative flex h-full w-full flex-col justify-center gap-xxs overflow-visible",
            "corner-s px-zero py-xxs",
            "bg-neutral-3",
          )}
        >
          {lanes.map((lane, index) => (
            <span key={index} aria-hidden className="relative min-h-xxs flex-1">
              {lane.spans.map((span, spanIndex) => (
                <span
                  key={spanIndex}
                  className={cn("absolute inset-y-0 min-w-px corner-full", laneColor(lane.voice))}
                  style={{
                    left: `${span.start * 100}%`,
                    width: `${(span.end - span.start) * 100}%`,
                  }}
                />
              ))}
            </span>
          ))}
          <Slider.Thumb
            aria-label={label}
            getAriaValueText={(_formatted, current) => valueText(current)}
            className={cn(
              "h-[calc(100%+var(--space-xs))] w-xxs corner-full bg-neutral-10",
              "focus-ring-within",
            )}
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
