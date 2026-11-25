import type { JournalBenchResult } from "./run.ts";

// Numbers only: the committed report never quotes what was said. The review
// file (`reviewMarkdown`) holds items and their cited lines, for a person to
// judge; it stays in the private results folder.

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const gib = (bytes: number | null) => (bytes === null ? "—" : (bytes / 1024 ** 3).toFixed(1));
const watts = (mw: number | null) => (mw === null ? "—" : (mw / 1000).toFixed(1));
const rate = (tokens: number, ms: number) => (ms <= 0 ? "—" : ((tokens * 1000) / ms).toFixed(0));

export function summaryRows(results: readonly JournalBenchResult[]): string {
  const lines = [
    "| Model | Fixtures | Episodes | Windows (failed) | Lines | Commitments | Prompt tok/s | Output tok/s | Compute | Load | Resident GiB | Footprint GiB | CPU J | Mac W idle → run |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const windows = result.days.flatMap((day) => day.windows);
    const items = result.days.flatMap((day) => day.items);
    const sum = (pick: (w: (typeof windows)[number]) => number) =>
      windows.reduce((total, window) => total + pick(window), 0);
    const failed = windows.filter((window) => window.error !== null).length;
    const passed = result.fixtures.filter((fixture) => fixture.pass).length;
    lines.push(
      `| ${result.label} | ${passed}/${result.fixtures.length} | ${result.days.reduce((n, day) => n + day.episodes, 0)} | ${windows.length} (${failed}) | ${items.filter((i) => i.item.kind === "event").length} | ${items.filter((i) => i.item.kind === "commitment").length} | ${rate(
        sum((w) => w.promptTokens),
        sum((w) => w.promptMs),
      )} | ${rate(
        sum((w) => w.outputTokens),
        sum((w) => w.generateMs),
      )} | ${seconds(sum((w) => w.computeMs))} s | ${seconds(result.loadMs)} s | ${gib(result.cost.residentMaxBytes)} | ${gib(result.cost.footprintMaxBytes)} | ${result.cost.cpuJoules?.toFixed(0) ?? "—"} | ${watts(result.cost.baselineMilliwatts)} → ${watts(result.cost.runMilliwatts)} |`,
    );
  }
  return lines.join("\n");
}

export function fixtureRows(results: readonly JournalBenchResult[]): string {
  const ids = results[0]?.fixtures.map((fixture) => fixture.id) ?? [];
  const lines = [
    `| Fixture | ${results.map((result) => result.label).join(" | ")} |`,
    `| --- | ${results.map(() => "---").join(" | ")} |`,
  ];
  for (const id of ids) {
    const cells = results.map((result) => {
      const fixture = result.fixtures.find((candidate) => candidate.id === id);
      return fixture === undefined ? "—" : fixture.pass ? "pass" : fixture.problems.join("; ");
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/** Every item with the lines it cites, per day and conversation: private. */
export function reviewMarkdown(result: JournalBenchResult): string {
  const out = [`# ${result.label}`, ""];
  for (const day of result.days) {
    out.push(`## ${day.day}`, "");
    let episode = -1;
    for (const item of day.items) {
      if (item.episodeId !== episode) {
        episode = item.episodeId;
        out.push(`### episode ${episode}`, "");
      }
      const draft = item.item;
      const head =
        draft.kind === "event"
          ? `- E: ${item.text}`
          : `- C: [${draft.who ?? "?"}→${draft.to ?? "?"}] ${item.text}${draft.due === null ? "" : ` (due ${draft.due}${draft.dueText === null ? "" : `, "${draft.dueText}"`})`}`;
      out.push(head);
      for (const cited of item.cited) out.push(`    > ${cited.line}`);
    }
    out.push("");
  }
  return out.join("\n");
}
