import { Button } from "@sondine/ui/components/button";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@sondine/ui/components/toggle-group";
import { useEffect, useId, useState, type ReactNode } from "react";
import { screenClassName, titleClassName } from "../components/shell/screen";
import type { LabCommand, LabScenario, LabSettings, LabView } from "../../shared/notch-lab";

// Development only (see router.tsx): plays the island's flows on the real
// notch (main/notch-lab.ts), from a call that does not exist. Not translated,
// like the design system page.

const SCENARIOS: readonly { readonly name: LabScenario; readonly label: string }[] = [
  { name: "listening", label: "Appel, à l’écoute" },
  { name: "paused", label: "Appel, en pause" },
  { name: "full", label: "Appel complet (20 s)" },
  { name: "restored", label: "Pause qui revient (14 s)" },
  { name: "interrupted", label: "Changements en pleine animation" },
];

const CAPTURES: readonly { readonly value: LabSettings["capture"]; readonly label: string }[] = [
  { value: "listening", label: "À l’écoute" },
  { value: "paused", label: "En pause" },
  { value: "pause-unconfirmed", label: "Pause non confirmée" },
  { value: "partial", label: "Partielle" },
  { value: "connecting", label: "Inconnue" },
];

const APPS: readonly { readonly value: LabSettings["app"]; readonly label: string }[] = [
  { value: "discord", label: "Discord" },
  { value: "zoom", label: "Zoom" },
  { value: "facetime", label: "FaceTime" },
  { value: "long", label: "Nom long, sans icône" },
];

const SPEEDS = [
  { value: "1", label: "1×" },
  { value: "2", label: "½×" },
  { value: "4", label: "¼×" },
  { value: "8", label: "⅛×" },
] as const;
const SLOW = { "1": 1, "2": 2, "4": 4, "8": 8 } as const;

const PROBLEMS = {
  "no-helper": "Encoche non construite : swift build --product sondine-notch, dans native/.",
  "no-notch": "Aucun écran avec une encoche.",
} as const;

export function NotchLabRoute() {
  const bridge = window.sondine.notchLab;
  const [view, setView] = useState<LabView | null>(null);
  useEffect(() => {
    if (bridge === undefined) return;
    void bridge.run(null).then(setView);
    return bridge.onChange(setView);
  }, [bridge]);
  if (bridge === undefined || view === null) return null;
  const { settings, call } = view.state;
  const run = (command: LabCommand) => void bridge.run(command).then(setView);
  const set = (next: Partial<LabSettings>) => run({ type: "set", settings: next });
  return (
    <div className={screenClassName}>
      <h1 className={titleClassName}>Encoche</h1>
      {view.problem === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {PROBLEMS[view.problem]}
        </p>
      )}
      <Group title="Scénarios">
        {SCENARIOS.map(({ name, label }) => (
          <Button key={name} variant="secondary" onClick={() => run({ type: "scenario", name })}>
            {label}
          </Button>
        ))}
      </Group>
      <Group title="À la main">
        <Button onClick={() => run({ type: "start" })}>Démarrer un appel</Button>
        <Button
          variant="secondary"
          disabled={call === null}
          onClick={() => run({ type: "hang-up" })}
        >
          Raccrocher
        </Button>
        <Button variant="secondary" onClick={() => run({ type: "remind" })}>
          Pause oubliée
        </Button>
        <Button variant="ghost" onClick={() => run({ type: "hide" })}>
          Masquer
        </Button>
      </Group>
      <Group title="Vitesse">
        <Choice
          value={String(settings.slow)}
          options={SPEEDS}
          disabled={!view.canSlow}
          onChange={(value) => set({ slow: SLOW[value] })}
        />
      </Group>
      <Group title="Capture">
        <Choice
          value={settings.capture}
          options={CAPTURES}
          onChange={(value) => set({ capture: value })}
        />
      </Group>
      <Group title="App">
        <Choice value={settings.app} options={APPS} onChange={(value) => set({ app: value })} />
      </Group>
      <Group title="Personnes">
        <Choice
          value={String(settings.people)}
          options={["0", "1", "2", "3", "4"].map((value) => ({ value, label: value }))}
          onChange={(value) => set({ people: Number(value) })}
        />
      </Group>
      <Group title="Réglages">
        <SwitchLabel>
          <Switch
            checked={settings.recording}
            onCheckedChange={(recording) => set({ recording })}
          />
          Enregistrement en cours
        </SwitchLabel>
        <SwitchLabel>
          <Switch
            checked={settings.openOnHover}
            onCheckedChange={(openOnHover) => set({ openOnHover })}
          />
          Ouvrir au survol
        </SwitchLabel>
        <SwitchLabel>
          <Switch
            checked={settings.locale === "en"}
            onCheckedChange={(english) => set({ locale: english ? "en" : "fr" })}
          />
          En anglais
        </SwitchLabel>
      </Group>
      <Group title="Journal">
        <ol className="flex w-full flex-col font-data text-body-xs text-cte-text-muted">
          {view.log.map((entry, index) => (
            <li key={`${entry.atMs}-${view.log.length - index}`} className="truncate">
              {new Date(entry.atMs).toISOString().slice(14, 23)} {entry.line}
            </li>
          ))}
        </ol>
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-xs">
      <h2 id={id} className="text-body-s font-medium">
        {title}
      </h2>
      <div className="flex flex-wrap items-center gap-xs">{children}</div>
    </section>
  );
}

function Choice<Value extends string>({
  value,
  options,
  disabled = false,
  onChange,
}: {
  value: string;
  options: readonly { readonly value: Value; readonly label: string }[];
  disabled?: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <ToggleGroup<Value>
      value={options.filter((option) => option.value === value).map((option) => option.value)}
      disabled={disabled}
      onValueChange={([next]) => {
        if (next !== undefined) onChange(next);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem<Value> key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
