import { Field, FieldDescription, FieldError, FieldLabel } from "../../components/field";
import { Fieldset, FieldsetLegend } from "../../components/fieldset";
import { Input } from "../../components/input";
import { Section, Specimen } from "../section";

const fieldsetWidth = "w-[20rem] max-w-full";

export default function FieldsetSection() {
  return (
    <Section id="fieldset" title="Fieldset">
      <Specimen label="Rest, invalid field, disabled" className="items-start gap-xl">
        <Fieldset className={fieldsetWidth}>
          <FieldsetLegend>Intervenant</FieldsetLegend>
          <Field name="firstName">
            <FieldLabel>Prénom</FieldLabel>
            <Input defaultValue="Camille" />
          </Field>
          <Field name="lastName">
            <FieldLabel>Nom</FieldLabel>
            <Input placeholder="Martin" />
            <FieldDescription>Facultatif.</FieldDescription>
          </Field>
        </Fieldset>
        <Fieldset className={fieldsetWidth}>
          <FieldsetLegend>Conservation</FieldsetLegend>
          <Field name="audioDays" invalid>
            <FieldLabel>Audio (jours)</FieldLabel>
            <Input inputMode="numeric" defaultValue="0" />
            <FieldError match>Gardez l’audio au moins 1 jour.</FieldError>
          </Field>
          <Field name="transcriptDays">
            <FieldLabel>Transcriptions (jours)</FieldLabel>
            <Input inputMode="numeric" defaultValue="365" />
          </Field>
        </Fieldset>
        <Fieldset disabled className={fieldsetWidth}>
          <FieldsetLegend>Synchronisation iPhone</FieldsetLegend>
          <Field name="deviceName">
            <FieldLabel>Nom de l’appareil</FieldLabel>
            <Input defaultValue="iPhone de Camille" />
          </Field>
          <Field name="deviceAddress">
            <FieldLabel>Adresse</FieldLabel>
            <Input defaultValue="192.168.1.24" />
            <FieldDescription>Sur le même réseau Wi-Fi que ce Mac.</FieldDescription>
          </Field>
        </Fieldset>
      </Specimen>
    </Section>
  );
}
