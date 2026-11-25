# 033 — Graphical's theme editor, in development only

Status: Accepted — 2026-11-14 (Téo asked for the Graphical install).

## Context

Sondine's look came from a Graphical theme download: `GUI.md`, `gui/` and
literal values copied into `packages/ui/src/styles`. Graphical now installs
into an app: it converts the app's styles onto its own system and adds a
theme editor that runs beside the app's real pages, where Téo signs in with
his own Graphical account to check and refine the theme.

The editor talks to Graphical's account service (`https://www.graphicalui.com`):
sign-in, the account's saved themes, and the fonts and images its previews
show. That is a network call, which ADR 002 allows only for what the user
starts.

## Decision

- The theme lives in `graphical/` at the repository root: the project, the
  « Sondine » theme document, the role map, and the files generated from
  them (`generated/theme.css` for the variables, `generated/tailwind-theme.css`
  for the classes). `packages/ui/src/styles` imports both and keeps only
  Sondine's own keys. Production renders this CSS and the installed fonts,
  with no Graphical code.
- The editor (`@graphical/editor`) is not in the repository (ADR 041). Each
  developer who has it keeps it in `graphical/packages/`, which git ignores,
  and the desktop app's Vite config loads it from there. It is no dependency
  of the app, because pnpm cannot install without its tarball. It mounts only
  in development: `apps/desktop/src/renderer/graphical/editor-root.tsx`
  reaches it through an `import.meta.env.DEV` branch that Vite drops from
  builds. Without it, the app runs alone.
- In development only, the window's CSP and the session's request guard
  admit `https://www.graphicalui.com`, and its sign-in page opens in the
  default browser. The packaged app keeps ADR 010's policy unchanged.
- Batches the editor copies for an agent omit the app's text (its default),
  so transcripts do not travel in them.

## Consequences

- The editor is installed, and reinstalled for a later version, from
  `graphical/packages/` with `npm install --prefix . ./editor-<version>.tgz`.
- Theme changes go through the editor or `graphical/themes/graphical.json`,
  then `npx graphical-install --theme graphical --root ../..` (from
  `graphical/packages`) regenerates the CSS; the generated files are never
  edited.
- Each developer signs in with their own Graphical account; nothing is
  shared through the repository.
- A later editor version is applied with the graphical-adopt skill;
  `apps/desktop/src/renderer/graphical/editor.d.ts` declares the part of it
  the app uses.
