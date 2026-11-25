import { Field, FieldDescription, FieldError, FieldLabel } from "../../components/field";
import { Input } from "../../components/input";
import { Section, Specimen } from "../section";

const fieldWidth = "w-[17.5rem] max-w-full";

export default function FieldSection() {
  return (
    <Section id="field" title="Field">
      <Specimen label="Label, control and description" className="items-start gap-l">
        <Field name="displayName" className={fieldWidth}>
          <FieldLabel>Nom affiché</FieldLabel>
          <Input placeholder="Camille Martin" />
          <FieldDescription>Utilisé dans vos transcriptions et vos recherches.</FieldDescription>
        </Field>
        <Field name="displayNameFilled" className={fieldWidth}>
          <FieldLabel>Nom affiché</FieldLabel>
          <Input defaultValue="Camille Martin" />
          <FieldDescription>Utilisé dans vos transcriptions et vos recherches.</FieldDescription>
        </Field>
      </Specimen>
      <Specimen label="Validation on blur, and from the app" className="items-start gap-l">
        <Field name="meetingLink" validationMode="onBlur" className={fieldWidth}>
          <FieldLabel>Lien de la réunion</FieldLabel>
          <Input type="url" placeholder="https://zoom.us/j/…" />
          <FieldDescription>Associe l’enregistrement à la réunion.</FieldDescription>
          <FieldError match="typeMismatch">Saisissez un lien complet.</FieldError>
        </Field>
        <Field name="speakerTaken" invalid className={fieldWidth}>
          <FieldLabel>Intervenant</FieldLabel>
          <Input defaultValue="Camille Martin" />
          <FieldDescription>Le nom remplace « Intervenant 2 ».</FieldDescription>
          <FieldError match>Ce nom est déjà attribué à un autre intervenant.</FieldError>
        </Field>
      </Specimen>
      <Specimen label="Read-only and disabled" className="items-start gap-l">
        <Field name="app" className={fieldWidth}>
          <FieldLabel>Application</FieldLabel>
          <Input readOnly defaultValue="Zoom" />
          <FieldDescription>Détectée au début de l’enregistrement.</FieldDescription>
        </Field>
        <Field name="device" disabled className={fieldWidth}>
          <FieldLabel>Appareil</FieldLabel>
          <Input defaultValue="iPhone de Camille" />
          <FieldDescription>Disponible une fois l’iPhone jumelé.</FieldDescription>
          <FieldError match>Appareil introuvable sur le réseau local.</FieldError>
        </Field>
      </Specimen>
    </Section>
  );
}
