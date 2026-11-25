import {
  PreviewCard,
  PreviewCardDescription,
  PreviewCardPopup,
  PreviewCardTitle,
  PreviewCardTrigger,
} from "../../components/preview-card";
import { Section, Specimen } from "../section";

function PersonCard({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <PreviewCard defaultOpen={defaultOpen}>
      <PreviewCardTrigger href="#personnes/camille-laurent">Camille Laurent</PreviewCardTrigger>
      <PreviewCardPopup>
        <PreviewCardTitle>Camille Laurent</PreviewCardTitle>
        <PreviewCardDescription>
          Reconnue dans 14 conversations. Dernière fois hier, sur Zoom.
        </PreviewCardDescription>
      </PreviewCardPopup>
    </PreviewCard>
  );
}

function ConversationCard({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <PreviewCard defaultOpen={defaultOpen}>
      <PreviewCardTrigger href="#conversations/point-hebdo-produit">
        Point hebdo produit
      </PreviewCardTrigger>
      <PreviewCardPopup>
        <PreviewCardTitle>Point hebdo produit</PreviewCardTitle>
        <PreviewCardDescription>
          Zoom · 42 min · Camille, Hugo et vous. Décision : sortie de la version 0.3 repoussée au 18
          novembre.
        </PreviewCardDescription>
      </PreviewCardPopup>
    </PreviewCard>
  );
}

export default function PreviewCardSection() {
  return (
    <Section id="preview-card" title="Preview card">
      <Specimen label="Hover or focus">
        <p className="max-w-[40rem]">
          Pendant le <ConversationCard />, <PersonCard /> a présenté la feuille de route du
          trimestre.
        </p>
      </Specimen>
      <Specimen
        label="Open"
        className="grid min-h-[12rem] grid-cols-[repeat(3,minmax(0,22rem))] items-start gap-l"
      >
        <div>
          <PersonCard defaultOpen />
        </div>
        <div>
          <ConversationCard defaultOpen />
        </div>
        <div>
          <PreviewCard defaultOpen>
            <PreviewCardTrigger href="#personnes/inconnu-3">Voix inconnue 3</PreviewCardTrigger>
            <PreviewCardPopup>
              <PreviewCardTitle disabled>Voix inconnue 3</PreviewCardTitle>
              <PreviewCardDescription disabled>
                Profil vocal supprimé le 28 octobre.
              </PreviewCardDescription>
            </PreviewCardPopup>
          </PreviewCard>
        </div>
      </Specimen>
      <Specimen label="Disabled link">
        <p>
          Enregistré dans{" "}
          <PreviewCardTrigger disabled href="#conversations/entretien-supprime">
            Entretien supprimé
          </PreviewCardTrigger>
          .
        </p>
      </Specimen>
    </Section>
  );
}
