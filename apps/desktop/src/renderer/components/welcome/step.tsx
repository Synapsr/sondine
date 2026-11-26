import { Button } from "@sondine/ui/components/button";
import type { ReactNode } from "react";
import { m } from "../../paraglide/messages.js";

/** One screen of the first run: its title, its parts rising in turn, then Back and the way forward. */
export function Step({
  title,
  children,
  onBack,
  next,
}: {
  title: string;
  children: ReactNode;
  onBack?: () => void;
  next: ReactNode;
}) {
  return (
    <section aria-labelledby="welcome-title" className="sondine-stagger flex flex-col gap-l">
      <h1 id="welcome-title" className="font-display font-heavy text-display-m">
        {title}
      </h1>
      {children}
      {/* Back on the left, the way forward on the right. */}
      <div className="flex items-center gap-xs pt-m">
        {onBack === undefined ? null : (
          <Button variant="ghost" className="-ms-s" onClick={onBack}>
            {m.welcome_back()}
          </Button>
        )}
        <span className="ms-auto flex items-center gap-xs">{next}</span>
      </div>
    </section>
  );
}
