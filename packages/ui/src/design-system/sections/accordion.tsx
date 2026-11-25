import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "../../components/accordion";
import { MicrophoneIcon, PhoneIcon, VolumeIcon } from "../../icon";
import { Section, Specimen } from "../section";

const specimenClassName = "w-[20rem] max-w-full flex-col items-stretch";

export default function AccordionSection() {
  return (
    <Section id="accordion" title="Accordion">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] items-start gap-xl">
        <Specimen label="Single, one open" className={specimenClassName}>
          <Accordion defaultValue={["storage"]}>
            <AccordionItem value="storage">
              <AccordionTrigger>Où sont stockées mes conversations&nbsp;?</AccordionTrigger>
              <AccordionPanel>
                Uniquement sur ce Mac. Sondine n’envoie rien sur internet, pas même des statistiques
                d’usage.
              </AccordionPanel>
            </AccordionItem>
            <AccordionItem value="pause">
              <AccordionTrigger>Comment mettre en pause l’écoute&nbsp;?</AccordionTrigger>
              <AccordionPanel>
                Cliquez sur Sondine dans la barre des menus, puis sur Mettre en pause l’écoute.
              </AccordionPanel>
            </AccordionItem>
            <AccordionItem value="access">
              <AccordionTrigger>Qui peut lire mes transcriptions&nbsp;?</AccordionTrigger>
              <AccordionPanel>
                Vous seul. Un iPhone jumelé les consulte uniquement sur votre réseau local.
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        </Specimen>

        <Specimen label="Multiple, two open" className={specimenClassName}>
          <Accordion multiple defaultValue={["product", "ines"]}>
            <AccordionItem value="product">
              <AccordionTrigger>Réunion produit</AccordionTrigger>
              <AccordionPanel>Camille, Léo et vous · 48 min · Zoom</AccordionPanel>
            </AccordionItem>
            <AccordionItem value="ines">
              <AccordionTrigger>Appel avec Inès</AccordionTrigger>
              <AccordionPanel>Inès et vous · 12 min · FaceTime</AccordionPanel>
            </AccordionItem>
            <AccordionItem value="coffee">
              <AccordionTrigger>Café avec Hugo</AccordionTrigger>
              <AccordionPanel>Hugo et vous · 25 min · Micro</AccordionPanel>
            </AccordionItem>
          </Accordion>
        </Specimen>

        <Specimen label="Icons, disabled items" className={specimenClassName}>
          <Accordion defaultValue={["system"]}>
            <AccordionItem value="mic">
              <AccordionTrigger>
                <MicrophoneIcon />
                Micro intégré
              </AccordionTrigger>
              <AccordionPanel>Écoute active · annulation d’écho activée.</AccordionPanel>
            </AccordionItem>
            <AccordionItem value="system" disabled>
              <AccordionTrigger>
                <VolumeIcon />
                Audio système
              </AccordionTrigger>
              <AccordionPanel>
                Autorisez l’audio système dans Réglages Système pour activer cette source.
              </AccordionPanel>
            </AccordionItem>
            <AccordionItem value="iphone" disabled>
              <AccordionTrigger>
                <PhoneIcon />
                iPhone de Camille
              </AccordionTrigger>
              <AccordionPanel>Jumelez l’iPhone pour l’utiliser comme micro.</AccordionPanel>
            </AccordionItem>
          </Accordion>
        </Specimen>
      </div>
    </Section>
  );
}
