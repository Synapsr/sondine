import { type ComponentType, useEffect, useState } from "react";
import * as icons from "../../icon";
import type { IconProps } from "../../icon";
import { useTheme } from "../../theme/theme-provider";
import { Section, Specimen } from "../section";

export const order = 0;

const palette = ["color-1", "color-2", "color-3", "color-4"];
const neutrals = Array.from({ length: 10 }, (_, index) => `neutral-${index + 1}`);
const statusColors = ["success", "warning", "error"];
const roles = [
  "cte-canvas",
  "cte-surface",
  "cte-surface-muted",
  "cte-text",
  "cte-text-muted",
  "cte-border",
  "cte-accent",
  "cte-accent-text",
  "cte-danger",
  "cte-focus",
];

// Literal class names so Tailwind generates them; each pairs a token with its utility.
const steps = ["xxl", "xl", "l", "m", "s", "xs", "xxs"] as const;
// Complete class names, so Tailwind finds them in source.
const textScales = [
  {
    name: "Body",
    prefix: "",
    classNames: {
      xxl: "text-body-xxl",
      xl: "text-body-xl",
      l: "text-body-l",
      m: "text-body-m",
      s: "text-body-s",
      xs: "text-body-xs",
      xxs: "text-body-xxs",
    },
  },
  {
    name: "Display",
    prefix: "display-",
    classNames: {
      xxl: "font-display text-display-xxl",
      xl: "font-display text-display-xl",
      l: "font-display text-display-l",
      m: "font-display text-display-m",
      s: "font-display text-display-s",
      xs: "font-display text-display-xs",
      xxs: "font-display text-display-xxs",
    },
  },
] as const;
const weights = [
  { name: "regular", className: "font-regular" },
  { name: "medium", className: "font-medium" },
  { name: "heavy", className: "font-heavy" },
];
const spaces = [
  { name: "xxs", className: "w-xxs" },
  { name: "xs", className: "w-xs" },
  { name: "s", className: "w-s" },
  { name: "m", className: "w-m" },
  { name: "l", className: "w-l" },
  { name: "xl", className: "w-xl" },
  { name: "xxl", className: "w-xxl" },
];
const radii = [
  { name: "zero", className: "corner-zero" },
  { name: "xs", className: "corner-xs" },
  { name: "s", className: "corner-s" },
  { name: "m", className: "corner-m" },
  { name: "l", className: "corner-l" },
  { name: "xl", className: "corner-l" },
  { name: "full", className: "corner-full" },
];
const shadows = [
  { name: "s", className: "shadow-s" },
  { name: "m", className: "shadow-m" },
  { name: "l", className: "shadow-l" },
];
const motionTokens = [
  "--motion-duration",
  "--motion-easing",
  "--motion-large-duration",
  "--motion-large-easing",
  "--motion-popup-scale",
  "--motion-press-distance",
];

function isIcon(entry: [string, unknown]): entry is [string, ComponentType<IconProps>] {
  return entry[0].endsWith("Icon") && typeof entry[1] === "function";
}
// Widened first, so the guard alone says which exports are glyphs (BrandMark is not).
const exported: readonly [string, unknown][] = Object.entries(icons);
const iconEntries = exported.filter(isIcon);

function useTokenValues(names: readonly string[]): Record<string, string> {
  const { resolvedTheme } = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()])));
  }, [names, resolvedTheme]);
  return values;
}

function useFontStatus(): string {
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    let active = true;
    // load() resolves with the matching faces; none means the @font-face is missing.
    document.fonts
      .load('400 16px "Timeless Grotesk"')
      .then((faces) => faces.length > 0 && faces.every((face) => face.status === "loaded"))
      .catch(() => false)
      .then((loaded) => {
        if (active) setStatus(loaded ? "loaded" : "not loaded");
      });
    return () => {
      active = false;
    };
  }, []);
  return status;
}

function Swatch({ token }: { token: string }) {
  return (
    <figure className="flex w-[7.5rem] flex-col gap-xxs">
      <div className="flex h-xxl overflow-hidden corner-xs ring-1 ring-cte-border">
        <div className="flex-1" style={{ background: `var(--${token})` }} />
        {token.startsWith("cte-") ? null : (
          <div className="flex-1" style={{ background: `var(--${token}-transparent)` }} />
        )}
      </div>
      <figcaption className="text-body-xxs text-cte-text-muted">{token}</figcaption>
    </figure>
  );
}

function TokenTable({ names }: { names: readonly string[] }) {
  const values = useTokenValues(names);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-l gap-y-xxs font-data text-body-xs">
      {names.map((name) => (
        <div key={name} className="contents">
          <dt className="text-cte-text-muted">{name}</dt>
          <dd>{values[name] ?? ""}</dd>
        </div>
      ))}
    </dl>
  );
}

