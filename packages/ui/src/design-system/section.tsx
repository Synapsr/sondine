import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface SectionProps {
  /** Anchor id, kebab-case. */
  id: string;
  title: string;
  children?: ReactNode;
}

/** One design-system section: a component family or a foundation. */
export function Section({ id, title, children }: SectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-xxl flex-col gap-l">
      <h2 id={`${id}-title`} className="font-display font-heavy text-display-xxs">
        {title}
      </h2>
      {children}
    </section>
  );
}

export interface SpecimenProps {
  label: string;
  children?: ReactNode;
  className?: string | undefined;
}

/** A labelled group of examples inside a section. */
export function Specimen({ label, children, className }: SpecimenProps) {
  return (
    <div className="flex flex-col gap-s">
      <h3 className="font-body font-medium text-body-xs text-cte-text-muted">{label}</h3>
      <div className={cn("flex flex-wrap items-center gap-s", className)}>{children}</div>
    </div>
  );
}
