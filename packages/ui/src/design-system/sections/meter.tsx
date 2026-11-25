import { Meter, MeterLabel, MeterValue } from "../../components/meter";
import { Section, Specimen } from "../section";

const width = "w-[20rem] max-w-full";

export default function MeterSection() {
  return (
    <Section id="meter" title="Meter">
      <Specimen label="Normal, low, high" className="items-start gap-l">
        <Meter value={42} low={20} high={85} className={width}>
          <MeterLabel>Espace disque utilisé</MeterLabel>
          <MeterValue />
        </Meter>
        <Meter value={12} low={20} className={width}>
          <MeterLabel>Niveau du micro</MeterLabel>
          <MeterValue />
        </Meter>
        <Meter value={92} high={85} className={width}>
          <MeterLabel>Stockage des enregistrements</MeterLabel>
          <MeterValue />
        </Meter>
      </Specimen>
      <Specimen label="Custom format, without heading" className="items-start gap-l">
        <Meter
          value={18.4}
          max={64}
          format={{ style: "unit", unit: "gigabyte", maximumFractionDigits: 1 }}
          className={width}
        >
          <MeterLabel>Modèles téléchargés</MeterLabel>
          <MeterValue />
        </Meter>
        <Meter value={58} aria-label="Niveau du micro" className={width} />
      </Specimen>
      <Specimen label="Disabled" className="items-start gap-l">
        <Meter value={36} disabled className={width}>
          <MeterLabel>Niveau du micro (écoute en pause)</MeterLabel>
          <MeterValue />
        </Meter>
      </Specimen>
    </Section>
  );
}
