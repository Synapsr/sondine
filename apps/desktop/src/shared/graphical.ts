// Graphical's account service. Its theme editor, mounted in development only
// (ADR 033), signs in there, reads the account's themes and loads preview
// fonts and images from it. Production never reaches it.

export const GRAPHICAL_ORIGIN = "https://www.graphicalui.com";

/** The sign-in page the editor's panel links to; it opens in the default browser. */
export function isGraphicalSignIn(url: string): boolean {
  return url.startsWith(`${GRAPHICAL_ORIGIN}/connect-editor?`);
}
