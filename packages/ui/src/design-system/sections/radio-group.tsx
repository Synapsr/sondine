import { Field, FieldError } from "../../components/field";
import { Radio, RadioGroup, RadioLabel } from "../../components/radio-group";
import { Section, Specimen } from "../section";

export default function RadioGroupSection() {
  return (
    <Section id="radio-group" title="Radio group">
      <Specimen label="Rows" className="items-start gap-xl">
        <div className="flex flex-col gap-xs">
          <span id="radio-quality" className="font-body font-medium text-body-s text-neutral-10">
            Qualité de transcription
          </span>
          <RadioGroup aria-labelledby="radio-quality" defaultValue="balanced">
            <RadioLabel>
              <Radio value="fast" />
              Rapide
            </RadioLabel>
            <RadioLabel>
              <Radio value="balanced" />
              Équilibrée
            </RadioLabel>
            <RadioLabel>
              <Radio value="precise" />
              Précise
            </RadioLabel>
          </RadioGroup>
        </div>
        <div className="flex flex-col gap-xs">
          <span id="radio-source" className="font-body font-medium text-body-s text-neutral-10">
            Source
          </span>
          <RadioGroup aria-labelledby="radio-source" defaultValue="mac">
            <RadioLabel>
              <Radio value="mac" />
              Micro du Mac
            </RadioLabel>
            <RadioLabel>
              <Radio value="airpods" />
              AirPods de Camille
            </RadioLabel>
            <RadioLabel>
              <Radio value="iphone" disabled />
              iPhone (non jumelé)
            </RadioLabel>
          </RadioGroup>
        </div>
      </Specimen>
      <Specimen label="Disabled group" className="items-start">
        <RadioGroup aria-label="Conservation de l’audio" defaultValue="30" disabled>
          <RadioLabel>
            <Radio value="7" />7 jours
          </RadioLabel>
          <RadioLabel>
            <Radio value="30" />
            30 jours
          </RadioLabel>
        </RadioGroup>
      </Specimen>
      <Specimen label="Plain labels" className="items-start">
        <RadioGroup aria-label="Langue" defaultValue="fr">
          <RadioLabel variant="plain">
            <Radio value="fr" />
            Français
          </RadioLabel>
          <RadioLabel variant="plain">
            <Radio value="en" />
            Anglais
          </RadioLabel>
          <RadioLabel variant="plain">
            <Radio value="auto" disabled />
            Détection automatique
          </RadioLabel>
        </RadioGroup>
      </Specimen>
      <Specimen label="Invalid" className="items-start">
        <Field name="speaker" invalid className="items-start gap-xs">
          <RadioGroup aria-label="Intervenant" required>
            <RadioLabel>
              <Radio value="camille" />
              Camille
            </RadioLabel>
            <RadioLabel>
              <Radio value="leo" />
              Léo
            </RadioLabel>
          </RadioGroup>
          <FieldError match>Choisissez qui parle dans cet extrait.</FieldError>
        </Field>
      </Specimen>
    </Section>
  );
}
