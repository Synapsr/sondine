import { Field } from "@base-ui/react/field";
import type { ReactNode } from "react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxPopup,
  type ComboboxProps,
  ComboboxTrigger,
} from "../../components/combobox";
import { cn } from "../../lib/cn";
import { Section, Specimen } from "../section";

const belowOnly = { side: "none" } as const;

interface Person {
  value: string;
  label: string;
  disabled?: boolean;
}

const camille: Person = { value: "camille", label: "Camille Martin" };
const lea: Person = { value: "lea", label: "Léa Bernard" };

const people: Person[] = [
  camille,
  lea,
  { value: "hugo", label: "Hugo Petit" },
  { value: "ines", label: "Inès Moreau" },
  { value: "thomas", label: "Thomas Dubois", disabled: true },
  { value: "chloe", label: "Chloé Laurent" },
];

interface DemoProps extends Omit<ComboboxProps<Person>, "items" | "children"> {
  /**
   * Leaves room under the field and keeps the open popup there. Base UI keeps a
   * flipped popup above while it fits, which would cover the specimens above.
   */
  reserveSpace?: boolean;
}

function Demo({ reserveSpace = false, ...props }: DemoProps) {
  return (
    <div
      className={cn("flex w-[20rem] max-w-full flex-col gap-xs", reserveSpace && "min-h-[21rem]")}
    >
      <Combobox items={people} {...props}>
        <ComboboxLabel>Attribuer à</ComboboxLabel>
        <ComboboxInputGroup>
          <ComboboxInput placeholder="Rechercher une personne" />
          <ComboboxTrigger aria-label="Afficher les personnes" />
        </ComboboxInputGroup>
        <ComboboxPopup collisionAvoidance={reserveSpace ? belowOnly : undefined}>
          <ComboboxEmpty>Aucune personne trouvée</ComboboxEmpty>
          <ComboboxList>
            {(person: Person) => (
              <ComboboxItem key={person.value} value={person} disabled={person.disabled}>
                {person.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
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

export default function ComboboxSection() {
  return (
    <Section id="combobox" title="Combobox">
      <Specimen label="Placeholder and value" className="items-start gap-l">
        <Demo />
        <Demo defaultValue={camille} />
      </Specimen>
      <Specimen label="Disabled" className="items-start gap-l">
        <Demo disabled />
        <Demo defaultValue={camille} disabled />
      </Specimen>
      <Specimen label="Invalid" className="items-start gap-l">
        <Invalid>
          <Demo />
        </Invalid>
      </Specimen>
      <Specimen
        label="Open: selected, highlighted on hover, disabled option; no results"
        className="items-start gap-l"
      >
        <Demo defaultValue={lea} defaultOpen reserveSpace />
        <Demo defaultInputValue="Zoé" defaultOpen reserveSpace />
      </Specimen>
    </Section>
  );
}
