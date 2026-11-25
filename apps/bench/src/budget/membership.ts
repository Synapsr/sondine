import { CAP_GROUP_IDS } from "./caps.ts";
import {
  COREAUDIOD_PATH,
  roleFromExecutable,
  roleGroups,
  rolesOutsideTotal,
  type DiscoveredProcess,
  type Discovery,
  type ProcessRole,
} from "./discovery.ts";
import type { GroupId } from "./result-schema.ts";

// The meter rediscovers matching processes while it samples (--match, --rediscover-s), so a
// helper that restarts mid-run is measured from its next rescan on. After the run, each sampled
// incarnation gets the role a process listing gave it; one seen in no listing gets a role from
// its executable alone, which a plain Chromium helper (role set by its flags) cannot.

/** What the meter samples besides the pids listed at the start: every executable discovery
 * can recognize without its arguments, and coreaudiod. */
export function sondineMatchPattern(appName: string): string {
  const app = appName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const coreaudiod = COREAUDIOD_PATH.replaceAll(".", "\\.");
  return `^sondine-(audio|engines|mcp)$|/${app}\\.app/|^${coreaudiod}$`;
}

export interface SampledIncarnation {
  readonly pid: number;
  readonly startUs: number;
  readonly name: string;
  readonly path: string | null;
}

export interface Membership {
  /** Role per sampled incarnation, keyed by `incarnationKey`. */
  readonly roles: ReadonlyMap<string, ProcessRole>;
  /** Groups some of whose processes were not measured: their checks cannot be judged. */
  readonly incomplete: ReadonlySet<GroupId>;
  readonly warnings: readonly string[];
}

export function incarnationKey(process: { readonly pid: number; readonly startUs: number }) {
  return `${process.pid}:${process.startUs}`;
}

const sondineGroups: readonly GroupId[] = [
  ...CAP_GROUP_IDS.filter((id) => id !== "coreaudiod"),
  "sondine-total",
];

function groupsOf(role: ProcessRole): GroupId[] {
  const row = roleGroups[role];
  return [
    ...(row === null ? [] : [row]),
    ...(rolesOutsideTotal.has(role) ? [] : ["sondine-total" as const]),
  ];
}

/** @param listings process discoveries in time order; the last one is taken after the run. */
export function attributeIncarnations(
  sampled: readonly SampledIncarnation[],
  listings: readonly Discovery[],
  appName: string,
): Membership {
  const known = new Map<string, DiscoveredProcess>();
  for (const listing of listings) {
    for (const process of [
      ...listing.sondine,
      ...(listing.coreaudiod === null ? [] : [listing.coreaudiod]),
    ])
      known.set(incarnationKey(process), process);
  }
  const roles = new Map<string, ProcessRole>();
  const incomplete = new Set<GroupId>();
  const warnings: string[] = [];
  const first = new Set((listings[0]?.sondine ?? []).map((process) => incarnationKey(process)));
  if (listings[0]?.coreaudiod) first.add(incarnationKey(listings[0].coreaudiod));

  for (const process of sampled) {
    const key = incarnationKey(process);
    const role = known.get(key)?.role ?? roleFromExecutable(process, appName);
    if (role === null) {
      warnings.push(
        `pid ${process.pid} (${process.name}) started during the run and its role is unknown: Sondine rows are not evaluated`,
      );
      for (const id of sondineGroups) incomplete.add(id);
      continue;
    }
    roles.set(key, role);
    if (!first.has(key))
      warnings.push(
        `${role} pid ${process.pid} started during the run and was measured from then on`,
      );
  }

  const sampledKeys = new Set(sampled.map((process) => incarnationKey(process)));
  const last = listings.at(-1);
  for (const process of [
    ...(last?.sondine ?? []),
    ...(last?.coreaudiod ? [last.coreaudiod] : []),
  ]) {
    if (sampledKeys.has(incarnationKey(process))) continue;
    warnings.push(
      `${process.role} pid ${process.pid} appeared during the run and was not measured`,
    );
    for (const id of groupsOf(process.role)) incomplete.add(id);
  }
  return { roles, incomplete, warnings };
}
