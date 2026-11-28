import { cn, useTheme } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@sondine/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@sondine/ui/components/toggle-group";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  XIcon,
} from "@sondine/ui/icon";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  findStep,
  LAB_JOURNEYS,
  SITUATION_LABELS,
  WINDOW_SIZES,
  type LabCommand,
  type LabSituation,
  type LabSituationKey,
  type LabView,
} from "../../shared/flow-lab";
import { useLocale } from "../i18n/locale";
import { runClicks } from "./lab-clicks";

// Development only (flow-lab-root.tsx): the flow lab's HUD (ADR 049). Fixed
// over the window, so folded it changes nothing of the app's layout; ⌃⌥⌘L
// folds and unfolds it. Not translated, like the design system page.

const OPEN_KEY = "sondine.dev.flow-lab-open";
const CLICKED_KEY = "sondine.dev.flow-lab-clicked";

const STEPS = LAB_JOURNEYS.flatMap((journey) =>
  journey.steps.map((step) => ({
    value: `${journey.id}/${step.id}`,
    label: `${journey.title} › ${step.title}`,
  })),
);

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function FlowLabHud() {
  const bridge = window.sondine.flowLab;
  const [view, setView] = useState<LabView | null>(null);
  const [open, setOpen] = useState(readOpen);
  const [clickProblem, setClickProblem] = useState<string | null>(null);

  useEffect(() => {
    if (bridge === undefined) return;
    void bridge.run(null).then(setView);
    return bridge.onChange(setView);
  }, [bridge]);

  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && event.metaKey && event.code === "KeyL") {
        event.preventDefault();
        setOpen((was) => !was);
      }
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      // The HUD opens unfolded next time.
    }
  }, [open]);

  // Two labs side by side: the window's title says which one this is.
  const label = view?.label ?? null;
  useEffect(() => {
    if (label !== null) document.title = `Sondine · Labo ${label}`;
  }, [label]);

  // A step put back makes its clicks once, on its fresh page.
  const found = view === null ? null : findStep(view.position.journey, view.position.step);
  useEffect(() => {
    if (view === null || view.busy || found === null) return;
    // The page left behind hears of the step too, before it reloads.
    if (performance.timeOrigin < view.loadedAtMs) return;
    if (sessionStorage.getItem(CLICKED_KEY) === String(view.generation)) return;
    sessionStorage.setItem(CLICKED_KEY, String(view.generation));
    const clicks = found.step.clicks ?? [];
    if (clicks.length === 0) return;
    setClickProblem(null);
    void runClicks(clicks).catch((error: unknown) =>
      setClickProblem(error instanceof Error ? error.message : String(error)),
    );
  }, [view, found]);

  if (bridge === undefined || view === null || found === null) return null;
  const run = (command: LabCommand) =>
    void bridge.run(command).then((next) => {
      if (next !== null) setView(next);
    });
  const { journey, step, index } = found;

  if (!open) {
    return (
      <div className="fixed right-l bottom-l z-[100]">
        <Button
          variant="secondary"
          aria-expanded={false}
          title="Labo des parcours (⌃⌥⌘L)"
          onClick={() => setOpen(true)}
          className="shadow-m"
        >
          <ChevronUpIcon />
          {view.label === null ? null : `${view.label} · `}
          {step.title}
        </Button>
      </div>
    );
  }

  const busy = view.busy;
  const problem = view.problem ?? clickProblem;
  return (
    <section
      aria-label="Labo des parcours"
      aria-busy={busy}
      className="fixed right-l bottom-l z-[100] flex max-h-[calc(100dvh-4rem)] w-[21rem] flex-col gap-m overflow-y-auto corner-l bg-cte-surface p-m text-cte-text shadow-m ring-s ring-cte-border"
    >
      <header className="flex items-start gap-s">
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-body-xs text-cte-text-muted">
            {view.label === null ? null : `Labo ${view.label} · `}
            {journey.title} · {index + 1} / {journey.steps.length}
          </p>
          <h2 className="text-body-m font-medium">{step.title}</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Replier (⌃⌥⌘L)"
          aria-expanded
          onClick={() => setOpen(false)}
        >
          <XIcon />
        </Button>
      </header>

      {step.note === undefined ? null : (
        <p className="text-body-s text-cte-text-muted">{step.note}</p>
      )}
      {view.last && !busy ? <p className="text-body-s font-medium">Parcours terminé.</p> : null}
      {problem === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {problem}
        </p>
      )}

      <div className="flex flex-wrap gap-xs">
        <Button
          variant="secondary"
          size="icon"
          aria-label="Étape précédente"
          disabled={busy || index === 0}
          onClick={() => run({ type: "previous" })}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant={view.last ? "secondary" : "primary"}
          size="icon"
          aria-label="Étape suivante"
          disabled={busy || view.last}
          isPending={busy}
          onClick={() => run({ type: "next" })}
        >
          <ChevronRightIcon />
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => run({ type: "replay" })}>
          Rejouer
        </Button>
        <Button
          variant={view.last ? "primary" : "ghost"}
          disabled={busy}
          onClick={() => run({ type: "restart" })}
        >
          Recommencer
        </Button>
      </div>

      <Select
        items={STEPS}
        value={`${journey.id}/${step.id}`}
        disabled={busy}
        onValueChange={(value) => {
          const [journeyId, stepId] = String(value).split("/");
          if (journeyId !== undefined && stepId !== undefined)
            run({ type: "go", journey: journeyId, step: stepId });
        }}
      >
        <SelectTrigger aria-label="Aller à une étape">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {STEPS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      {(step.offers ?? []).length === 0 ? null : (
        <Group title="Variantes">
          {(step.offers ?? []).map((key) => (
            <SituationChoice
              key={key}
              part={key}
              situation={view.situation}
              disabled={busy}
              onChange={(situation) => run({ type: "situation", situation })}
            />
          ))}
        </Group>
      )}

      <Display busy={busy} onSize={(width, height) => run({ type: "size", width, height })} />
    </section>
  );
}

