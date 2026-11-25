import { Progress, ProgressLabel, ProgressValue } from "../../components/progress";
import { Section, Specimen } from "../section";

const width = "w-[20rem] max-w-full";

const tasks = [
  { label: "Import de l’enregistrement", value: 8 },
  { label: "Transcription de la réunion", value: 64 },
  { label: "Analyse des intervenants", value: 100 },
] as const;

export default function ProgressSection() {
  return (
    <Section id="progress" title="Progress">
      <Specimen label="Determinate, complete" className="items-start gap-l">
        {tasks.map(({ label, value }) => (
          <Progress key={label} value={value} className={width}>
            <ProgressLabel>{label}</ProgressLabel>
            <ProgressValue />
          </Progress>
        ))}
      </Specimen>
      <Specimen label="Indeterminate, without heading" className="items-start gap-l">
        <Progress value={null} aria-valuetext="En cours" className={width}>
          <ProgressLabel>Préparation du modèle</ProgressLabel>
          <ProgressValue>
            {(formatted, value) => (value === null ? "En cours" : formatted)}
          </ProgressValue>
        </Progress>
        <Progress
          value={null}
          aria-label="Préparation du modèle"
          aria-valuetext="En cours"
          className={width}
        />
        <Progress value={42} aria-label="Transcription de la réunion" className={width} />
      </Specimen>
      <Specimen label="Disabled" className="items-start gap-l">
        <Progress value={64} disabled className={width}>
          <ProgressLabel>Transcription en pause</ProgressLabel>
          <ProgressValue />
        </Progress>
      </Specimen>
    </Section>
  );
}
