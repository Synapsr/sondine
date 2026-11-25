import { readFileSync } from "node:fs";
import type { AsrRunResult } from "./run.ts";
import { bootstrapRate } from "./score.ts";

// A markdown table of ASR runs, one row per engine and corpus. "WER without
// digits" scores only items whose reference has no digit: fr-norm spells
// French numbers out but keeps English digits, so an engine that writes
// "two thousand seven" for "2007" would lose words it heard right.

const percent = (rate: number | null) => (rate === null ? "–" : `${(rate * 100).toFixed(1)} %`);
const gb = (bytes: number | null) => (bytes === null ? "–" : `${(bytes / 1e9).toFixed(1)} GB`);

export function loadAsrResult(path: string): AsrRunResult {
  const value = JSON.parse(readFileSync(path, "utf8")) as AsrRunResult;
  if (value.schema !== "sondine-bench/asr/1") throw new Error(`${path} is not an ASR bench result`);
  return value;
}

export function formatAsrTable(results: readonly AsrRunResult[]): string {
  const rows = results
    .toSorted(
      (a, b) => a.corpus.id.localeCompare(b.corpus.id) || a.engine.id.localeCompare(b.engine.id),
    )
    .map((result) => {
      const ci = result.totals.werCi95;
      const noDigits = bootstrapRate(
        result.items.filter((item) => !/\d/.test(item.reference)).map((item) => item.words),
      );
      return [
        result.corpus.id,
        result.engine.id,
        String(result.corpus.items),
        percent(result.totals.wer),
        ci === null ? "–" : `${percent(ci[0])} – ${percent(ci[1])}`,
        percent(result.totals.cer),
        percent(noDigits.rate),
        `${result.cost.rtfx.toFixed(1)}×`,
        `${(result.cost.coldLoadMs / 1000).toFixed(1)} s`,
        gb(result.cost.peakFootprintBytes),
        result.status === "complete" ? "" : `stopped: ${result.stopReason ?? ""}`,
      ];
    });
  const header = [
    "Corpus",
    "Engine",
    "Items",
    "WER",
    "WER 95 %",
    "CER",
    "WER without digits",
    "RTFx",
    "Cold load",
    "Peak",
    "Note",
  ];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}
