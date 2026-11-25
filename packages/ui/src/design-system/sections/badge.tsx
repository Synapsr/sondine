import { Badge } from "../../components/badge";
import { CircleCheckIcon, CircleXIcon, ClockIcon, RecordIcon, WarningIcon } from "../../icon";
import { Section, Specimen } from "../section";

export default function BadgeSection() {
  return (
    <Section id="badge" title="Badge">
      <p className="text-body-xs text-cte-text-muted">
        Coverage gap: no Graphical specification. Built from the theme foundations.
      </p>
      <Specimen label="Variants">
        <Badge>En cours</Badge>
        <Badge variant="success">Transcrite</Badge>
        <Badge variant="warning">Provisoire</Badge>
        <Badge variant="error">Échec</Badge>
      </Specimen>
      <Specimen label="With icon">
        <Badge>
          <RecordIcon />
          En écoute
        </Badge>
        <Badge>
          <ClockIcon />
          12 min
        </Badge>
        <Badge variant="success">
          <CircleCheckIcon />
          Transcrite
        </Badge>
        <Badge variant="warning">
          <WarningIcon />
          Micro coupé
        </Badge>
        <Badge variant="error">
          <CircleXIcon />
          Échec de la capture
        </Badge>
      </Specimen>
      <Specimen label="Counts">
        <Badge>3</Badge>
        <Badge>12</Badge>
        <Badge>128</Badge>
        <Badge variant="error">1</Badge>
      </Specimen>
      <Specimen label="In a line of S text" className="flex-col items-start gap-xs">
        <p className="flex items-center gap-xs">
          <span className="font-medium">Point quotidien</span>
          <span className="text-cte-text-muted">Zoom · Camille, Hugo</span>
          <Badge variant="success">Transcrite</Badge>
        </p>
        <p className="flex items-center gap-xs">
          <span className="font-medium">Qui est-ce&nbsp;?</span>
          <Badge>3</Badge>
        </p>
      </Specimen>
      <Specimen label="Rendered as a link (focus with Tab)">
        <Badge render={<a href="#badge" />}>3 voix à identifier</Badge>
      </Specimen>
    </Section>
  );
}
