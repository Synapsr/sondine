import { useState } from "react";
import { Button, type ButtonProps } from "../../components/button";
import { ArrowRightIcon, PlusIcon, SettingsIcon, TrashIcon } from "../../icon";
import { Section, Specimen } from "../section";

const variants = [
  { variant: "primary", label: "Primary" },
  { variant: "secondary", label: "Secondary" },
  { variant: "outline", label: "Outline" },
  { variant: "ghost", label: "Ghost" },
  { variant: "danger", label: "Danger" },
] as const satisfies readonly { variant: ButtonProps["variant"]; label: string }[];

function PendingDemo() {
  const [pending, setPending] = useState(false);
  return (
    <Button
      isPending={pending}
      onClick={() => {
        setPending(true);
        setTimeout(() => setPending(false), 2000);
      }}
    >
      Save
    </Button>
  );
}

export default function ButtonSection() {
  return (
    <Section id="button" title="Button">
      <Specimen label="Variants">
        {variants.map(({ variant, label }) => (
          <Button key={variant} variant={variant}>
            {label}
          </Button>
        ))}
      </Specimen>
      <Specimen label="With icons">
        <Button>
          <PlusIcon />
          New person
        </Button>
        <Button variant="secondary">
          Continue
          <ArrowRightIcon />
        </Button>
        <Button variant="danger">
          <TrashIcon />
          Delete
        </Button>
        <Button variant="secondary" size="icon" aria-label="Settings">
          <SettingsIcon />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Settings">
          <SettingsIcon />
        </Button>
      </Specimen>
      <Specimen label="Disabled">
        {variants.map(({ variant, label }) => (
          <Button key={variant} variant={variant} disabled>
            {label}
          </Button>
        ))}
      </Specimen>
      <Specimen label="Pending">
        {variants.map(({ variant, label }) => (
          <Button key={variant} variant={variant} isPending>
            {label}
          </Button>
        ))}
        <PendingDemo />
      </Specimen>
    </Section>
  );
}
