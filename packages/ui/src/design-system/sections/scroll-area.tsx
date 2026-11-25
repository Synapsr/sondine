import { ScrollArea } from "../../components/scroll-area";
import { Section, Specimen } from "../section";

const conversations = [
  { title: "Point hebdo avec Camille", detail: "Zoom · 10:02 · 42 min" },
  { title: "Appel avec Hugo", detail: "FaceTime · 11:30 · 8 min" },
  { title: "Revue de l’onboarding", detail: "Google Meet · 14:00 · 55 min" },
  { title: "Note vocale : idées pour la démo", detail: "Micro · 16:12 · 3 min" },
  { title: "Entretien avec Léa", detail: "Microsoft Teams · 17:45 · 31 min" },
  { title: "Café avec Malo", detail: "Micro · 18:20 · 12 min" },
  { title: "Rétrospective du sprint", detail: "Zoom · 09:30 · 47 min" },
  { title: "Appel avec le support Apple", detail: "Téléphone · 12:05 · 19 min" },
] as const;

const apps = [
  "Zoom",
  "Google Meet",
  "Microsoft Teams",
  "FaceTime",
  "Slack",
  "Discord",
  "WhatsApp",
  "Webex",
  "Micro intégré",
] as const;

const columns = ["Conversation", "Application", "Durée", "Intervenants", "Langue", "État"] as const;
const rows = [
  ["Point hebdo", "Zoom", "42 min", "Camille, Hugo", "Français", "Transcrite"],
  ["Revue de l’onboarding", "Google Meet", "55 min", "Léa, Malo, Inès", "Français", "Transcrite"],
  ["Sync produit", "Microsoft Teams", "28 min", "Camille, Sam", "Anglais", "En file"],
  ["Rétrospective", "Zoom", "47 min", "Toute l’équipe", "Français", "Transcrite"],
  ["Appel support", "Téléphone", "19 min", "Hugo", "Français", "Analyse"],
  ["Démo client", "Webex", "36 min", "Camille, Léa", "Anglais", "En file"],
] as const;

const frame = "h-[15rem] w-[20rem] max-w-full";

function ConversationList() {
  return conversations.map(({ title, detail }) => (
    <div key={title} className="flex flex-col">
      <span className="font-medium text-neutral-10 group-data-disabled/scroll-area:text-neutral-6">
        {title}
      </span>
      <span>{detail}</span>
    </div>
  ));
}

export default function ScrollAreaSection() {
  return (
    <Section id="scroll-area" title="Scroll area">
      <Specimen label="Vertical, disabled" className="items-start gap-l">
        <ScrollArea className={frame}>
          <ConversationList />
        </ScrollArea>
        <ScrollArea disabled className={frame}>
          <ConversationList />
        </ScrollArea>
      </Specimen>
      <Specimen label="Horizontal" className="items-start gap-l">
        <ScrollArea
          orientation="horizontal"
          className="w-[20rem] max-w-full"
          contentClassName="flex-row"
        >
          {apps.map((app) => (
            <span
              key={app}
              className="corner-full bg-neutral-3 px-s py-xxs whitespace-nowrap text-neutral-10"
            >
              {app}
            </span>
          ))}
        </ScrollArea>
      </Specimen>
      <Specimen label="Both axes" className="items-start gap-l">
        <ScrollArea orientation="both" className={frame} contentClassName="gap-xs">
          <div className="grid grid-cols-[repeat(6,9rem)] gap-x-s font-medium text-neutral-10">
            {columns.map((column) => (
              <span key={column}>{column}</span>
            ))}
          </div>
          {[...rows, ...rows].map((row, index) => (
            <div key={`${row[0]}-${index}`} className="grid grid-cols-[repeat(6,9rem)] gap-x-s">
              {row.map((cell, column) => (
                <span key={columns[column]}>{cell}</span>
              ))}
            </div>
          ))}
        </ScrollArea>
      </Specimen>
    </Section>
  );
}
