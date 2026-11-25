import { useState } from "react";
import { Checkbox, CheckboxLabel } from "../../components/checkbox";
import { Field, FieldError } from "../../components/field";
import { Section, Specimen } from "../section";

const sources = [
  { id: "micro", label: "Micro" },
  { id: "system", label: "Audio système" },
  { id: "iphone", label: "iPhone" },
] as const;

type Source = (typeof sources)[number]["id"];

function SourcesDemo() {
  const [selected, setSelected] = useState<readonly Source[]>(["micro"]);
  const all = selected.length === sources.length;
  const some = selected.length > 0 && !all;
  return (
    <div className="flex flex-col gap-xs">
      <CheckboxLabel>
        <Checkbox
          checked={all}
          indeterminate={some}
          onCheckedChange={(checked) => setSelected(checked ? sources.map(({ id }) => id) : [])}
        />
        Toutes les sources
      </CheckboxLabel>
      <div className="flex flex-col gap-xs ps-xl">
        {sources.map(({ id, label }) => (
          <CheckboxLabel key={id}>
            <Checkbox
              checked={selected.includes(id)}
              onCheckedChange={(checked) =>
                setSelected((current) =>
                  checked ? [...current, id] : current.filter((source) => source !== id),
                )
              }
            />
            {label}
          </CheckboxLabel>
        ))}
      </div>
    </div>
  );
}

export default function CheckboxSection() {
  return (
    <Section id="checkbox" title="Checkbox">
      <Specimen label="Unchecked, checked and indeterminate" className="gap-l">
        <CheckboxLabel>
          <Checkbox />
          Appels FaceTime
        </CheckboxLabel>
        <CheckboxLabel>
          <Checkbox defaultChecked />
          Réunions Zoom
        </CheckboxLabel>
        <CheckboxLabel>
          <Checkbox indeterminate />
          Toutes les applications
        </CheckboxLabel>
      </Specimen>
      <Specimen label="Disabled" className="gap-l">
        <CheckboxLabel>
          <Checkbox disabled />
          Appels FaceTime
        </CheckboxLabel>
        <CheckboxLabel>
          <Checkbox disabled defaultChecked />
          Réunions Zoom
        </CheckboxLabel>
        <CheckboxLabel>
          <Checkbox disabled indeterminate />
          Toutes les applications
        </CheckboxLabel>
      </Specimen>
      <Specimen label="Parent and children" className="items-start">
        <SourcesDemo />
      </Specimen>
      <Specimen label="Invalid" className="items-start">
        <Field name="deleteAudio" invalid className="items-start gap-xs">
          <CheckboxLabel>
            <Checkbox required />
            Supprimer l’audio après transcription
          </CheckboxLabel>
          <FieldError match>Confirmez pour libérer 12 Go.</FieldError>
        </Field>
      </Specimen>
      <Specimen label="Without visible label" className="gap-l">
        <Checkbox aria-label="Sélectionner la conversation avec Camille" />
        <Checkbox aria-label="Sélectionner la conversation avec Léo" defaultChecked />
      </Specimen>
    </Section>
  );
}
