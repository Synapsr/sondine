import { Button } from "../../components/button";
import { Kbd, KbdGroup } from "../../components/kbd";
import { CommandIcon, SearchIcon } from "../../icon";
import { Section, Specimen } from "../section";

export default function KbdSection() {
  return (
    <Section id="kbd" title="Kbd">
      <p className="text-body-xs text-cte-text-muted">
        Coverage gap: no Graphical specification. Built from the theme foundations.
      </p>
      <Specimen label="Keys">
        <Kbd>⌘</Kbd>
        <Kbd>⇧</Kbd>
        <Kbd>⌥</Kbd>
        <Kbd>⌃</Kbd>
        <Kbd>↵</Kbd>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <Kbd>K</Kbd>
        <Kbd>D</Kbd>
        <Kbd>esc</Kbd>
        <Kbd>Espace</Kbd>
        <Kbd>
          <CommandIcon />
        </Kbd>
      </Specimen>
      <Specimen label="Combinations">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
        <KbdGroup>
          <Kbd>⌥</Kbd>
          <Kbd>⌘</Kbd>
          <Kbd>P</Kbd>
        </KbdGroup>
        <KbdGroup>
          <Kbd>⇧</Kbd>
          <Kbd>⌘</Kbd>
          <Kbd>E</Kbd>
        </KbdGroup>
      </Specimen>
      <Specimen label="In text, in a button, disabled">
        <p className="flex items-center gap-xxs">
          Appuyez sur
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
          pour rechercher dans vos conversations.
        </p>
        <Button variant="outline">
          <SearchIcon />
          Rechercher
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Button>
        <Button variant="outline" disabled>
          <SearchIcon />
          Rechercher
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Button>
      </Specimen>
      <Specimen label="On canvas, surface, muted surface and popup">
        {[
          "bg-cte-canvas",
          "bg-cte-surface",
          "bg-cte-surface-muted",
          "bg-[color:light-dark(var(--neutral-1),var(--neutral-2))] shadow-m",
        ].map((surface) => (
          <div key={surface} className={`flex items-center gap-xs corner-s p-s ${surface}`}>
            <span>Basculer le thème</span>
            <Kbd>D</Kbd>
          </div>
        ))}
      </Specimen>
    </Section>
  );
}
