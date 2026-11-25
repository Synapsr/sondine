# Graphical install

Rewrote 74 source files and wrote the project files in `graphical`.

## Use sites

| Family | Rewritten | Removed | Skipped | Tokens | Kept | Preserved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| border-width | 0 | 0 | 0 | 0 | 0 | 4 |
| color | 0 | 0 | 0 | 87 | 8 | 340 |
| font-family | 63 | 0 | 0 | 0 | 0 | 0 |
| font-size | 251 | 0 | 0 | 0 | 0 | 0 |
| font-weight | 77 | 0 | 0 | 1 | 0 | 0 |
| letter-spacing | 0 | 8 | 0 | 9 | 0 | 0 |
| line-height | 1 | 48 | 0 | 1 | 0 | 0 |
| radius | 90 | 0 | 0 | 0 | 0 | 1 |
| shadow | 0 | 0 | 0 | 0 | 6 | 2 |
| spacing | 4 | 0 | 0 | 493 | 0 | 7 |
| token | 114 | 0 | 0 | 0 | 0 | 0 |

Removed: line heights and tracking a text style carries instead. Tokens: uses of the app’s own tokens, such as `bg-background`, which follow the token once it aliases a Graphical one, and classes that already have Graphical’s name, such as `font-medium`. Kept: values the conversion keeps as authored. Preserved: values the analysis preserved, such as content colors, artwork, state recipes and dynamic values.

## Units

| Family | Values | Units | Multiples | Kept |
| --- | ---: | ---: | ---: | ---: |
| Colors | 34 | 17 | 0 | 0 |
| Text sizes | 7 | 7 | 0 | 0 |
| Font weights | 3 | 3 | 0 | 0 |
| Letter spacing | 4 | 4 | 0 | 0 |
| Spacing | 7 | 7 | 0 | 0 |
| Corners | 5 | 4 | 0 | 0 |
| Shadows | 3 | 3 | 0 | 0 |

## Style coverage

- `apps/desktop/src/renderer/components/chat/chat-screen.tsx:186`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/episode/context-strip.tsx:446`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/episode/transcript.tsx:455`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/episode/transcript.tsx:824`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/episode/transcript.tsx:841`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/episode/voice-name.tsx:124`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/player/speech-scrubber.tsx:81`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/player/speech-scrubber.tsx:93`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/search/search-screen.tsx:446`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/shell/app-icon.tsx:29`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/shell/app-icon.tsx:34`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/shell/app-icon.tsx:60`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/shell/app-sidebar.tsx:79`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/shell/app-sidebar.tsx:42`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/shell/app-sidebar.tsx:109`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/shell/listening-banner.tsx:94`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/shell/listening-panel.tsx:80`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/shell/listening-panel.tsx:127`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/status/memory-bar.tsx:46`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/status/memory-bar.tsx:65`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/today/ongoing.tsx:106`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `apps/desktop/src/renderer/components/welcome/welcome-screen.tsx:54`: Cannot resolve class helper cn. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `packages/ui/src/lib/cn.ts:35`: Cannot resolve class helper twMerge. Include its source or convert and review this class expression manually. Needs source review before conversion is complete.
- `packages/ui/src/components/menu.tsx:69`: Class value menuItemTrailingClassName is also consumed as app data. Separate its class and data uses before conversion. Needs source review before conversion is complete.

## Font classes

- `font-ui` → `font-body`
- `font-brand` → `font-display`
- `font-editorial` → `font-body`

## Skipped sites

None.

## Text style overrides

0 already present in source; 1 retained during this conversion.

These stay beside their text style, so the inspector shows each as an override of it.

- `packages/ui/src/styles/base.css:22` `letter-spacing: var(--cte-letter-spacing);` on Body S: a value kept as authored

## Cleanup

Install grouped 11 long class lists by layout, box, type and appearance, then states.

## Kept values

None.

## Warnings

- The app defines variables theme.css also defines: `--color-1`, `--color-1-transparent`, `--color-2`, `--color-2-transparent`, `--color-3`, `--color-3-transparent`, `--color-4`, `--color-4-transparent`, `--neutral-1`, `--neutral-1-transparent`, `--neutral-2`, `--neutral-2-transparent`, `--neutral-3`, `--neutral-3-transparent`, `--neutral-4`, `--neutral-4-transparent`, `--neutral-5`, `--neutral-5-transparent`, `--neutral-6`, `--neutral-6-transparent`, `--neutral-7`, `--neutral-7-transparent`, `--neutral-8`, `--neutral-8-transparent`, `--neutral-9`, `--neutral-9-transparent`, `--neutral-10`, `--neutral-10-transparent`, `--success`, `--success-transparent`, `--warning`, `--warning-transparent`, `--error`, `--error-transparent`, `--space-zero`, `--space-xxs`, `--space-xs`, `--space-s`, `--space-m`, `--space-l`, `--space-xl`, `--space-xxl`, `--size-xxs`, `--line-xxs`, `--letter-spacing-xxs`, `--size-xs`, `--line-xs`, `--letter-spacing-xs`, `--size-s`, `--line-s`, `--letter-spacing-s`, `--size-m`, `--line-m`, `--letter-spacing-m`, `--size-l`, `--line-l`, `--letter-spacing-l`, `--size-xl`, `--line-xl`, `--letter-spacing-xl`, `--size-xxl`, `--line-xxl`, `--letter-spacing-xxl`, `--tracking-xs`, `--tracking-s`, `--tracking-m`, `--tracking-l`, `--tracking-xl`, `--radius-zero`, `--radius-xs`, `--radius-s`, `--radius-m`, `--radius-l`, `--radius-xl`, `--border-none`, `--border-s`, `--border-m`, `--border-l`, `--shadow-s`, `--shadow-m`, `--shadow-l`, `--font-data`, `--weight-data-regular`, `--weight-data-medium`, `--weight-data-heavy`, `--cte-canvas`, `--cte-surface`, `--cte-surface-muted`, `--cte-text`, `--cte-text-muted`, `--cte-border`, `--cte-accent`, `--cte-accent-text`, `--cte-danger`, `--cte-focus`, `--border-default-color`, `--option-badge-background`, `--option-badge-foreground`, `--navigation-active-background`, `--navigation-active-foreground`, `--emphasis-chart-fill`, `--emphasis-balance-background`, `--emphasis-rewards-background`, `--emphasis-icon-background`, `--emphasis-icon-foreground`, `--emphasis-type-background`, `--emphasis-type-foreground`, `--cte-font`, `--cte-font-size`, `--cte-font-weight`, `--cte-line-height`, `--cte-letter-spacing`, `--cte-detail-font-size`, `--cte-detail-line-height`, `--cte-detail-letter-spacing`, `--motion-duration`, `--motion-easing`, `--motion-large-duration`, `--motion-large-easing`. Rename the app’s tokens as they become aliases; otherwise whichever loads last sets both.
- Install found no Prettier, so the files it rewrote keep its own formatting. Run the project’s formatter on them.

## Left to the agent

- Load `graphical/generated/theme.css` before the app’s styles. Install rewrote the token definitions written in CSS as aliases. Semantic names such as `bg-background` stay as aliases.
- Import `graphical/generated/tailwind-theme.css` right after `@import "tailwindcss"`.
- Resolve the skipped sites, install the theme’s fonts and mount the editor.
- Check the running app. This report and `graphical-install --check` read source, so they show the conversion is complete, not that the app runs. Load the home page and one other page with the dev server: each renders with the editor mounted, and the browser console and the framework’s error overlay show no errors. A page can answer HTTP 200 while a client error stops the editor from loading.
