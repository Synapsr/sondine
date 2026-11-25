import { Avatar, AvatarFallback, AvatarImage } from "../../components/avatar";
import { UserIcon } from "../../icon";
import { Section, Specimen } from "../section";

// Sample artwork only (not a theme asset): an abstract portrait in palette colors.
const portrait = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#ffd0b0"/><circle cx="32" cy="25" r="12" fill="#ff5a00"/><rect x="10" y="41" width="44" height="30" rx="15" fill="#ff5a00"/></svg>',
)}`;

const people = [
  { name: "Camille Martin", initials: "CM" },
  { name: "Hugo Lefèvre", initials: "HL" },
  { name: "Léa Dubois", initials: "LD" },
] as const;

export default function AvatarSection() {
  return (
    <Section id="avatar" title="Avatar">
      <Specimen label="Image, initials, icon, broken image">
        <Avatar>
          <AvatarImage src={portrait} alt="Camille Martin" />
          <AvatarFallback>CM</AvatarFallback>
        </Avatar>
        {people.map(({ name, initials }) => (
          <Avatar key={name} role="img" aria-label={name}>
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        ))}
        <Avatar role="img" aria-label="Intervenant inconnu">
          <AvatarFallback>
            <UserIcon />
          </AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarImage src="./missing-portrait.png" alt="Hugo Lefèvre" />
          <AvatarFallback>HL</AvatarFallback>
        </Avatar>
      </Specimen>
      <Specimen label="Disabled">
        <Avatar disabled role="img" aria-label="Camille Martin">
          <AvatarFallback>CM</AvatarFallback>
        </Avatar>
        <Avatar disabled role="img" aria-label="Intervenant inconnu">
          <AvatarFallback>
            <UserIcon />
          </AvatarFallback>
        </Avatar>
      </Specimen>
    </Section>
  );
}
