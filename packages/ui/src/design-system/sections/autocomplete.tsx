import { Field } from "@base-ui/react/field";
import type { ReactNode } from "react";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteLabel,
  AutocompleteList,
  AutocompletePopup,
  type AutocompleteProps,
} from "../../components/autocomplete";
import { cn } from "../../lib/cn";
import { Section, Specimen } from "../section";

const belowOnly = { side: "none" } as const;

interface Suggestion {
  id: string;
  value: string;
  disabled?: boolean;
}

const suggestions: Suggestion[] = [
  { id: "product", value: "Réunion produit avec Camille" },
  { id: "zoom", value: "Appel Zoom de lundi" },
  { id: "budget", value: "Budget 2027" },
  { id: "hugo", value: "Entretien avec Hugo" },
  { id: "train", value: "Notes du trajet en train", disabled: true },
  { id: "weekly", value: "Point hebdo de l'équipe" },
];

interface DemoProps extends Omit<AutocompleteProps<Suggestion>, "items" | "children"> {
  /**
   * Leaves room under the input and keeps the open popup there. Base UI keeps a
   * flipped popup above while it fits, which would cover the specimens above.
   */
  reserveSpace?: boolean;
}

function Demo({ reserveSpace = false, ...props }: DemoProps) {
  return (
    <div
      className={cn("flex w-[20rem] max-w-full flex-col gap-xs", reserveSpace && "min-h-[21rem]")}
    >
      <Autocomplete items={suggestions} {...props}>
        <AutocompleteLabel>Recherche</AutocompleteLabel>
        <AutocompleteInput placeholder="Rechercher dans vos conversations" />
        <AutocompletePopup collisionAvoidance={reserveSpace ? belowOnly : undefined}>
          <AutocompleteEmpty>Aucune conversation ne correspond</AutocompleteEmpty>
          <AutocompleteList>
            {(suggestion: Suggestion) => (
              <AutocompleteItem
                key={suggestion.id}
                value={suggestion}
                disabled={suggestion.disabled}
              >
                {suggestion.value}
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompletePopup>
      </Autocomplete>
    </div>
  );
}

function Invalid({ children }: { children: ReactNode }) {
  return (
    <Field.Root invalid className="contents">
      {children}
    </Field.Root>
  );
}

export default function AutocompleteSection() {
  return (
    <Section id="autocomplete" title="Autocomplete">
      <Specimen label="Placeholder and value" className="items-start gap-l">
        <Demo />
        <Demo defaultValue="Budget 2027" />
      </Specimen>
      <Specimen label="Disabled" className="items-start gap-l">
        <Demo disabled />
        <Demo defaultValue="Budget 2027" disabled />
      </Specimen>
      <Specimen label="Invalid" className="items-start gap-l">
        <Invalid>
          <Demo defaultValue="Budget 2027" />
        </Invalid>
      </Specimen>
      <Specimen
        label="Open: highlighted on hover, disabled option; no results"
        className="items-start gap-l"
      >
        <Demo defaultOpen reserveSpace />
        <Demo defaultValue="Webex" defaultOpen reserveSpace />
      </Specimen>
    </Section>
  );
}