const textTokenNames = textScales.flatMap(({ prefix }) =>
  steps.flatMap((step) => [
    `--${prefix}size-${step}`,
    `--${prefix}line-${step}`,
    `--${prefix}letter-spacing-${step}`,
  ]),
);

export default function FoundationsSection() {
  const fontStatus = useFontStatus();
  const sizes = useTokenValues(textTokenNames);

  return (
    <Section id="foundations" title="Foundations">
      <Specimen label="Palette (solid, transparent)">
        {palette.map((token) => (
          <Swatch key={token} token={token} />
        ))}
      </Specimen>
      <Specimen label="Neutrals">
        {neutrals.map((token) => (
          <Swatch key={token} token={token} />
        ))}
      </Specimen>
      <Specimen label="Status">
        {statusColors.map((token) => (
          <Swatch key={token} token={token} />
        ))}
      </Specimen>
      <Specimen label="Roles">
        {roles.map((token) => (
          <Swatch key={token} token={token} />
        ))}
      </Specimen>

      {textScales.map(({ name, prefix, classNames }) => (
        <Specimen
          key={name}
          label={`${name} text, Timeless Grotesk (${fontStatus})`}
          className="flex-col items-start gap-xs"
        >
          {steps.map((step) => (
            <div key={step} className="grid grid-cols-[3rem_9rem_1fr] items-baseline gap-l">
              <span className="font-data text-body-xxs text-cte-text-muted">{step}</span>
              <span className="font-data text-body-xxs text-cte-text-muted">
                {sizes[`--${prefix}size-${step}`]} / {sizes[`--${prefix}line-${step}`]} ·{" "}
                {sizes[`--${prefix}letter-spacing-${step}`]}
              </span>
              <p className={classNames[step]}>Auditory memory, kept on this Mac</p>
            </div>
          ))}
        </Specimen>
      ))}
      <Specimen label="Weights and italic" className="gap-l">
        {weights.map(({ name, className }) => (
          <p key={name} className={`text-body-m ${className}`}>
            {name}
          </p>
        ))}
        <p className="text-body-m">
          <em>italic, “ital” 100</em>
        </p>
      </Specimen>

      <Specimen label="Spacing" className="flex-col items-start gap-xs">
        {spaces.map(({ name, className }) => (
          <div key={name} className="flex items-center gap-s">
            <span className="w-xxl font-data text-body-xxs text-cte-text-muted">{name}</span>
            <div className={`h-s corner-zero bg-color-1 ${className}`} />
          </div>
        ))}
      </Specimen>
      <Specimen label="Radius">
        {radii.map(({ name, className }) => (
          <figure key={name} className="flex flex-col items-center gap-xxs">
            <div className={`size-[4rem] bg-neutral-3 ${className}`} />
            <figcaption className="text-body-xxs text-cte-text-muted">{name}</figcaption>
          </figure>
        ))}
      </Specimen>
      <Specimen label="Shadows (only m is visible in this theme)" className="gap-l">
        {shadows.map(({ name, className }) => (
          <figure key={name} className="flex flex-col items-center gap-xs">
            <div className={`size-[5rem] corner-s bg-cte-canvas ${className}`} />
            <figcaption className="text-body-xxs text-cte-text-muted">{name}</figcaption>
          </figure>
        ))}
      </Specimen>
      <Specimen label="Motion">
        <TokenTable names={motionTokens} />
      </Specimen>

      <Specimen
        label={`Icons (${iconEntries.length})`}
        className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-xs"
      >
        {iconEntries.map(([name, Icon]) => (
          <figure
            key={name}
            className="flex flex-col items-center gap-xs corner-xs bg-cte-surface px-xs py-s"
          >
            <Icon className="text-body-xxl" />
            <figcaption className="text-body-xxs text-cte-text-muted">
              {name.replace(/Icon$/, "")}
            </figcaption>
          </figure>
        ))}
      </Specimen>
      <Specimen label="Brand marks" className="flex flex-wrap gap-xs">
        {(["youtube", "vimeo", "twitch"] as const).map((brand) => (
          <figure
            key={brand}
            className="flex w-[7.5rem] flex-col items-center gap-xs corner-xs bg-cte-surface px-xs py-s"
          >
            <icons.BrandMark brand={brand} className="text-body-xxl" />
            <figcaption className="text-body-xxs text-cte-text-muted">{brand}</figcaption>
          </figure>
        ))}
      </Specimen>
      <Specimen label="Wordmark" className="flex">
        <icons.SondineLogo className="w-[12rem]" />
      </Specimen>
    </Section>
  );
}
