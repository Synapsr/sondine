import { GraphicalEditorLoader } from "@graphical/editor/loader";
import type { EditorHostProps } from "./editor-root";

// Development only (see editor-root.tsx). The loader keeps the app on screen
// while the editor loads, and restores it alone if the editor fails.

const loadEditor = async () => ({
  GraphicalInstalledEditor: (await import("./installed-editor")).default,
});

export default function DevelopmentEditor(props: EditorHostProps) {
  return <GraphicalEditorLoader<EditorHostProps> loadEditor={loadEditor} {...props} />;
}
