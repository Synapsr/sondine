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

## Amendment — the site's art direction (2026-11-27)

Téo asked for the app to take the art direction of Sondine's site, in light
and dark, so that the site's demonstrations look like the app. Of three
directions (the site's theme values only; those plus a halo of the sky's
colors behind the window; those plus the site's sky photo), he chose the
theme values only, as more modern and simpler. The app takes no image, no
gradient and no animation from the site.

- The « Sondine » theme shares the site's values: the palette (`color-2`
  #2596be, `color-3` #b8e2f2, `color-4` #e98a3a), the title weights (460,
  560, 640), the tighter letter spacing (-0.035 and -0.015 em for XS and S),
  and Allo at roundness 0 (ADR 009). Body text keeps 400, 500 and 600, and
  the app keeps its own display sizes, smaller than the site's.
- The dark neutrals are a little lighter than the site's and their edge
  darker (`neutral-1` #141416 to `neutral-4` #2b2b2f), at Téo's request: a
  pure black read too black, and the gray edges of cards too light.
- A later change of the site's palette or type is carried to the app through
  `graphical/themes/graphical.json`, as any theme change.

## Amendment — the site's look, sparingly (2026-11-28)

Since the site was redone, Téo allows the app to take the site's gradients,
pictures and animations, sparingly. The first is the first run's opening
(`components/welcome/welcome-intro.tsx`), after Arc and Dia's first launch:
on the window's own background, the site's moving sky comes in (its WebGL
gradient of orange, pale sky and teal, warped by noise, with grain:
`sky-surface.tsx`, about 15 frames a second, only while it shows);
Sondine's wordmark, the site's (`SondineLogo`, in `packages/ui/src/icon`),
arrives, « Bienvenue » under it, then a quiet line to click; a click fades
it all out onto the first question. In dark mode the pale sky gives way to
black and slow holes open onto the window's background, under white words.
Téo first saw the site's sky photo there, then blurred halos, and chose the
site's gradient. Each later use is a deliberate moment like this one, never
a background for everyday screens, and keeps still under reduced motion.
