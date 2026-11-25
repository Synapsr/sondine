import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "../../components/field";
import { Fieldset, FieldsetLegend } from "../../components/fieldset";
import { Form, FormStatus } from "../../components/form";
import { Input } from "../../components/input";
import { Section, Specimen } from "../section";

const formWidth = "w-[20rem] max-w-full";

interface PersonValues {
  name: string;
  email: string;
}

// Demo only: the submission resolves after a short delay.
function AddPersonForm() {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Form<PersonValues>
      aria-label="Ajouter une personne"
      className={formWidth}
      onFormSubmit={(values) => {
        setPending(true);
        setStatus("");
        timer.current = setTimeout(() => {
          setPending(false);
          setStatus(`${values.name} a été ajoutée.`);
        }, 1500);
      }}
    >
      <Field name="name">
        <FieldLabel>Nom</FieldLabel>
        <Input required placeholder="Camille Martin" autoComplete="off" />
        <FieldError match="valueMissing">Indiquez un nom.</FieldError>
      </Field>
      <Field name="email">
        <FieldLabel>Adresse e-mail</FieldLabel>
        <Input type="email" placeholder="camille.martin@exemple.fr" autoComplete="off" />
        <FieldDescription>Facultatif.</FieldDescription>
        <FieldError match="typeMismatch">Adresse e-mail invalide.</FieldError>
      </Field>
      <Button type="submit" isPending={pending} className="self-start">
        Enregistrer
      </Button>
      <FormStatus>{status}</FormStatus>
    </Form>
  );
}

export default function FormSection() {
  return (
    <Section id="form" title="Form">
      <Specimen label="Submission (submit empty to validate)" className="items-start gap-xl">
        <AddPersonForm />
        <Form
          aria-label="Renommer l’intervenant"
          className={formWidth}
          errors={{ speaker: "Ce nom est déjà attribué à un autre intervenant." }}
        >
          <Field name="speaker">
            <FieldLabel>Intervenant</FieldLabel>
            <Input defaultValue="Camille Martin" />
            <FieldError />
          </Field>
          <Button type="submit" className="self-start">
            Renommer
          </Button>
        </Form>
      </Specimen>
      <Specimen label="Pending and disabled" className="items-start gap-xl">
        <Form aria-label="Exporter la transcription" className={formWidth}>
          <Field name="fileName">
            <FieldLabel>Nom du fichier</FieldLabel>
            <Input defaultValue="point-hebdo-camille.txt" />
          </Field>
          <Button type="submit" isPending className="self-start">
            Exporter
          </Button>
        </Form>
        <Form aria-label="Jumeler un iPhone" className={formWidth}>
          <Fieldset disabled>
            <FieldsetLegend>Jumeler un iPhone</FieldsetLegend>
            <Field name="code">
              <FieldLabel>Code de jumelage</FieldLabel>
              <Input placeholder="6 chiffres" inputMode="numeric" />
              <FieldDescription>Affiché dans Sondine sur l’iPhone.</FieldDescription>
            </Field>
          </Fieldset>
          <Button type="submit" disabled className="self-start">
            Jumeler
          </Button>
          <FormStatus>Ouvrez Sondine sur l’iPhone pour continuer.</FormStatus>
        </Form>
      </Specimen>
    </Section>
  );
}
