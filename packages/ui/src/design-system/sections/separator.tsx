import { Separator } from "../../components/separator";
import { Section, Specimen } from "../section";

export default function SeparatorSection() {
  return (
    <Section id="separator" title="Separator">
      <Specimen label="Horizontal" className="w-[24rem] flex-col items-stretch gap-xs">
        <p>Today</p>
        <Separator />
        <p>Yesterday</p>
      </Specimen>
      <Specimen label="Vertical">
        <div className="flex items-center gap-s">
          <span>Microphone</span>
          <Separator orientation="vertical" />
          <span>System audio</span>
          <Separator orientation="vertical" />
          <span>Apps</span>
        </div>
      </Specimen>
    </Section>
  );
}
