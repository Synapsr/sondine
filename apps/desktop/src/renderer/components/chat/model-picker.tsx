import type { ChatChoice, ChatProvider } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@sondine/ui/components/menu";
import { ChevronDownIcon } from "@sondine/ui/icon";
import { m } from "../../paraglide/messages.js";

// The model and how hard it thinks, for the next message (ADR 027): the
// models the signed-in CLI offers, and the effort levels of the one chosen.

const EFFORTS: Readonly<Record<string, () => string>> = {
  low: m.chat_effort_low,
  medium: m.chat_effort_medium,
  high: m.chat_effort_high,
  xhigh: m.chat_effort_xhigh,
  max: m.chat_effort_max,
};

export const effortLabel = (effort: string) => EFFORTS[effort]?.() ?? effort;

/** The choice to start from: the last one when the model still exists, else the provider's default. */
export function initialChoice(provider: ChatProvider, last: ChatChoice | null): ChatChoice | null {
  const model =
    provider.models.find((candidate) => candidate.id === last?.model) ??
    provider.models.find((candidate) => candidate.isDefault) ??
    provider.models[0];
  if (model === undefined) return null;
  const effort =
    last !== null &&
    last.model === model.id &&
    last.effort !== null &&
    model.efforts.includes(last.effort)
      ? last.effort
      : model.defaultEffort;
  return { provider: provider.id, model: model.id, effort };
}

export function ModelPicker({
  provider,
  choice,
  onChange,
  disabled,
}: {
  provider: ChatProvider;
  choice: ChatChoice;
  onChange: (choice: ChatChoice) => void;
  disabled: boolean;
}) {
  const model = provider.models.find((candidate) => candidate.id === choice.model);
  const label = [
    model?.name ?? choice.model,
    choice.effort === null ? null : effortLabel(choice.effort),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        aria-label={m.chat_model_label()}
        render={<Button variant="ghost" />}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuGroup>
          <MenuGroupLabel>{m.chat_model_group()}</MenuGroupLabel>
          <MenuRadioGroup
            value={choice.model}
            onValueChange={(id: string) => {
              const next = provider.models.find((candidate) => candidate.id === id);
              if (next === undefined) return;
              const effort =
                choice.effort !== null && next.efforts.includes(choice.effort)
                  ? choice.effort
                  : next.defaultEffort;
              onChange({ ...choice, model: next.id, effort });
            }}
          >
            {provider.models.map((candidate) => (
              <MenuRadioItem key={candidate.id} value={candidate.id} label={candidate.name}>
                <span className="flex min-w-0 flex-col">
                  <span>{candidate.name}</span>
                  {candidate.description === null ? null : (
                    <span className="truncate text-body-xs text-cte-text-muted">
                      {candidate.description}
                    </span>
                  )}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {model === undefined || model.efforts.length === 0 ? null : (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{m.chat_effort_group()}</MenuGroupLabel>
              <MenuRadioGroup
                value={choice.effort ?? ""}
                onValueChange={(effort: string) => onChange({ ...choice, effort })}
              >
                {model.efforts.map((effort) => (
                  <MenuRadioItem key={effort} value={effort}>
                    {effortLabel(effort)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
