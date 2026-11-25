import type { EpisodeApp, EpisodeSummary } from "@sondine/api";
import { cn } from "@sondine/ui";
import { useQuery } from "@tanstack/react-query";
import type { AppIconRef } from "../../../shared/bridge";

// An app's icon, wherever the window names an app (calls, media, the
// memory bar), so it is recognized at a glance. Main finds it on this Mac;
// an app it cannot find shows its initial instead.

export function AppIcon({
  app,
  name,
  className,
}: {
  app: AppIconRef;
  /** The app's name, for the initial when there is no icon; the text next to it names the app. */
  name: string;
  className?: string;
}) {
  const key = "bundleId" in app ? `id:${app.bundleId}` : `path:${app.appPath}`;
  const icon = useQuery({
    queryKey: ["app-icon", key],
    queryFn: () => window.sondine?.appIcon(app) ?? Promise.resolve(null),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  const size = cn("size-s shrink-0", className);
  if (typeof icon.data === "string") {
    return <img src={icon.data} alt="" aria-hidden className={cn(size, "object-contain")} />;
  }
  return (
    <span
      aria-hidden
      className={cn(
        size,
        "inline-flex items-center justify-center corner-xs bg-neutral-3 text-[0.6rem] font-body font-medium text-cte-text-muted",
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * The icons of a few apps side by side, their names for a pointer and a
 * screen reader; nothing when there are none (in person).
 */
export function AppIcons({
  apps,
  max = 3,
  className,
}: {
  apps: readonly EpisodeApp[];
  max?: number;
  className?: string;
}) {
  if (apps.length === 0) return null;
  const names = apps.map((app) => app.name).join(", ");
  return (
    <span title={names} className={cn("inline-flex shrink-0 items-center gap-xxs", className)}>
      {apps.slice(0, max).map((app) => (
        <AppIcon key={app.bundleId} app={{ bundleId: app.bundleId }} name={app.name} />
      ))}
      <span className="sr-only">{names}</span>
    </span>
  );
}

/** The icon of the app an episode heard most (its call app, what played it); none in person. */
export function EpisodeAppIcon({
  episode,
  className,
}: {
  episode: EpisodeSummary;
  className?: string;
}) {
  const [app] = episode.apps;
  if (app === undefined) return null;
  return (
    <AppIcon
      app={{ bundleId: app.bundleId }}
      name={app.name}
      {...(className === undefined ? {} : { className })}
    />
  );
}
