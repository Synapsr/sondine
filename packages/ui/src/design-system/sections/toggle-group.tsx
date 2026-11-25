import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "../../components/toggle-group";
import {
  CalendarIcon,
  ClockIcon,
  MicrophoneIcon,
  PhoneIcon,
  StarIcon,
  VideoIcon,
  VolumeIcon,
} from "../../icon";
import { Section, Specimen } from "../section";

type Source = "micro" | "system" | "iphone";

function SourcesDemo() {
  const [sources, setSources] = useState<Source[]>(["micro", "system"]);
  return (
    <ToggleGroup<Source> multiple value={sources} onValueChange={setSources} aria-label="Sources">
      <ToggleGroupItem<Source> value="micro">
        <MicrophoneIcon />
        Micro
      </ToggleGroupItem>
      <ToggleGroupItem<Source> value="system">
        <VolumeIcon />
        Audio système
      </ToggleGroupItem>
      <ToggleGroupItem<Source> value="iphone">
        <PhoneIcon />
        iPhone
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export default function ToggleGroupSection() {
  return (
    <Section id="toggle-group" title="Toggle group">
      <Specimen label="Single choice">
        <ToggleGroup defaultValue={["week"]} aria-label="Période">
          <ToggleGroupItem value="today">Aujourd’hui</ToggleGroupItem>
          <ToggleGroupItem value="week">Cette semaine</ToggleGroupItem>
          <ToggleGroupItem value="month">Ce mois-ci</ToggleGroupItem>
        </ToggleGroup>
      </Specimen>
      <Specimen label="Multiple choice">
        <ToggleGroup multiple defaultValue={["camille", "ines"]} aria-label="Personnes">
          <ToggleGroupItem value="camille">Camille</ToggleGroupItem>
          <ToggleGroupItem value="leo">Léo</ToggleGroupItem>
          <ToggleGroupItem value="ines">Inès</ToggleGroupItem>
          <ToggleGroupItem value="moi">Moi</ToggleGroupItem>
        </ToggleGroup>
      </Specimen>
      <Specimen label="With icons">
        <SourcesDemo />
      </Specimen>
      <Specimen label="Icon only">
        <ToggleGroup size="icon" multiple defaultValue={["micro"]} aria-label="Sources">
          <ToggleGroupItem value="micro" aria-label="Micro">
            <MicrophoneIcon />
          </ToggleGroupItem>
          <ToggleGroupItem value="system" aria-label="Audio système">
            <VolumeIcon />
          </ToggleGroupItem>
          <ToggleGroupItem value="zoom" aria-label="Zoom">
            <VideoIcon />
          </ToggleGroupItem>
          <ToggleGroupItem value="iphone" aria-label="iPhone">
            <PhoneIcon />
          </ToggleGroupItem>
        </ToggleGroup>
      </Specimen>
      <Specimen label="Vertical">
        <ToggleGroup orientation="vertical" defaultValue={["recent"]} aria-label="Affichage">
          <ToggleGroupItem value="recent">
            <ClockIcon />
            Récentes
          </ToggleGroupItem>
          <ToggleGroupItem value="favorites">
            <StarIcon />
            Favorites
          </ToggleGroupItem>
          <ToggleGroupItem value="calendar">
            <CalendarIcon />
            Calendrier
          </ToggleGroupItem>
        </ToggleGroup>
      </Specimen>
      <Specimen label="Disabled">
        <ToggleGroup disabled defaultValue={["week"]} aria-label="Période">
          <ToggleGroupItem value="today">Aujourd’hui</ToggleGroupItem>
          <ToggleGroupItem value="week">Cette semaine</ToggleGroupItem>
          <ToggleGroupItem value="month">Ce mois-ci</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup multiple defaultValue={["micro"]} aria-label="Sources">
          <ToggleGroupItem value="micro">Micro</ToggleGroupItem>
          <ToggleGroupItem value="system">Audio système</ToggleGroupItem>
          <ToggleGroupItem value="iphone" disabled>
            iPhone
          </ToggleGroupItem>
        </ToggleGroup>
      </Specimen>
    </Section>
  );
}
