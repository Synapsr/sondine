// Writes graphical/install/import.json, the install script's input: the
// Sondine theme as authored, the role map of its tokens, and their values.
// Run from the repository root: node graphical/install/import.mjs
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The editor is installed in the git-ignored graphical/packages (ADR 033). Its `install`
// entry has only an `import` condition, so it is found beside the analyzer.
const editor = createRequire(new URL("../packages/package.json", import.meta.url));
const dist = dirname(editor.resolve("@graphical/editor/analyze-styles"));
const { extendRoleMap, graphicalProfile } = await import(
  pathToFileURL(join(dist, "install.js")).href
);

const tokensCss = { path: "packages/ui/src/styles/tokens.css", selector: ":root" };
const themeCss = { path: "packages/ui/src/styles/theme.css", selector: "@theme" };

// Sondine already speaks Graphical's names (an earlier theme download), with
// the older font roles: UI is body, Brand is display. Editorial sets the
// transcript's reading text, so it is body too.
const legacyFonts = [
  ["ui", "body"],
  ["brand", "display"],
  ["editorial", "body"],
  ["data", "data"],
].flatMap(([from, to]) => [
  ...(from === to ? [] : [{ variable: `--font-${from}`, token: `font.${to}`, defined: themeCss }]),
  ...["regular", "medium", "heavy"].map((weight) => ({
    variable: `--weight-${from}-${weight}`,
    token: `weight.${to}.${weight}`,
    format: "number",
    defined: tokensCss,
  })),
]);

// Sondine's semantic names, kept as aliases of Graphical's tokens.
const semantic = [
  ["--cte-canvas", "neutral-1"],
  ["--cte-surface", "neutral-2"],
  ["--cte-surface-muted", "neutral-3"],
  ["--cte-text", "neutral-10"],
  ["--cte-text-muted", "neutral-7"],
  ["--cte-border", "neutral-4-transparent"],
  ["--cte-accent", "color-1"],
  ["--cte-accent-text", "on:color-1"],
  ["--cte-danger", "error"],
  ["--cte-focus", "color-1"],
  ["--border-default-color", "neutral-4-transparent"],
  ["--option-badge-background", "neutral-4"],
  ["--option-badge-foreground", "neutral-10"],
  ["--navigation-active-background", "neutral-4"],
  ["--navigation-active-foreground", "neutral-10"],
  ["--emphasis-chart-fill", "color-1-transparent"],
  ["--emphasis-balance-background", "neutral-5"],
  ["--emphasis-rewards-background", "neutral-3"],
  ["--emphasis-icon-background", "neutral-3"],
  ["--emphasis-icon-foreground", "neutral-10"],
  ["--emphasis-type-background", "neutral-3"],
  ["--emphasis-type-foreground", "neutral-10"],
].map(([variable, token]) => ({ variable, token, defined: tokensCss }));

// The body text every scope inherits (base.css), and the detail text.
const bodyText = [
  ["--cte-font", "font.body"],
  ["--cte-font-size", "text.s.size", "px"],
  ["--cte-font-weight", "weight.body.regular", "number"],
  ["--cte-line-height", "text.s.lineHeight", "px"],
  ["--cte-letter-spacing", "text.s.tracking", "em"],
  ["--cte-detail-font-size", "text.xs.size", "px"],
  ["--cte-detail-line-height", "text.xs.lineHeight", "px"],
  ["--cte-detail-letter-spacing", "text.xs.tracking", "em"],
].map(([variable, token, format]) => ({
  variable,
  token,
  ...(format ? { format } : {}),
  defined: tokensCss,
}));

const motion = [
  ["--motion-duration", "motion.small.duration", "ms"],
  ["--motion-easing", "motion.small.easing"],
  ["--motion-large-duration", "motion.large.duration", "ms"],
  ["--motion-large-easing", "motion.large.easing"],
].map(([variable, token, format]) => ({
  variable,
  token,
  ...(format ? { format } : {}),
  defined: tokensCss,
}));

