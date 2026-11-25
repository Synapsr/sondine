import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge only knows Tailwind's default scale names; teach it
// Graphical's classes (graphical/generated/tailwind-theme.css) so that, for
// example, text-body-s (a text style) and text-neutral-10 (a color) are not
// treated as conflicting, and corner-*/edge-* override rounded-*/border-*
// for the same corners and sides. Mirrors what graphical-install writes as
// tailwind-merge.cjs, plus Sondine's motion and ring edges.
const sizeKeys = ["xxs", "xs", "s", "m", "l", "xl", "xxl"];
const cornerKeys = ["zero", "xs", "s", "m", "l", "xl", "full"];
const edgeKeys = ["none", "s", "m", "l"];

const cornerSides = ["t", "r", "b", "l", "tl", "tr", "br", "bl", "s", "e", "ss", "se", "ee", "es"];
// The corners each side group covers.
const cornerParts: Record<string, string[]> = {
  t: ["tl", "tr"],
  r: ["tr", "br"],
  b: ["br", "bl"],
  l: ["tl", "bl"],
  s: ["ss", "es"],
  e: ["se", "ee"],
};
const edgeSides = ["x", "y", "t", "r", "b", "l", "s", "e"];
const edgeParts: Record<string, string[]> = { x: ["r", "l"], y: ["t", "b"] };

const cornerGroups = Object.fromEntries([
  ["corner", [{ corner: cornerKeys }]],
  ...cornerSides.map((side) => [`corner-${side}`, [{ [`corner-${side}`]: cornerKeys }]]),
]);
const edgeGroups = Object.fromEntries([
  ["edge-w", [{ edge: edgeKeys }]],
  ...edgeSides.map((side) => [`edge-w-${side}`, [{ [`edge-${side}`]: edgeKeys }]]),
]);

const cornerConflicts = Object.fromEntries([
  [
    "corner",
    [
      ...cornerSides.map((side) => `corner-${side}`),
      "rounded",
      ...cornerSides.map((side) => `rounded-${side}`),
    ],
  ],
  ["rounded", ["corner", ...cornerSides.map((side) => `corner-${side}`)]],
  ...cornerSides.flatMap((side) => {
    const parts = cornerParts[side] ?? [];
    return [
      [
        `corner-${side}`,
        [
          ...parts.map((part) => `corner-${part}`),
          `rounded-${side}`,
          ...parts.map((part) => `rounded-${part}`),
        ],
      ],
      [`rounded-${side}`, [`corner-${side}`, ...parts.map((part) => `corner-${part}`)]],
    ];
  }),
]);
const edgeConflicts = Object.fromEntries([
  [
    "edge-w",
    [
      ...edgeSides.map((side) => `edge-w-${side}`),
      "border-w",
      ...edgeSides.map((side) => `border-w-${side}`),
    ],
  ],
  ["border-w", ["edge-w", ...edgeSides.map((side) => `edge-w-${side}`)]],
  ...edgeSides.flatMap((side) => {
    const parts = edgeParts[side] ?? [];
    return [
      [
        `edge-w-${side}`,
        [
          ...parts.map((part) => `edge-w-${part}`),
          `border-w-${side}`,
          ...parts.map((part) => `border-w-${part}`),
        ],
      ],
      [`border-w-${side}`, [`edge-w-${side}`, ...parts.map((part) => `edge-w-${part}`)]],
    ];
  }),
]);

const twMerge = extendTailwindMerge<string, string>({
  extend: {
    theme: {
      spacing: ["zero", ...sizeKeys],
      text: [
        ...sizeKeys.map((step) => `body-${step}`),
        ...sizeKeys.map((step) => `display-${step}`),
      ],
      font: ["body", "display", "data"],
      "font-weight": ["regular", "medium", "heavy"],
      tracking: ["xs", "s", "m", "l", "xl"],
      shadow: ["s", "m", "l"],
      ease: ["motion", "motion-large"],
    },
    classGroups: {
      ...cornerGroups,
      ...edgeGroups,
      // Sondine's edges are box-shadow rings sized by the stroke widths.
      "ring-w": [{ ring: edgeKeys }],
      "inset-ring-w": [{ "inset-ring": edgeKeys }],
      duration: [{ duration: ["motion", "motion-large"] }],
    },
    conflictingClassGroups: { ...cornerConflicts, ...edgeConflicts },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
