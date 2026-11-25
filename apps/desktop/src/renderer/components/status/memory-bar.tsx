import type { AnalysisCheck } from "@sondine/api";
import { cn } from "@sondine/ui";
import { formatBytes } from "../../lib/bytes";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { AppIcon } from "../shell/app-icon";
import { memoryBar } from "./analysis-check-view";

// The compressed memory as one bar, app by app (estimated), over everything
// macOS counts for its pressure level, with the line under which the level
// should fall back: the apps worth quitting, and about how much to free.
// macOS's level stays the authority.

const segmentColor = ["bg-color-1", "bg-color-2", "bg-color-3", "bg-color-4"];
const OTHER_COLOR = "bg-neutral-6";

const size = (bytes: number) => formatBytes(bytes, getLocale(), { binary: true });

export function MemoryBar({ use }: { use: NonNullable<AnalysisCheck["memoryUse"]> }) {
  const bar = memoryBar(use);
  const color = (index: number, name: string | null) =>
    name === null ? OTHER_COLOR : (segmentColor[index] ?? OTHER_COLOR);
  return (
    <div className="flex flex-col gap-xs pt-xxs">
      <p className="text-body-xs text-cte-text-muted">
        {bar.toFreeBytes === 0
          ? m.analysis_check_compressed_under({ limit: size(use.limitBytes) })
          : m.analysis_check_compressed({
              compressed: size(use.compressedBytes),
              limit: size(use.limitBytes),
              free: size(bar.toFreeBytes),
            })}
      </p>
      <div
        role="img"
        aria-label={m.analysis_check_compressed_bar({
          compressed: size(use.compressedBytes),
          limit: size(use.limitBytes),
        })}
        className="relative h-xs w-full corner-full bg-neutral-3"
      >
        <div className="flex h-full w-full overflow-hidden corner-full">
          {bar.segments.map((segment, index) => (
            <div
              key={segment.name ?? "other"}
              className={cn(
                "h-full shrink-0 border-r border-neutral-1 last:border-r-0",
                color(index, segment.name),
              )}
              style={{ width: `${segment.share * 100}%` }}
            />
          ))}
        </div>
        <div
          aria-hidden
          className="absolute -top-xxs -bottom-xxs w-[2px] -translate-x-1/2 corner-full bg-neutral-10"
          style={{ left: `${bar.limitShare * 100}%` }}
        />
      </div>
      <ul className="flex flex-wrap gap-x-s gap-y-xxs text-body-xs">
        {bar.segments.map((segment, index) => (
          <li key={segment.name ?? "other"} className="flex items-center gap-xxs">
            <span
              aria-hidden
              className={cn("size-xs shrink-0 corner-full", color(index, segment.name))}
            />
            {segment.appPath === null || segment.name === null ? null : (
              <AppIcon app={{ appPath: segment.appPath }} name={segment.name} />
            )}
            <span>{segment.name ?? m.analysis_check_other_apps()}</span>
            <span className="text-cte-text-muted">
              {m.analysis_check_app_size({ size: size(segment.bytes) })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