const roleMap = extendRoleMap(
  // ThemeProvider sets data-theme (and a matching class) on <html>;
  // ThemeScope sets it on a subtree that forces one mode.
  graphicalProfile({
    modes: { kind: "attribute", attribute: "data-theme", dark: "dark", light: "light" },
  }),
  {
    tokens: [...legacyFonts, ...semantic, ...bodyText, ...motion],
    // Sondine defines four palette colors and no translucent levels.
    remove: [
      ...[5, 6, 7, 8, 9, 10].flatMap((n) => [
        `--color-${n}`,
        `--color-${n}-translucent`,
        `--color-${n}-transparent`,
      ]),
      ...["1", "2", "3", "4"].map((n) => `--color-${n}-translucent`),
      ...Array.from({ length: 10 }, (_, n) => `--neutral-${n + 1}-translucent`),
      ...["success", "warning", "error"].map((name) => `--${name}-translucent`),
      "--font-body",
      "--font-display",
      ...["regular", "medium", "heavy"].flatMap((weight) => [
        `--weight-body-${weight}`,
        `--weight-display-${weight}`,
      ]),
      ...["xxs", "xs", "s", "m", "l", "xl", "xxl"].flatMap((step) => [
        `--display-size-${step}`,
        `--display-line-${step}`,
        `--display-letter-spacing-${step}`,
      ]),
    ],
    appearance: {
      // A subtle sidebar (Neutral 2 beside the Neutral 1 page) and surfaced panels.
      initial: { navigation: "subtle", grouping: "cards", surface: "raised" },
      // Sondine's sidebar, not the editor's own panel (also an <aside>).
      navigation: { selector: "[data-graphical-host] aside" },
    },
  },
);

const family = '"Timeless Grotesk", sans-serif';
const weights = { regular: 400, medium: 500, heavy: 600 };

// The saved Sondine theme (GUI.md, Theme values), as the app renders it.
const document = {
  name: "Sondine",
  theme: {
    // Primary buttons: Color 1 with Neutral 2 labels, as the app draws them.
    primaryActionColor: "color-1",
    primaryForeground: { light: "neutral-2", dark: "neutral-2" },
    neutralTone: "neutral",
    colorEmphasis: 24.820963541666664,
    buttonRadius: "s",
    // The saved icon settings; Sondine draws Nucleo icons (ADR 009).
    iconFamily: "Hugeicons",
    iconStyle: "filled",
    iconWeight: 400,
    // Transparent levels are 20% of their color everywhere (tokens.css).
    colorTranslucency: Object.fromEntries(
      ["light", "dark"].map((mode) => [
        mode,
        Object.fromEntries(
          [
            "color-1",
            "color-2",
            "color-3",
            "color-4",
            ...Array.from({ length: 10 }, (_, n) => `neutral-${n + 1}`),
            "success",
            "warning",
            "error",
          ].map((key) => [key, 20]),
        ),
      ]),
    ),
    colors: {
      light: {
        "color-1": "#ff5a00",
        "color-2": "#153d85",
        "color-3": "#bfe8f5",
        "color-4": "#ffd0b0",
        "neutral-1": "#ffffff",
        "neutral-2": "#fbfbfb",
        "neutral-3": "#f4f4f4",
        "neutral-4": "#e7e7e7",
        "neutral-5": "#cdcdcd",
        "neutral-6": "#a1a1a1",
        "neutral-7": "#7d7d7d",
        "neutral-8": "#555555",
        "neutral-9": "#333333",
        "neutral-10": "#000000",
        success: "#00906c",
        warning: "#ffea00",
        error: "#fc032d",
      },
      dark: {
        "color-1": "#ff5a00",
        "color-2": "#153d85",
        "color-3": "#bfe8f5",
        "color-4": "#ffd0b0",
        "neutral-1": "#000000",
        "neutral-2": "#202020",
        "neutral-3": "#2b2b2b",
        "neutral-4": "#3d3d3d",
        "neutral-5": "#565656",
        "neutral-6": "#838383",
        "neutral-7": "#ababab",
        "neutral-8": "#cfcfcf",
        "neutral-9": "#f4f4f4",
        "neutral-10": "#ffffff",
        success: "#00906c",
        warning: "#ffea00",
        error: "#fc032d",
      },
    },
    fonts: {
      body: { family, weights },
      display: { family, weights },
      data: { family, weights },
    },
    spacing: { zero: 0, xxs: 4, xs: 8, s: 13, m: 17, l: 25, xl: 34, xxl: 51 },
    letterSpacing: { xs: -0.02, s: -0.01, m: 0, l: 0.01, xl: 0.02 },
    text: {
      xxs: { size: 10, lineHeight: 14 },
      xs: { size: 12, lineHeight: 16 },
      s: { size: 14, lineHeight: 20 },
      m: { size: 16, lineHeight: 25 },
      l: { size: 25, lineHeight: 33 },
      xl: { size: 37, lineHeight: 41 },
      xxl: { size: 49, lineHeight: 53 },
    },
    radius: { zero: 0, xs: 8, s: 12, m: 18, l: 28, xl: 30, full: 9999 },
    border: { none: 0, s: 0, m: 0, l: 0 },
    shadows: {
      s: {
        x: 0,
        y: 2,
        blur: 4,
        spread: 0,
        opacity: 0,
        color: { light: "neutral-10", dark: "neutral-1" },
      },
      m: {
        x: 0,
        y: 8,
        blur: 24,
        spread: 0,
        opacity: 12,
        color: { light: "neutral-10", dark: "neutral-1" },
      },
      l: {
        x: 0,
        y: 16,
        blur: 48,
        spread: 0,
        opacity: 0,
        color: { light: "neutral-10", dark: "neutral-1" },
      },
    },
    animation: {
      duration: 200,
      easing: [0.16, 1, 0.3, 1],
      large: { duration: 360, easing: [0.22, 1, 0.36, 1] },
      popupScale: 0.96,
      pressDistance: 1,
    },
  },
};

