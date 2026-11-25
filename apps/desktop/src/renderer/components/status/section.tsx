import { useId, type ReactNode } from "react";

/** A titled block of the status screen. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-s">
      <h2 id={id} className="font-body font-medium text-body-m">
        {title}
      </h2>
      {children}
    </section>
  );
}
