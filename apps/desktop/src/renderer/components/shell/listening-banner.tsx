import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { listeningView } from "../status/listening-view";

// A line above every screen when capture runs but its audio is not stored, a
// failure the user did not ask for (ADR 037). A pause, a pause not yet
// applied or a private zone shows in the top bar's listening control instead.

export function ListeningBanner() {
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  if (status.data === undefined) return null;
  switch (listeningView(status.data.listening, status.data.spool).state) {
    case "disk-full":
      return <Line>{m.banner_disk_full()}</Line>;
    case "write-error":
      return (
        <Line>
          {m.listening_write_error()}{" "}
          <Link
            to="/settings/$page"
            params={{ page: "advanced" }}
            className="corner-xs underline underline-offset-4 focus-ring"
          >
            {m.settings_tab_advanced()}
          </Link>
        </Line>
      );
    default:
      return null;
  }
}

function Line({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-m bg-error px-xl py-xs text-[color:light-dark(var(--neutral-10),var(--neutral-1))]"
    >
      <p className="min-w-0 flex-1 font-body font-medium text-body-s">{children}</p>
    </div>
  );
}
