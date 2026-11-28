import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import {
  ClockIcon,
  MicrophoneIcon,
  PauseIcon,
  VolumeIcon,
  WaveformIcon,
  type IconProps,
} from "@sondine/ui/icon";
import { useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { m } from "../../paraglide/messages.js";
import { SkySurface } from "./sky-surface";
import type { StartNotes } from "./welcome-steps";

// The first run's last step, before « Commencer l'écoute » (Téo,
// 2026-11-28: fewer words, more to see). Three ways to say it are tried in
// development, chosen in the window's bottom left corner; a build shows the
// first until one is kept.

const VARIANTS = ["points", "menu-bar", "sky"] as const;
type Variant = (typeof VARIANTS)[number];
const VARIANT_KEY = "sondine.dev.start-variant";

function readVariant(): Variant {
  if (!import.meta.env.DEV) return "points";
  try {
    const stored = localStorage.getItem(VARIANT_KEY);
    return VARIANTS.find((variant) => variant === stored) ?? "points";
  } catch {
    return "points";
  }
}

export function StartBody({
  listening,
  notes,
}: {
  readonly listening: boolean;
  readonly notes: StartNotes;
}) {
  const [variant, setVariant] = useState(readVariant);
  const choose = (next: Variant) => {
    setVariant(next);
    try {
      localStorage.setItem(VARIANT_KEY, next);
    } catch {
      // The choice holds for this page only.
    }
  };
  const lead = listening ? m.welcome_already_listening() : m.welcome_start_lead();
  return (
    <>
      {variant === "points" ? <PointsBody lead={lead} /> : null}
      {variant === "menu-bar" ? <MenuBarBody lead={lead} /> : null}
      {variant === "sky" ? <SkyBody lead={lead} /> : null}
      <Notes notes={notes} />
      {import.meta.env.DEV
        ? createPortal(
            <span className="fixed start-l bottom-l z-[100] flex items-center gap-xxs">
              {VARIANTS.map((candidate) => (
                <Button
                  key={candidate}
                  variant={candidate === variant ? "secondary" : "ghost"}
                  className="text-body-xs text-cte-text-muted"
                  onClick={() => choose(candidate)}
                >
                  {`Dev : ${candidate}`}
                </Button>
              ))}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

/** What is missing, in one muted line each: no model, no microphone, no system audio. */
function Notes({ notes }: { readonly notes: StartNotes }) {
  const lines = [
    notes.noModel ? m.welcome_no_model_note() : null,
    notes.missing.includes("microphone") ? m.welcome_no_microphone_note() : null,
    notes.missing.includes("systemAudio") ? m.welcome_no_system_audio_note() : null,
  ].filter((line) => line !== null);
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-xxs text-body-s text-cte-text-muted">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

const POINTS: readonly { readonly Icon: ComponentType<IconProps>; readonly text: () => string }[] =
  [
    { Icon: MicrophoneIcon, text: () => m.welcome_start_point_sources() },
    { Icon: PauseIcon, text: () => m.welcome_start_point_pause() },
    { Icon: ClockIcon, text: () => m.welcome_start_point_transcribe() },
  ];

/** A: one line, then three short ones beside their icons, as the Cloud's terms. */
function PointsBody({ lead }: { readonly lead: string }) {
  return (
    <>
      <p className="text-body-m">{lead}</p>
      <ul className="flex flex-col gap-m text-body-s">
        {POINTS.map(({ Icon, text }) => (
          <li key={text()} className="flex items-center gap-s">
            <span
              aria-hidden
              className="flex size-[2.25rem] shrink-0 items-center justify-center corner-full bg-neutral-3 text-body-l text-cte-text-muted"
            >
              <Icon />
            </span>
            {text()}
          </li>
        ))}
      </ul>
    </>
  );
}

/** B: the menu bar drawn, Sondine's icon open on its pause menu. */
function MenuBarBody({ lead }: { readonly lead: string }) {
  return (
    <>
      <p className="text-body-m">{lead}</p>
      <figure className="m-zero flex flex-col items-end gap-xxs overflow-hidden corner-l bg-neutral-2 p-s inset-ring-[1px] inset-ring-neutral-4">
        <span
          aria-hidden
          className="flex w-full items-center justify-end gap-m corner-s bg-neutral-1 px-s py-xxs text-body-s text-cte-text-muted"
        >
          <VolumeIcon />
          <span className="flex items-center corner-xs bg-neutral-4 px-xxs py-[2px] text-cte-text">
            <WaveformIcon />
          </span>
          <span>9:41</span>
        </span>
        <span className="me-xl flex w-[16rem] flex-col corner-s bg-neutral-1 p-xxs text-body-s shadow-m">
          {[m.tray_pause_15_min(), m.tray_pause_1_hour(), m.tray_pause_until_resumed()].map(
            (item, index) => (
              <span
                key={item}
                className={cn(
                  "corner-xs px-s py-xxs",
                  index === 0 && "bg-color-1 text-cte-accent-text",
                )}
              >
                {item}
              </span>
            ),
          )}
        </span>
        <figcaption className="self-start pt-xs text-body-s text-cte-text-muted">
          {m.welcome_start_point_pause()}
        </figcaption>
      </figure>
      <p className="text-body-s text-cte-text-muted">{m.welcome_start_point_transcribe()}</p>
    </>
  );
}

/** C: the sky, a big line on it, and the rest in two small lines. */
function SkyBody({ lead }: { readonly lead: string }) {
  return (
    <>
      <div className="sondine-cloud relative flex flex-col gap-xs overflow-hidden corner-l p-l">
        <SkySurface className="sondine-cloud-sky absolute inset-zero" />
        <span aria-hidden className="relative flex items-center gap-xs text-display-xs">
          <MicrophoneIcon />
          <VolumeIcon />
        </span>
        <p className="relative font-display font-heavy text-display-s">{lead}</p>
      </div>
      <p className="flex items-center gap-xs text-body-s">
        <WaveformIcon aria-hidden className="shrink-0" />
        {m.welcome_start_point_pause()}
      </p>
      <p className="text-body-s text-cte-text-muted">{m.welcome_start_point_transcribe()}</p>
    </>
  );
}
