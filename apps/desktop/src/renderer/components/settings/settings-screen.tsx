import { useTheme } from "@sondine/ui";
import {
  BookOpenIcon,
  ChatIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChipIcon,
  ClockIcon,
  MicrophoneIcon,
  PhoneIcon,
  ShieldIcon,
  SlidersIcon,
  UsersIcon,
  WaveformIcon,
} from "@sondine/ui/icon";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useId, type ReactNode } from "react";
import { orpc } from "../../core/orpc";
import { useLocale } from "../../i18n/locale";
import type { SettingsPage } from "../../routes/search-params";
import { m } from "../../paraglide/messages.js";
import { ModelPanel } from "../models/model-panel";
import { LanguageSwitch, languageNames } from "../shell/language-switch";
import { backLinkClassName, screenClassName, titleClassName } from "../shell/screen";
import { ThemeSwitch, themeNames } from "../shell/theme-switch";
import { StatusPanel } from "../status/status-screen";
import { UsageSection } from "../usage/usage";
import { VoiceReadSection } from "../voice-read/voice-read-panel";
import { AgentsSection } from "./agents-section";
import { BrowserSection } from "./browser-section";
import { CallOffersSection } from "./call-offers-section";
import { ChatSection } from "./chat-section";
import { ComputeSection, useCompute } from "./compute-section";
import { DiagnosticSection } from "./diagnostic-section";
import { DictationSection } from "./dictation-section";
import { DictationVoiceSwitch } from "./dictation-voice-switch";
import { JournalSection } from "./journal-section";
import { LiveTextSection } from "./live-text-section";
import { LoginItemSwitch } from "./login-item-switch";
import { NotchSwitch } from "./notch-switch";
import { PhoneSection } from "./phone-section";
import { PrivacySection } from "./privacy-section";
import { RecognitionSwitch } from "./recognition-switch";
import { StatisticsSection } from "./statistics-section";
import { UpdatesSection } from "../updates/updates";

// Settings (`/settings`, ADR 037; Téo, 2026-11-19: rows, not tabs): the main
// sections as rows in a few groups, each with its icon and, where it says
// something, its current state; a row opens the section's own page
// (`/settings/$page`), with the way back. « Général »: language,
// appearance, opening at login, updates. « Transcription »: where it runs
// (ADR 040) and this Mac's model (as in the first run). « Journal du jour » (ADR 028). « Écoute »: call offers
// and near-live text. « Confidentialité »: what Sondine keeps (private
// zones, ADR 029), dictation apps, the sites a browser plays. « Voix »:
// recognition, the user's voice read (ADR 034), dictations, the notch.
// « iPhone » (ADR 008). « Agents »: the agents that read Sondine and the
// discussion with one (ADR 027). « Statistiques ». « Avancé »: capture
// health, as the Status screen showed it.

interface Page {
  readonly id: SettingsPage;
  readonly icon: ReactNode;
  readonly title: () => string;
  readonly content: () => ReactNode;
}

/** This Mac's model, only while it transcribes: elsewhere it has nothing to download. */
function LocalModel() {
  const compute = useCompute();
  return compute.data?.destination === "device" ? <ModelPanel /> : null;
}