// The authored values, as tokens.css and theme.css write them.
const neutrals = (values) =>
  Object.fromEntries(values.map((value, index) => [`--neutral-${index + 1}`, value]));
const shared = {
  "--color-1": "#ff5a00",
  "--color-2": "#153d85",
  "--color-3": "#bfe8f5",
  "--color-4": "#ffd0b0",
  "--success": "#00906c",
  "--warning": "#ffea00",
  "--error": "#fc032d",
  "--font-ui": family,
  "--font-brand": family,
  "--font-editorial": family,
  "--font-data": family,
  "--shadow-s": "0px 2px 4px 0px #00000000",
  "--shadow-m": "0px 2px 6px 0px #0000000d, 0px 8px 24px 0px #00000013",
  "--shadow-l": "0px 16px 48px 0px #00000000",
  "--motion-duration": "200ms",
  "--motion-easing": "cubic-bezier(0.16, 1, 0.3, 1)",
  "--motion-large-duration": "360ms",
  "--motion-large-easing": "cubic-bezier(0.22, 1, 0.36, 1)",
};
const source = {
  light: {
    ...shared,
    ...neutrals([
      "#ffffff",
      "#fbfbfb",
      "#f4f4f4",
      "#e7e7e7",
      "#cdcdcd",
      "#a1a1a1",
      "#7d7d7d",
      "#555555",
      "#333333",
      "#000000",
    ]),
  },
  dark: {
    ...shared,
    ...neutrals([
      "#000000",
      "#202020",
      "#2b2b2b",
      "#3d3d3d",
      "#565656",
      "#838383",
      "#ababab",
      "#cfcfcf",
      "#f4f4f4",
      "#ffffff",
    ]),
  },
};

await writeFile(
  new URL("./import.json", import.meta.url),
  `${JSON.stringify({ document, roleMap, source }, null, 2)}\n`,
);
