import { Field, FieldError } from "../../components/field";
import { Switch, SwitchLabel } from "../../components/switch";
import { Section, Specimen } from "../section";

export default function SwitchSection() {
  return (
    <Section id="switch" title="Switch">
      <Specimen label="Unchecked and checked" className="gap-l">
        <SwitchLabel>
          <Switch />
          Démarrer avec la session
        </SwitchLabel>
        <SwitchLabel>
          <Switch defaultChecked />
          Écoute en continu
        </SwitchLabel>
      </Specimen>
      <Specimen label="Disabled and read-only" className="gap-l">
        <SwitchLabel>
          <Switch disabled />
          Synchroniser l’iPhone
        </SwitchLabel>
        <SwitchLabel>
          <Switch disabled defaultChecked />
          Transcription en direct
        </SwitchLabel>
        <SwitchLabel>
          <Switch readOnly defaultChecked />
          Chiffrement local
        </SwitchLabel>
      </Specimen>
      <Specimen label="Invalid" className="items-start">
        <Field name="recordingConsent" invalid className="items-start gap-xs">
          <SwitchLabel>
            <Switch required />
            Prévenir les participants
          </SwitchLabel>
          <FieldError match>Activez-le pour enregistrer les appels Zoom.</FieldError>
        </Field>
      </Specimen>
      <Specimen label="Without visible label" className="gap-l">
        <Switch aria-label="Mettre en pause l’écoute" />
        <Switch aria-label="Micro" defaultChecked />
      </Specimen>
    </Section>
  );
}
