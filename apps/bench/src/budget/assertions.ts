import * as z from "zod";

// Power assertions from `pmset -g assertions` (no root needed). The budget forbids Sondine sleep
// assertions in S0 (architecture §5), including those coreaudiod creates on behalf of a
// Sondine pid ("Created for PID").

export interface PowerAssertion {
  readonly ownerPid: number;
  readonly ownerName: string;
  readonly type: string;
  readonly name: string;
  readonly createdForPid: number | null;
}

/** Assertion types that keep the system or the display awake. */
export const SLEEP_ASSERTION_TYPES: ReadonlySet<string> = new Set([
  "PreventUserIdleSystemSleep",
  "PreventSystemSleep",
  "NoIdleSleepAssertion",
  "PreventUserIdleDisplaySleep",
  "NoDisplaySleepAssertion",
  "InternalPreventSleep",
  "InternalPreventDisplaySleep",
]);

const ownerLine = /^\s*pid (\d+)\((.*?)\): \[0x[0-9a-fA-F]+\] \S+ (\S+) named: "(.*)"\s*$/;
const createdFor = /Created for PID:\s*(\d+)/;

/** The "Listed by owning process" section; detail lines attach to the assertion above them. */
export function parseAssertions(text: string): PowerAssertion[] {
  const assertions: PowerAssertion[] = [];
  for (const line of text.split("\n")) {
    const owner = ownerLine.exec(line);
    if (owner !== null) {
      assertions.push({
        ownerPid: Number(owner[1]),
        ownerName: owner[2] ?? "",
        type: owner[3] ?? "",
        name: owner[4] ?? "",
        createdForPid: null,
      });
      continue;
    }
    const detail = createdFor.exec(line);
    const last = assertions.at(-1);
    if (detail !== null && last !== undefined && /^\s/.test(line)) {
      assertions[assertions.length - 1] = { ...last, createdForPid: Number(detail[1]) };
    }
  }
  return assertions;
}

export const sondineAssertionSchema = z.object({
  type: z.string(),
  ownerPid: z.int(),
  ownerName: z.string(),
  createdForPid: z.int().nullable(),
  name: z.string(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  polls: z.int().positive(),
});
export type SondineAssertion = z.infer<typeof sondineAssertionSchema>;

/** Accumulates the sleep assertions attributable to Sondine pids across polls. */
export class AssertionTracker {
  readonly #pids: ReadonlySet<number>;
  readonly #seen = new Map<string, SondineAssertion>();
  #polls = 0;

  constructor(sondinePids: Iterable<number>) {
    this.#pids = new Set(sondinePids);
  }

  get polls(): number {
    return this.#polls;
  }

  record(text: string, at: Date): void {
    this.#polls += 1;
    const iso = at.toISOString();
    for (const assertion of parseAssertions(text)) {
      if (!SLEEP_ASSERTION_TYPES.has(assertion.type)) continue;
      const attributable =
        this.#pids.has(assertion.ownerPid) ||
        (assertion.createdForPid !== null && this.#pids.has(assertion.createdForPid));
      if (!attributable) continue;
      const key = `${assertion.ownerPid}|${assertion.type}|${assertion.name}|${assertion.createdForPid ?? ""}`;
      const previous = this.#seen.get(key);
      this.#seen.set(key, {
        type: assertion.type,
        ownerPid: assertion.ownerPid,
        ownerName: assertion.ownerName,
        createdForPid: assertion.createdForPid,
        name: assertion.name,
        firstSeenAt: previous?.firstSeenAt ?? iso,
        lastSeenAt: iso,
        polls: (previous?.polls ?? 0) + 1,
      });
    }
  }

  get assertions(): SondineAssertion[] {
    return [...this.#seen.values()];
  }
}
