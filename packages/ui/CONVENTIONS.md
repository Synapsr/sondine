# `@sondine/ui` component conventions

Read this before adding a component. `src/components/button.tsx` and
`src/components/separator.tsx` are the reference implementations, with their
sections in `src/design-system/sections/`. The rules come from `GUI.md`,
`gui/foundations.md`, `gui/base-ui.md` and the spec for your component in
`gui/components/sondine/<name>.md`. The theme's values and classes are
Graphical's (`graphical/` at the repository root, listed in
`gui/themes/sondine.md`). `GUI.md` and `gui/` are Graphical's and not in the
repository (ADR 041): without them, follow the reference implementations and
the closest component.

## Files

| What                                          | Where                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Component family (all parts of one primitive) | `src/components/<name>.tsx`, kebab-case, imported as `@sondine/ui/components/<name>` |
| Tests (owned by the component's author)       | `src/components/<name>.test.tsx`                                                     |
| Design-system section                         | `src/design-system/sections/<name>.tsx`                                              |
| Icons                                         | `src/icon/` (generated, see Icons)                                                   |
| Tokens and Tailwind mapping                   | `graphical/generated/` (generated), `src/styles/` (do not edit for a component)      |
| Shared helpers                                | `src/lib/cn.ts`, `src/lib/class-name.ts`, `src/lib/motion.ts`, `src/theme/`          |

One file holds one family: `menu.tsx` exports `Menu`, `MenuTrigger`,
`MenuPopup`, `MenuItem`, ... Export the component names and their prop types;
export a `cva` variants object only when other code needs the same styling.
Do not add a barrel file; `package.json` already exports `./components/*`.

## Read the spec

Each spec has prose rules and a JSON block with every variant, mode, part and
state. Where `gui/` is present, print it compactly:

```bash
node packages/ui/scripts/spec-summary.mjs <name>        # changes from rest per state
node packages/ui/scripts/spec-summary.mjs <name> --all  # every token
```

- `tokens` are the named assignments: implement these. `resolved` shows what
  they resolve to, which matters when the resolver picked a value the token
  name does not say (Button: primary text is `neutral-2`, the theme's primary
  foreground; danger text is black in both modes).
- Token vocabularies: padding, gap and `controlSize` use the spacing scale
  (`controlSize: l` = `--space-l`); `radius` the corner scale; `textSize` and
  `lineHeight` a text style; `letterSpacing` the tracking scale;
  `weight` the role weights; `shadow`/`shadows` the shadow scale. Specs from
  the earlier theme download name the `ui` font role: it is `body` now
  (`brand` is `display`).
- `borderWidth` names the border scale, which is 0 everywhere in this theme.
  Implement the edge anyway so it follows the theme. A numeric `borderWidth`
  (Separator's `1`) is a local value: keep it local.
- `borderInset: true` means an inner edge (`inset-ring-*`), otherwise outer
  (`ring-*`).
- Implement only the states the spec lists, plus the generic ones below.

## Tokens at use sites

Use named tokens only. Literal colors, pixel sizes and durations belong in
the theme, never in a component. Utility names are Graphical's:

| Role              | Utilities                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Colors            | `bg-`, `text-`, `ring-`, `inset-ring-`, `fill-` with `color-1`…`color-4`, `neutral-1`…`neutral-10`, `success`, `warning`, `error`, each also `-transparent` and `-translucent`; roles `cte-canvas`, `cte-surface`, `cte-surface-muted`, `cte-text`, `cte-text-muted`, `cte-border`, `cte-accent`, `cte-accent-text`, `cte-danger`, `cte-focus`; `transparent`, `current` |
| Type              | `text-body-{xxs…xxl}` and `text-display-{xxs…xxl}` (size, line height and tracking together), `tracking-{xs,s,m,l,xl}` for an explicit letter spacing, `font-{body,display,data}`, `font-{regular,medium,heavy}` (the weight of the current font role)                                                                                                                   |
| Spacing and sizes | `p-`, `m-`, `gap-`, `w-`, `h-`, `size-`, `inset-`… with `zero`, `xxs`, `xs`, `s`, `m`, `l`, `xl`, `xxl` (`0` also works)                                                                                                                                                                                                                                                 |
| Corners           | `corner-{zero,xs,s,m,l,xl,full}`, sides such as `corner-t-s` (`rounded-*` keeps Tailwind's meaning)                                                                                                                                                                                                                                                                      |
| Elevation         | `shadow-{s,m,l}` (only `m` is visible in this theme), `shadow-none`                                                                                                                                                                                                                                                                                                      |
| Edges             | `ring-{none,s,m,l}` + `ring-<color>`; `inset-ring-*` for inner edges                                                                                                                                                                                                                                                                                                     |
| Motion            | `duration-motion ease-motion` (small), `duration-motion-large ease-motion-large` (large); `transition-*` defaults to the small curve                                                                                                                                                                                                                                     |
| Other tokens      | arbitrary variable syntax: `size-(--line-s)`, `translate-y-(--motion-press-distance)`, `scale-(--motion-popup-scale)`                                                                                                                                                                                                                                                    |

Tailwind's default scales are removed: `p-4`, `w-64`, `text-sm`,
`rounded-md`, `shadow-lg`, `font-semibold`, `bg-white`, `max-w-md` generate
nothing. `src/styles/theme.test.ts` fails on any class in `src/` that
generates no CSS. Note that `w-xs` is the 8px spacing token, not a container
width.

Structural layout (grid tracks, content widths, breakpoints, aspect ratios) is
not themed: use arbitrary values such as `max-w-[72rem]`,
`grid-cols-[3rem_1fr]`, `w-[24rem]`.

Visible edges are box shadows, never `border`: native border width stays 0.
`ring-*`, `inset-ring-*`, `inset-shadow-*` and `shadow-*` compose into one
`box-shadow`, so an edge and an elevation can coexist. A one-sided divider is
an inset shadow (see Separator).

Typography is inherited from the theme scope (body font, Body S).
`text-wrap: pretty` is set on the root; controls that must stay on one line
use `whitespace-nowrap`. Apply the spec's typography in full: for a part with
`textSize: s, lineHeight: s, letterSpacing: l, weight: medium`, write
`font-body font-medium text-body-s`: the text style carries its line height
and tracking, so add `tracking-*` only where the spec departs from it.

Use `cn()` to combine classes and `mergeClassName(base, className)` when the
prop may be a Base UI state function. `cn` knows the theme scales, so
`cn("px-l", "px-m")` keeps `px-m` and `cn("text-body-s", "text-neutral-10")`
keeps both.

## States

Cover every state the spec lists, in both modes:

- **rest**
- **hover**: `control-hover:` (only with a hover-capable pointer, not while
  focused, disabled or pending)
- **focus-visible**: `focus-ring` (the 2px keyboard outline in `cte-focus`)
  on every focusable part, plus `control-focus:` for the spec's focus fills
  and edges. Keep the outline even with selected, checked or open fills.
  When an ancestor draws the outline (a field around its input, a clipping
  root around its viewport), use `focus-ring-within`, under a variant naming
  the focused part when only that part counts:
  `has-[[data-slot=combobox-input]:focus-visible]:focus-ring-within`.
- **active/pressed**: `motion-safe:control-pressed:translate-y-(--motion-press-distance)`
  for controls the spec presses; Base UI's `data-pressed` for toggles.
- **disabled**: `control-disabled:` (Base UI sets `data-disabled`).
- **invalid**: Base UI Field sets `data-invalid` on its parts; style it
  distinctly, never as disabled.
- **loading**: follow Button's `isPending`: keep the size and focus
  (`focusableWhenDisabled`), set `aria-busy` and `data-pending`, block input,
  show a loading layer. `control-pending:` targets it. Loading is not disabled.
- **open/closed, checked, selected, highlighted**: Base UI data attributes
  (`data-open`, `data-popup-open`, `data-checked`, `data-unchecked`,
  `data-indeterminate`, `data-selected`, `data-highlighted`,
  `data-orientation`, `data-side`). Check the attributes in the installed
  declarations: `node_modules/@base-ui/react/<component>/*DataAttributes.d.ts`.

The custom variants encode the theme's precedence: disabled before focused,
focused before hovered, otherwise rest. Colors flip with the mode on their
own; use `dark:` only when the spec resolves a different token per mode (the
danger label). `dark:` follows the nearest theme scope, so a light
`ThemeScope` inside a dark page stays light, popups portalled into it
included; `light-dark()` is not needed for nested scopes.

## data-slot

- Root part: `data-slot="<component>"`; other parts:
  `data-slot="<component>-<part>"` (`menu-popup`, `menu-item`,
  `switch-thumb`), placed before `{...props}`.
- Variants and sizes as `data-variant` and `data-size` on the root.
- Every icon renders `data-slot="icon"`; style icons inside a component with
  `**:data-[slot=icon]:shrink-0` and similar.

## Icons

Import semantic names from the icon entry point, never from a provider:

```tsx
import { ChevronDownIcon, XIcon } from "../icon"; // inside packages/ui
import { MicrophoneIcon } from "@sondine/ui/icon"; // in the app
```

Icons are 1em squares in `currentColor`, so they follow the label's size and
color. They are decorative (`aria-hidden`) unless given `title`; icon-only
controls need `aria-label`. Micro-bold glyphs (check, x, chevrons, arrows,
plus, minus, loader) take `strokeWidth`.

The glyph files in `src/icon/nucleo/` are generated from Téo's licensed
Nucleo install and must not be edited by hand. To request a glyph, add an
entry to `src/icon/icons.json` (`"name": { "set": "ui-fill-18" |
"micro-bold", "glyph": "Icon…" }`) and list it in your result for Téo to run
`pnpm --filter @sondine/ui icons:generate <licensed node_modules>`. The budget
is 100 glyphs (ADR 009); 69 are used. Prefer `ui-fill-18`; use `micro-bold`
for small stroke primitives.

## Motion

- CSS transitions on the properties that change:
  `transition-[background-color,color,box-shadow,translate] duration-motion ease-motion motion-reduce:transition-none`.
- Small curve for controls, menus and small popovers; large curve for
  dialogs, drawers, toasts, navigation surfaces and disclosure panels.
- Base UI popups animate with `data-starting-style:` / `data-ending-style:`
  (opacity, and `scale-(--motion-popup-scale)` with
  `origin-(--transform-origin)` for popovers and menus). Base UI waits for
  the transition before unmounting; do not add timers.
- Motion for React (`motion/react`) when CSS cannot do it: use
  `smallTransition` / `largeTransition` and `popupScale` from `../lib/motion`.
  With `useReducedMotion()`, drop transforms and keep opacity. For popups,
  follow the Base UI animation handbook (`keepMounted` + `AnimatePresence`).
- Loops (spinners): `animate-spin motion-reduce:animate-none`.

## Base UI

- Import each primitive from its subpath (`@base-ui/react/menu`) and check
  props against the installed declarations and docs in
  `node_modules/@base-ui/react/docs/react/` (version 1.9.0).
- Wrap each part in a function that sets `data-slot` and classes, then spreads
  the caller's props so `render`, refs (React 19 props), handlers and ARIA
  attributes reach the primitive. Never swallow `render`, `className` or
  `style`.
- Compose with the `render` prop, for example
  `<MenuTrigger render={<Button variant="secondary" />}>`.
- Portals: pass `container={usePortalContainer()}` (from `../theme/portal-container`)
  to every `X.Portal`, so a popup opened inside a `ThemeScope` keeps that
  scope's mode. Outside a scope it returns `undefined` and the portal goes to
  `<body>`, which inherits the theme from `<html>`.
- No user-facing strings inside components: labels come in through props or
  children so the app can translate them (Paraglide).

## Design-system section

Every component ships with a section in the same change:

```tsx
// src/design-system/sections/switch.tsx
import { Switch } from "../../components/switch";
import { Section, Specimen } from "../section";

export default function SwitchSection() {
  return (
    <Section id="switch" title="Switch">
      <Specimen label="States">…</Specimen>
    </Section>
  );
}
```

The page collects `./sections/*.tsx` automatically, foundations first, then
by file name (`export const order = <number>` to move a section). Show every
variant, size and state that can be rendered statically: rest, disabled,
invalid, pending, checked, and open (via `defaultOpen`) where relevant. Hover,
focus and pressed are checked interactively. Keep labels short; no
explanatory copy.

A section must not open a modal or take focus on load. Preview an open
dialog, popover or palette statically: a stage with `contain-layout` (it
contains the popup's fixed positioning) around a `PortalContainer`, and a
root with `modal={false}` and `disablePointerDismissal`, its popup with
`initialFocus={false}` (see the dialog section). Primitives without
`initialFocus` (Menu, Select) render `open` inside an `inert` stage, so focus
cannot enter it; Select also scrolls its selected option into view, so its
preview opens once on screen (see the select section).

## Verify

Run from the repository root:

```bash
pnpm --filter @sondine/ui typecheck
pnpm --filter @sondine/ui test          # includes the class check and icon check
pnpm --filter @sondine/ui check:icons
pnpm --filter @sondine/ui screenshot <out-dir> [--section <id>]
```

`screenshot` builds the playground and writes the whole page, 1440 px wide,
to `design-system-light.png` and `design-system-dark.png` (headless Chrome).
`--section <id>` crops both to one section
(`design-system-<id>-{light,dark}.png`). It fails when a section takes focus
or scrolls the page on load. Check both modes, every state you render,
typography (the foundations label must read "Timeless Grotesk (loaded)") and
icons.

`pnpm --filter @sondine/ui dev` serves the playground for hover, focus,
keyboard and popup checks; stop the server when done.

Tests run in Node without a DOM: render with `renderToStaticMarkup` and assert
slots, ARIA, data attributes and variant classes (see
`src/components/button.test.tsx`).

Report each spec as converted, already matches, intentionally preserved or
blocked. A missing token or size is a theme gap to report, not a value to
invent (Button has no authored sizes beyond its default and an icon-only
square).
