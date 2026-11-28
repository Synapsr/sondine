import { ClockIcon, MicrophoneIcon, PauseIcon, type IconProps } from "@sondine/ui/icon";
import type { ComponentType } from "react";
import { m } from "../../paraglide/messages.js";
import type { StartNotes } from "./welcome-steps";

// The first run's last step, before « Commencer l'écoute » (Téo,
// 2026-11-28: fewer words, more to see): one line, three short ones beside
// their icons, as the Cloud's terms, then only what is missing.

const POINTS: readonly { readonly Icon: ComponentType<IconProps>; readonly text: () => string }[] =
  [
    { Icon: MicrophoneIcon, text: () => m.welcome_start_point_sources() },
    { Icon: PauseIcon, text: () => m.welcome_start_point_pause() },
    { Icon: ClockIcon, text: () => m.welcome_start_point_transcribe() },
  ];

export function StartBody({
  listening,
  notes,
}: {
  readonly listening: boolean;
  readonly notes: StartNotes;
}) {
  const missing = [
    notes.noModel ? m.welcome_no_model_note() : null,
    notes.missing.includes("microphone") ? m.welcome_no_microphone_note() : null,
    notes.missing.includes("systemAudio") ? m.welcome_no_system_audio_note() : null,
  ].filter((line) => line !== null);
  return (
    <>
      <p className="text-body-m">
        {listening ? m.welcome_already_listening() : m.welcome_start_lead()}
      </p>
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
      {missing.length === 0 ? null : (
        <ul className="flex flex-col gap-xxs text-body-s text-cte-text-muted">
          {missing.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </>
  );
}
