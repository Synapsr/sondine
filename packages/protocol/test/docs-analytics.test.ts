import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION,
  COUNTED_EVENTS,
  USAGE_COUNTS,
  USAGE_ERRORS,
  USAGE_EXAMPLE,
  USAGE_RULES,
  USAGE_SURFACES,
  UsageReport,
  type UsageEvent,
} from "../src/index";

// docs/analytics.md and ADR 042 say what is counted: they and the code agree.

const docs = resolve(import.meta.dirname, "../../../docs");
const analytics = readFileSync(resolve(docs, "analytics.md"), "utf8");
const adr = readFileSync(resolve(docs, "decisions/042-usage-statistics.md"), "utf8");

describe("docs/analytics.md", () => {
  it("lists exactly the events counted, with their rule and surfaces", () => {
    const rows = [
      ...analytics.matchAll(/^\| `([a-z_]+)`\s+\| ([a-z]+)\s+\| ([a-z, ]+?)\s+\|$/gmu),
    ].map(([, event, rule, surfaces]) => ({ event, rule, surfaces }));
    const counted = [...new Set(USAGE_SURFACES.flatMap((surface) => COUNTED_EVENTS[surface]))];
    expect(rows).toEqual(
      counted.toSorted().map((event: UsageEvent) => ({
        event,
        rule: USAGE_RULES[event],
        surfaces: USAGE_SURFACES.filter((surface) => COUNTED_EVENTS[surface].includes(event)).join(
          ", ",
        ),
      })),
    );
  });

  it("lists exactly the error codes, the counts and the activation event", () => {
    const codes = [...analytics.matchAll(/^- `([a-z_]+)`$/gmu)].map(([, code]) => code);
    expect(codes).toEqual([...USAGE_ERRORS]);
    expect(analytics).toContain(USAGE_COUNTS.join(", "));
    expect(analytics).toContain(`\`${ACTIVATION.surface}.${ACTIVATION.event}\``);
  });
});

describe("ADR 042", () => {
  it("shows the example the app shows, and every field", () => {
    const [, json] = /```json\n([\s\S]*?)```/u.exec(adr) ?? [];
    expect(JSON.parse(json ?? "")).toEqual(USAGE_EXAMPLE);
    for (const field of Object.keys(UsageReport.shape)) expect(adr).toContain(`| \`${field}\``);
  });
});
