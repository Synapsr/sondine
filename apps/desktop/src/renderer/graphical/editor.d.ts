// The part of Graphical's editor (1.0.4) the app uses. The package itself is
// not in the repository (ADR 033).

declare module "@graphical/editor/loader" {
  import type { ComponentType, ReactNode } from "react";

  export function GraphicalEditorLoader<P extends { children: ReactNode }>(
    props: P & { loadEditor: () => Promise<{ GraphicalInstalledEditor: ComponentType<P> }> },
  ): ReactNode;
}

declare module "@graphical/editor/native" {
  import type { ReactNode } from "react";

  interface HandoffContext {
    projectId?: string | undefined;
    mode?: string | undefined;
  }

  export function readGraphicalProject(
    project: unknown,
    themes: Record<string, unknown>,
    roleMap: unknown,
    paths: { projectPath: string; roleMapPath: string },
  ): { document: object; roleMap: object; handoffContext: HandoffContext };

  export function isGraphicalInteraction(event: {
    target: EventTarget | null;
    composedPath?: () => EventTarget[];
  }): boolean;

  export function GraphicalInstalledEditor(props: {
    document: object;
    roleMap: object;
    handoffContext: HandoffContext;
    colorMode: "light" | "dark";
    onColorModeChange: (mode: "light" | "dark") => void;
    onAppPortalContainerChange: (container: HTMLDivElement | null) => void;
    route: string;
    initialPanelOpen: boolean;
    children: ReactNode;
  }): ReactNode;
}

declare module "@graphical/editor/styles.css";
