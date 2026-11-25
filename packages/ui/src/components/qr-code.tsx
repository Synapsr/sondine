import { useMemo, type ComponentProps } from "react";
import { cn } from "../lib/cn";
import { encodeQr } from "../lib/qr";

// A QR code drawn as one SVG path (no spec in gui/: a custom component).
// Dark modules on a light square in both modes, with the standard's quiet
// zone of four modules, because a camera reads light on dark poorly:
// neutral-10 and neutral-1 swap with the mode, so each mode names the one
// that stays black or white.

/** The light margin the standard asks for around the modules. */
const QUIET_ZONE = 4;

export interface QrCodeProps extends Omit<ComponentProps<"svg">, "children" | "viewBox"> {
  /** The text to encode (UTF-8, byte mode, error correction M). */
  value: string;
  /** What the code is, for assistive technology. */
  label: string;
}

/** Draws `value` as a QR code; size it with `className` (it is square). */
export function QrCode({ value, label, className, ...props }: QrCodeProps) {
  const { size, path } = useMemo(() => {
    const matrix = encodeQr(value);
    let d = "";
    matrix.modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
      });
    });
    return { size: matrix.size + QUIET_ZONE * 2, path: d };
  }, [value]);
  return (
    <svg
      data-slot="qr-code"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn(
        "aspect-square shrink-0 corner-s",
        "bg-[color:light-dark(var(--neutral-1),var(--neutral-10))]",
        "fill-[color:light-dark(var(--neutral-10),var(--neutral-1))]",
        className,
      )}
      {...props}
    >
      <path d={path} />
    </svg>
  );
}
