// Lets app-wide key handlers yield to Graphical's development editor without
// importing it: the editor's adapter registers its check here in development,
// and production never does, so every event stays the app's.

interface Interaction {
  target: EventTarget | null;
  composedPath?: () => EventTarget[];
}

type Boundary = (event: Interaction) => boolean;

let boundary: Boundary | undefined;

/** True when the event belongs to the editor's panel, popups or selection. */
export function isEditorInteraction(event: Interaction): boolean {
  return boundary?.(event) ?? false;
}

export function registerEditorInteraction(next: Boundary): () => void {
  boundary = next;
  return () => {
    if (boundary === next) boundary = undefined;
  };
}