function SituationChoice<Key extends LabSituationKey>({
  part,
  situation,
  disabled,
  onChange,
}: {
  part: Key;
  situation: LabSituation;
  disabled: boolean;
  onChange: (situation: Partial<LabSituation>) => void;
}) {
  const { label, values } = SITUATION_LABELS[part];
  const options = Object.entries(values).map(([value, text]) => ({ value, label: String(text) }));
  return (
    <Choice
      label={label}
      value={situation[part]}
      options={options}
      disabled={disabled}
      onChange={(value) => onChange({ [part]: value })}
    />
  );
}

function Display({
  busy,
  onSize,
}: {
  busy: boolean;
  onSize: (width: number, height: number) => void;
}) {
  const { locale, setLocale } = useLocale();
  const { theme, setTheme } = useTheme();
  const [size, setSize] = useState<string>(`${window.outerWidth}×${window.outerHeight}`);
  const [shown, setShown] = useState(false);
  if (!shown) {
    return (
      <Button
        variant="ghost"
        className="self-start"
        aria-expanded={false}
        onClick={() => setShown(true)}
      >
        Langue, thème, fenêtre
        <ChevronDownIcon />
      </Button>
    );
  }
  return (
    <Group title="Affichage">
      <Choice
        label="Langue"
        value={locale}
        options={[
          { value: "fr", label: "FR" },
          { value: "en", label: "EN" },
        ]}
        onChange={(value) => {
          if (value === "fr" || value === "en") setLocale(value);
        }}
      />
      <Choice
        label="Thème"
        value={theme === "system" ? "" : theme}
        options={[
          { value: "light", label: "Clair" },
          { value: "dark", label: "Sombre" },
        ]}
        onChange={(value) => {
          if (value === "light" || value === "dark") setTheme(value);
        }}
      />
      <Choice
        label="Fenêtre"
        value={size}
        disabled={busy}
        options={WINDOW_SIZES.map(({ width, height }) => ({
          value: `${width}×${height}`,
          label: `${width}×${height}`,
        }))}
        onChange={(value) => {
          const chosen = WINDOW_SIZES.find((one) => `${one.width}×${one.height}` === value);
          if (chosen === undefined) return;
          setSize(value);
          onSize(chosen.width, chosen.height);
        }}
      />
    </Group>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-xs">
      <h3 id={id} className="text-body-xs text-cte-text-muted">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-s">{children}</div>
    </section>
  );
}

function Choice({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { readonly value: string; readonly label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-xxs",
        (options.length > 2 || options.some((option) => option.label.length > 8)) && "col-span-2",
      )}
    >
      <span className="text-body-xs text-cte-text-muted">{label}</span>
      <ToggleGroup
        aria-label={label}
        className="flex-wrap"
        value={options.some((option) => option.value === value) ? [value] : []}
        disabled={disabled}
        onValueChange={([next]) => {
          if (next !== undefined && next !== value) onChange(next);
        }}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
