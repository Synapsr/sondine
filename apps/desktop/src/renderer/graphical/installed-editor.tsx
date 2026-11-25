import {
  GraphicalInstalledEditor,
  isGraphicalInteraction,
  readGraphicalProject,
} from "@graphical/editor/native";
import "@graphical/editor/styles.css";
import "./host-reset.css";
import { PortalDestination, useTheme } from "@sondine/ui";
import { useEffect, useState } from "react";
import project from "../../../../../graphical/project.json";
import roleMap from "../../../../../graphical/role-map.json";
import theme from "../../../../../graphical/themes/graphical.json";
import type { EditorHostProps } from "./editor-root";
import { registerEditorInteraction } from "./interaction-boundary";

// Graphical's theme editor around the app, development only (see
// editor-root.tsx). Each person signs in with their own Graphical account in
// the panel. Edits preview live; « Copy for agent » carries them to source
// (graphical-adopt skill). Copied batches omit the app's text by default, so
// transcripts never leave in them.

const current = readGraphicalProject(project, { "themes/graphical.json": theme }, roleMap, {
  projectPath: "graphical/project.json",
  roleMapPath: "graphical/role-map.json",
});
// The project reader types the fields it could not find as undefined; the
// editor takes them as absent.
const { projectId, mode, ...known } = current.handoffContext;
const handoffContext = {
  ...known,
  ...(projectId === undefined ? {} : { projectId }),
  ...(mode === undefined ? {} : { mode }),
};

export default function InstalledEditor({ children, route }: EditorHostProps) {
  const { resolvedTheme, setTheme } = useTheme();
  // Base UI portals render in the editor's app viewport, beside the panel.
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => registerEditorInteraction(isGraphicalInteraction), []);
  return (
    <GraphicalInstalledEditor
      document={current.document}
      roleMap={current.roleMap}
      handoffContext={handoffContext}
      colorMode={resolvedTheme}
      onColorModeChange={setTheme}
      onAppPortalContainerChange={setPortalContainer}
      route={route}
      initialPanelOpen
    >
      <PortalDestination container={portalContainer}>{children}</PortalDestination>
    </GraphicalInstalledEditor>
  );
}
