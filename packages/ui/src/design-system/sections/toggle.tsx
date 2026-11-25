import { useState } from "react";
import { Toggle } from "../../components/toggle";
import {
  BookmarkIcon,
  EyeOffIcon,
  MicrophoneIcon,
  MicrophoneOffIcon,
  SparkleIcon,
  StarIcon,
} from "../../icon";
import { Section, Specimen } from "../section";

function MuteDemo() {
  const [muted, setMuted] = useState(false);
  return (
    <Toggle pressed={muted} onPressedChange={setMuted}>
      {muted ? <MicrophoneOffIcon /> : <MicrophoneIcon />}
      Couper le micro
    </Toggle>
  );
}

export default function ToggleSection() {
  return (
    <Section id="toggle" title="Toggle">
      <Specimen label="Off and on">
        <Toggle>Épingler</Toggle>
        <Toggle defaultPressed>Épingler</Toggle>
        <Toggle>
          <StarIcon />
          Favori
        </Toggle>
        <Toggle defaultPressed>
          <StarIcon />
          Favori
        </Toggle>
      </Specimen>
      <Specimen label="Icon only">
        <Toggle size="icon" aria-label="Favori">
          <StarIcon />
        </Toggle>
        <Toggle size="icon" aria-label="Favori" defaultPressed>
          <StarIcon />
        </Toggle>
        <Toggle size="icon" aria-label="Marquer le moment">
          <BookmarkIcon />
        </Toggle>
        <Toggle size="icon" aria-label="Marquer le moment" defaultPressed>
          <BookmarkIcon />
        </Toggle>
      </Specimen>
      <Specimen label="Disabled">
        <Toggle disabled>Épingler</Toggle>
        <Toggle disabled defaultPressed>
          Épingler
        </Toggle>
        <Toggle disabled>
          <SparkleIcon />
          Résumé auto
        </Toggle>
        <Toggle size="icon" aria-label="Masquer les noms" disabled>
          <EyeOffIcon />
        </Toggle>
        <Toggle size="icon" aria-label="Masquer les noms" disabled defaultPressed>
          <EyeOffIcon />
        </Toggle>
      </Specimen>
      <Specimen label="Controlled">
        <MuteDemo />
      </Specimen>
    </Section>
  );
}
