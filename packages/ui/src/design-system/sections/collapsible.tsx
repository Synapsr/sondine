import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/collapsible";
import { Section, Specimen } from "../section";

const specimenClassName = "w-[20rem] max-w-full flex-col items-stretch";

function RecordingDetails({
  defaultOpen,
  disabled,
}: {
  defaultOpen?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} disabled={disabled}>
      <CollapsibleTrigger>Détails de l’enregistrement</CollapsibleTrigger>
      <CollapsiblePanel>
        <p>Micro intégré · 48 kHz</p>
        <p>Début 9 h 41 · durée 48 min</p>
        <p>Transcrit sur ce Mac</p>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export default function CollapsibleSection() {
  return (
    <Section id="collapsible" title="Collapsible">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] items-start gap-xl">
        <Specimen label="Closed" className={specimenClassName}>
          <RecordingDetails />
        </Specimen>
        <Specimen label="Open" className={specimenClassName}>
          <RecordingDetails defaultOpen />
        </Specimen>
        <Specimen label="Disabled" className={specimenClassName}>
          <RecordingDetails disabled />
        </Specimen>
        <Specimen label="Disabled, open" className={specimenClassName}>
          <Collapsible defaultOpen disabled>
            <CollapsibleTrigger>Transcription en cours</CollapsibleTrigger>
            <CollapsiblePanel>
              La transcription de l’appel Zoom avec Léo sera prête dans quelques minutes.
            </CollapsiblePanel>
          </Collapsible>
        </Specimen>
      </div>
    </Section>
  );
}
