import { Tabs, TabsList, TabsPanel, TabsTab } from "../../components/tabs";
import {
  ChipIcon,
  MicrophoneIcon,
  ShieldIcon,
  SparkleIcon,
  UsersIcon,
  WaveformIcon,
} from "../../icon";
import { Section, Specimen } from "../section";

const panelWidth = "w-[24rem] max-w-full";

export default function TabsSection() {
  return (
    <Section id="tabs" title="Tabs">
      <Specimen label="Default" className="items-start">
        <Tabs defaultValue="transcript" className={panelWidth}>
          <TabsList>
            <TabsTab value="transcript">Transcription</TabsTab>
            <TabsTab value="summary">Résumé</TabsTab>
            <TabsTab value="speakers">Intervenants</TabsTab>
          </TabsList>
          <TabsPanel value="transcript">Réunion Zoom avec Camille et Léo, 42 minutes.</TabsPanel>
          <TabsPanel value="summary">Trois décisions et deux actions à suivre.</TabsPanel>
          <TabsPanel value="speakers">Camille, Léo et vous.</TabsPanel>
        </Tabs>
      </Specimen>
      <Specimen label="With icons" className="items-start">
        <Tabs defaultValue="summary" className={panelWidth}>
          <TabsList>
            <TabsTab value="transcript">
              <WaveformIcon />
              Transcription
            </TabsTab>
            <TabsTab value="summary">
              <SparkleIcon />
              Résumé
            </TabsTab>
            <TabsTab value="speakers">
              <UsersIcon />
              Intervenants
            </TabsTab>
          </TabsList>
          <TabsPanel value="transcript">Réunion Zoom avec Camille et Léo, 42 minutes.</TabsPanel>
          <TabsPanel value="summary">Trois décisions et deux actions à suivre.</TabsPanel>
          <TabsPanel value="speakers">Camille, Léo et vous.</TabsPanel>
        </Tabs>
      </Specimen>
      <Specimen label="Disabled tab" className="items-start">
        <Tabs defaultValue="today" className={panelWidth}>
          <TabsList>
            <TabsTab value="today">Aujourd’hui</TabsTab>
            <TabsTab value="week">Cette semaine</TabsTab>
            <TabsTab value="iphone" disabled>
              iPhone
            </TabsTab>
          </TabsList>
          <TabsPanel value="today">6 conversations, 3 h 12 d’écoute.</TabsPanel>
          <TabsPanel value="week">31 conversations, 14 h d’écoute.</TabsPanel>
          <TabsPanel value="iphone">Jumelez un iPhone pour voir ses enregistrements.</TabsPanel>
        </Tabs>
      </Specimen>
      <Specimen label="Vertical" className="items-start">
        <Tabs defaultValue="listening" orientation="vertical" className="w-[32rem] max-w-full">
          <TabsList>
            <TabsTab value="listening">
              <MicrophoneIcon />
              Écoute
            </TabsTab>
            <TabsTab value="models">
              <ChipIcon />
              Modèles
            </TabsTab>
            <TabsTab value="privacy">
              <ShieldIcon />
              Confidentialité
            </TabsTab>
          </TabsList>
          <TabsPanel value="listening">Micro et audio système, en continu.</TabsPanel>
          <TabsPanel value="models">Transcription et diarisation sur cet ordinateur.</TabsPanel>
          <TabsPanel value="privacy">Rien ne quitte votre Mac.</TabsPanel>
        </Tabs>
      </Specimen>
    </Section>
  );
}
