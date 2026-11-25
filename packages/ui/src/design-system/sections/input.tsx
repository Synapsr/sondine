import { useEffect, useRef } from "react";
import { Field, type FieldActions, FieldLabel } from "../../components/field";
import { Input } from "../../components/input";
import { Section, Specimen } from "../section";

const fieldWidth = "w-[17.5rem] max-w-full";

// Runs the field's real validation once, so the valid state shows without typing.
function ValidatedEmail() {
  const actions = useRef<FieldActions>(null);
  useEffect(() => {
    actions.current?.validate();
  }, []);
  return (
    <Field actionsRef={actions} className={fieldWidth}>
      <FieldLabel>Adresse e-mail</FieldLabel>
      <Input type="email" required defaultValue="camille.martin@exemple.fr" />
    </Field>
  );
}

export default function InputSection() {
  return (
    <Section id="input" title="Input">
      <Specimen label="Rest" className="items-start gap-l">
        <Field className={fieldWidth}>
          <FieldLabel>Recherche</FieldLabel>
          <Input type="search" placeholder="Rechercher dans vos conversations" />
        </Field>
        <Field className={fieldWidth}>
          <FieldLabel>Titre</FieldLabel>
          <Input defaultValue="Point hebdo avec Camille" />
        </Field>
      </Specimen>
      <Specimen label="Read-only" className="items-start gap-l">
        <Field className={fieldWidth}>
          <FieldLabel>Source</FieldLabel>
          <Input readOnly defaultValue="Zoom" />
        </Field>
      </Specimen>
      <Specimen label="Disabled" className="items-start gap-l">
        <Field disabled className={fieldWidth}>
          <FieldLabel>Dossier</FieldLabel>
          <Input defaultValue="Réunions clients" />
        </Field>
        <Field disabled className={fieldWidth}>
          <FieldLabel>Appareil</FieldLabel>
          <Input placeholder="Nom de l’appareil" />
        </Field>
      </Specimen>
      <Specimen label="Invalid and valid" className="items-start gap-l">
        <Field invalid className={fieldWidth}>
          <FieldLabel>Conservation</FieldLabel>
          <Input defaultValue="0 jour" />
        </Field>
        <ValidatedEmail />
      </Specimen>
      <Specimen label="Without a visible label" className="items-start">
        <Input
          type="search"
          aria-label="Rechercher"
          placeholder="Rechercher dans vos conversations"
          className="w-[24rem] max-w-full"
        />
      </Specimen>
    </Section>
  );
}
