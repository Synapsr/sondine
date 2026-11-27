import { cn } from "../lib/cn";
import { TwitchIcon, VimeoIcon, YoutubeIcon } from "./nucleo";

// A site's mark in its owner's colors (ADR 009): the one place where colors
// are not theme roles. The glyphs come from the Nucleo subset; the colors are
// the brand tokens of styles/tokens.css. Marks name a site beside its name,
// so they stay decorative.

export type Brand = "youtube" | "vimeo" | "twitch";

const color: Record<Brand, string> = {
  youtube: "text-brand-youtube",
  vimeo: "text-brand-vimeo",
  twitch: "text-brand-twitch",
};

/**
 * What the owner fills inside its mark, so it reads the same on a light and a
 * dark ground: YouTube's play triangle, Twitch's speech bubble (the glyphs
 * leave both open). Paths from the glyphs' own cut-outs, in their 32 grid.
 */
const inside: Partial<Record<Brand, string>> = {
  youtube: "M12.727 20.758V11.242l8.364 4.758z",
  twitch: "M26.714 15.929l-4.286 4.286h-4.286l-3.75 3.75v-3.75h-4.821V4.143h17.143z",
};

const glyph = { youtube: YoutubeIcon, vimeo: VimeoIcon, twitch: TwitchIcon } as const;

export function BrandMark({ brand, className }: { brand: Brand; className?: string }) {
  const Glyph = glyph[brand];
  const fill = inside[brand];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 32 32"
      data-slot="icon"
      data-brand={brand}
      aria-hidden
      className={cn(color[brand], className)}
    >
      {fill === undefined ? null : <path d={fill} className="fill-brand-inside" />}
      <Glyph size={32} />
    </svg>
  );
}
