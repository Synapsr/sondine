import { useRouterState } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { router } from "../routes/router";

// Wraps the app with Graphical's theme editor in development (graphical/ at
// the repository root). The editor's code is reached only through the import
// below, which Vite drops from production builds, so production renders the
// app alone. Until the editor loads, or if it cannot, the app renders as is.
// `VITE_SONDINE_NO_EDITOR=1` leaves it out in development too, for captures.

export interface EditorHostProps {
  children: ReactNode;
  /** The committed route, so an edit to one page's element stays on that page. */
  route: string;
}

const loadDevelopmentEditor =
  import.meta.env.DEV && import.meta.env["VITE_SONDINE_NO_EDITOR"] !== "1"
    ? () => import("./development-editor")
    : null;

function DevelopmentRoot({ children }: { children: ReactNode }) {
  const route = useRouterState({
    router,
    select: (state) => (state.resolvedLocation ?? state.location).href,
  });
  const [Editor, setEditor] = useState<ComponentType<EditorHostProps> | null>(null);
  useEffect(() => {
    if (loadDevelopmentEditor === null) return;
    let active = true;
    void loadDevelopmentEditor().then(
      ({ default: editor }) => {
        if (active) setEditor(() => editor);
      },
      (error: unknown) => {
        if (active) console.error("Graphical editor unavailable; the app runs without it.", error);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return Editor === null ? children : <Editor route={route}>{children}</Editor>;
}

function ProductionRoot({ children }: { children: ReactNode }) {
  return children;
}

export const EditorRoot = loadDevelopmentEditor === null ? ProductionRoot : DevelopmentRoot;
