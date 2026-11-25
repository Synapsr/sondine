// Sizes as the Mac shows them: disk space in decimal units like the Finder
// (19 Go), memory in binary units like « À propos de ce Mac » (32 Go).

export function formatBytes(
  bytes: number,
  locale: string,
  { binary = false }: { binary?: boolean } = {},
): string {
  const base = binary ? 1024 : 1000;
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unit],
    unitDisplay: "short",
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value);
}
