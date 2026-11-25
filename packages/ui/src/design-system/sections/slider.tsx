import { Field, FieldError } from "../../components/field";
import { Slider, SliderLabel, SliderValue } from "../../components/slider";
import { Section, Specimen } from "../section";

const width = "w-[20rem] max-w-full";

export default function SliderSection() {
  return (
    <Section id="slider" title="Slider">
      <Specimen label="Single value, minimum, maximum" className="items-start gap-l">
        <Slider defaultValue={60} className={width}>
          <SliderLabel>Volume de lecture</SliderLabel>
          <SliderValue />
        </Slider>
        <Slider defaultValue={0} className={width}>
          <SliderLabel>Réduction du bruit</SliderLabel>
          <SliderValue />
        </Slider>
        <Slider defaultValue={100} className={width}>
          <SliderLabel>Sensibilité de détection</SliderLabel>
          <SliderValue />
        </Slider>
      </Specimen>
      <Specimen label="Steps, range, without heading" className="items-start gap-l">
        <Slider
          defaultValue={1.25}
          min={0.5}
          max={2}
          step={0.25}
          format={{ maximumFractionDigits: 2 }}
          className={width}
        >
          <SliderLabel>Vitesse de lecture</SliderLabel>
          <SliderValue>{(formatted) => `${formatted[0] ?? ""} ×`}</SliderValue>
        </Slider>
        <Slider
          defaultValue={[8, 19]}
          min={0}
          max={24}
          getAriaLabel={(index) => (index === 0 ? "Début de l’écoute" : "Fin de l’écoute")}
          className={width}
        >
          <SliderLabel>Plage d’écoute</SliderLabel>
          <SliderValue>
            {(formatted) => `${formatted[0] ?? ""} h – ${formatted[1] ?? ""} h`}
          </SliderValue>
        </Slider>
        <Slider defaultValue={35} getAriaLabel={() => "Volume de lecture"} className={width} />
      </Specimen>
      <Specimen label="Disabled, invalid" className="items-start gap-l">
        <Slider defaultValue={60} disabled className={width}>
          <SliderLabel>Volume de lecture</SliderLabel>
          <SliderValue />
        </Slider>
        <Field invalid className={width}>
          <Slider defaultValue={95} className="w-full">
            <SliderLabel>Gain du micro</SliderLabel>
            <SliderValue />
          </Slider>
          <FieldError match>Le son risque de saturer.</FieldError>
        </Field>
      </Specimen>
      <Specimen label="Vertical, range" className="items-start gap-l">
        <Slider
          defaultValue={70}
          orientation="vertical"
          getAriaLabel={() => "Gain du micro"}
          className="h-[10rem]"
        />
        <Slider
          defaultValue={[20, 80]}
          orientation="vertical"
          getAriaLabel={(index) => (index === 0 ? "Seuil bas" : "Seuil haut")}
          className="h-[10rem]"
        />
      </Specimen>
    </Section>
  );
}