const PAGES: Record<SettingsPage, Page> = {
  general: {
    id: "general",
    icon: <SlidersIcon />,
    title: () => m.settings_tab_general(),
    content: () => (
      <>
        <Part title={m.language_label()}>
          <LanguageSwitch />
        </Part>
        <Part title={m.theme_label()}>
          <ThemeSwitch />
        </Part>
        <Part title={m.settings_startup_title()}>
          <LoginItemSwitch />
        </Part>
        <Part title={m.settings_updates_title()}>
          <UpdatesSection />
        </Part>
      </>
    ),
  },
  transcription: {
    id: "transcription",
    icon: <WaveformIcon />,
    title: () => m.settings_transcription_title(),
    content: () => (
      <>
        <Part title={m.compute_title()}>
          <ComputeSection />
        </Part>
        <LocalModel />
      </>
    ),
  },
  journal: {
    id: "journal",
    icon: <BookOpenIcon />,
    title: () => m.settings_journal_title(),
    content: () => <JournalSection />,
  },
  listening: {
    id: "listening",
    icon: <MicrophoneIcon />,
    title: () => m.settings_listening_title(),
    content: () => (
      <>
        <Part title={m.settings_listening_calls()}>
          <CallOffersSection />
        </Part>
        <Part title={m.settings_live_title()}>
          <LiveTextSection />
        </Part>
      </>
    ),
  },
  privacy: {
    id: "privacy",
    icon: <ShieldIcon />,
    title: () => m.settings_privacy_title(),
    content: () => (
      <>
        <PrivacySection />
        <Part title={m.usage_title()}>
          <UsageSection />
        </Part>
        <Part title={m.settings_dictation_title()}>
          <DictationSection />
        </Part>
        <Part title={m.settings_browser_title()}>
          <BrowserSection />
        </Part>
      </>
    ),
  },
  voices: {
    id: "voices",
    icon: <UsersIcon />,
    title: () => m.settings_voices_title(),
    content: () => (
      <>
        <RecognitionSwitch />
        <VoiceReadSection />
        <DictationVoiceSwitch />
        <NotchSwitch />
      </>
    ),
  },
  phone: {
    id: "phone",
    icon: <PhoneIcon />,
    title: () => m.settings_phone_title(),
    content: () => <PhoneSection />,
  },
  agents: {
    id: "agents",
    icon: <ChatIcon />,
    title: () => m.agents_title(),
    content: () => (
      <>
        <AgentsSection />
        <Part title={m.settings_chat_title()}>
          <ChatSection />
        </Part>
      </>
    ),
  },
  statistics: {
    id: "statistics",
    icon: <ClockIcon />,
    title: () => m.settings_tab_statistics(),
    content: () => <StatisticsSection />,
  },
  advanced: {
    id: "advanced",
    icon: <ChipIcon />,
    title: () => m.settings_tab_advanced(),
    content: () => (
      <>
        <StatusPanel />
        <Part title={m.diagnostic_title()}>
          <DiagnosticSection />
        </Part>
      </>
    ),
  },
};

const GROUPS: readonly (readonly SettingsPage[])[] = [
  ["general", "transcription", "journal"],
  ["listening", "privacy", "voices"],
  ["phone", "agents"],
  ["statistics", "advanced"],
];

/** A titled part of a section's page. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-s">
      <h2 id={id} className="font-body font-medium text-body-m">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SettingsScreen() {
  const summaries = useSummaries();
  return (
    <div className={screenClassName}>
      <h1 className={titleClassName}>{m.nav_settings()}</h1>
      <nav aria-label={m.nav_settings()} className="flex flex-col gap-m">
        {GROUPS.map((group) => (
          <ul
            key={group.join()}
            className="flex flex-col corner-m bg-cte-canvas p-xxs ring-[1px] ring-neutral-4"
          >
            {group.map((id) => (
              <li key={id}>
                <Link
                  to="/settings/$page"
                  params={{ page: id }}
                  className="flex items-center gap-s corner-s p-s control-hover:bg-neutral-2 focus-ring"
                >
                  <span
                    aria-hidden
                    className="flex size-[2rem] shrink-0 items-center justify-center corner-s bg-neutral-3 text-cte-text-muted"
                  >
                    {PAGES[id].icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{PAGES[id].title()}</span>
                  {summaries[id] === undefined ? null : (
                    <span className="truncate text-body-s text-cte-text-muted">
                      {summaries[id]}
                    </span>
                  )}
                  <ChevronRightIcon aria-hidden className="shrink-0 text-cte-text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        ))}
      </nav>
    </div>
  );
}

/** What a row says of its section's state, where that is short and known. */
function useSummaries(): Partial<Record<SettingsPage, string>> {
  const { locale } = useLocale();
  const { theme } = useTheme();
  const journal = useQuery(orpc.journal.day.queryOptions({ input: {} }));
  const enabled = journal.data?.state.enabled;
  return {
    general: `${languageNames[locale]()} · ${themeNames[theme]()}`,
    ...(enabled === undefined
      ? {}
      : { journal: enabled ? m.settings_state_on() : m.settings_state_off() }),
  };
}

const pageRoute = getRouteApi("/shell/settings/$page");

export function SettingsPageScreen() {
  const { page } = pageRoute.useParams();
  const section = PAGES[page];
  return (
    <div className={screenClassName}>
      <Link to="/settings" className={backLinkClassName}>
        <ChevronLeftIcon />
        {m.nav_settings()}
      </Link>
      <h1 className={titleClassName}>{section.title()}</h1>
      <div className="flex flex-col gap-xl">{section.content()}</div>
    </div>
  );
}
