import { Field } from "@base-ui/react/field";
import { type ReactNode, useEffect, useState } from "react";
import {
  Select,
  SelectItem,
  SelectLabel,
  SelectPopup,
  type SelectProps,
  SelectTrigger,
  SelectValue,
} from "../../components/select";
import { cn } from "../../lib/cn";
import { PortalContainer } from "../../theme/portal-container";
import { Section, Specimen } from "../section";

const belowOnly = { side: "none" } as const;

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

const languages = [
  { value: "auto", label: "Détection automatique" },
  { value: "fr", label: "Français" },
  { value: "en", label: "Anglais" },
  { value: "es", label: "Espagnol" },
] as const satisfies readonly Option[];

const microphones = [
  { value: "built-in", label: "Micro du MacBook Pro" },
  { value: "airpods", label: "AirPods Pro de Camille" },
  { value: "shure", label: "Shure MV7+" },
  { value: "iphone", label: "iPhone de Léa (hors ligne)", disabled: true },
] as const satisfies readonly Option[];

interface DemoProps extends Omit<SelectProps<string>, "items" | "children"> {
  label: string;
  options: readonly Option[];
  placeholder?: string;
  /**
   * Leaves room under the trigger and keeps the open popup there. Base UI keeps a
   * flipped popup above while it fits, which would cover the specimens above.
   */
  reserveSpace?: boolean;
}

function Demo({ label, options, placeholder, reserveSpace = false, ...props }: DemoProps) {
  return (
    <div
      className={cn("flex w-[20rem] max-w-full flex-col gap-xs", reserveSpace && "min-h-[14rem]")}
    >
      <Select items={options} {...props}>
        <SelectLabel>{label}</SelectLabel>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectPopup collisionAvoidance={reserveSpace ? belowOnly : undefined}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/**
 * Static open preview. The popup portals into an inert frame that contains it
 * (layout containment), so it stays in place and cannot take focus. It opens
 * once the whole frame is on screen: an open Select scrolls its selected
 * option into view, which on mount would pull the page down to this section.
 */
function OpenDemo(props: Omit<DemoProps, "open" | "onOpenChange">) {
  const [open, setOpen] = useState(false);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (frame === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setOpen(true);
          observer.disconnect();
        }
      },
      { threshold: 1 },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);
  return (
    <div ref={setFrame} inert className="relative min-w-0 contain-layout">
      <PortalContainer>
        <Demo {...props} open={open} />
      </PortalContainer>
    </div>
  );
}

function Invalid({ children }: { children: ReactNode }) {
  return (
    <Field.Root invalid className="contents">
      {children}
    </Field.Root>
  );
}

export default function SelectSection() {
  return (
    <Section id="select" title="Select">
      <Specimen label="Value and placeholder" className="items-start gap-l">
        <Demo label="Langue de transcription" options={languages} defaultValue="fr" />
        <Demo label="Micro" options={microphones} placeholder="Choisir un micro" />
      </Specimen>
      <Specimen label="Disabled" className="items-start gap-l">
        <Demo label="Langue de transcription" options={languages} defaultValue="fr" disabled />
        <Demo label="Micro" options={microphones} placeholder="Choisir un micro" disabled />
      </Specimen>
      <Specimen label="Invalid" className="items-start gap-l">
        <Invalid>
          <Demo label="Micro" options={microphones} placeholder="Choisir un micro" />
        </Invalid>
      </Specimen>
      <Specimen label="Open: selected and disabled option" className="items-start">
        <OpenDemo
          label="Micro"
          options={microphones}
          defaultValue="airpods"
          modal={false}
          reserveSpace
        />
      </Specimen>
    </Section>
  );
}
