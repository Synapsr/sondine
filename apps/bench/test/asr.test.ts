import { describe, expect, it } from "vitest";
import { selectFleurs } from "../src/asr/corpus.ts";
import { formatAsrTable } from "../src/asr/report.ts";
import type { AsrRunResult } from "../src/asr/run.ts";
import { bootstrapRate } from "../src/asr/score.ts";

const counts = (errors: number, refLength: number) => ({
  hits: refLength - errors,
  substitutions: errors,
  insertions: 0,
  deletions: 0,
  errors,
  refLength,
  hypLength: refLength,
});

describe("ASR bench", () => {
  it("keeps one recording per sentence, the first sentences in order", () => {
    const tsv = [
      "12\tb.wav\tDeux.\tdeux",
      "3\tz.wav\tUn.\tun",
      "12\ta.wav\tDeux.\tdeux",
      "7\tc.wav\tTrois.\ttrois",
      "",
    ].join("\n");
    expect(selectFleurs(tsv, 2)).toEqual([
      { sentence: 3, file: "z.wav", reference: "Un." },
      { sentence: 7, file: "c.wav", reference: "Trois." },
    ]);
    expect(selectFleurs(tsv, 10).map((item) => item.file)).toEqual(["z.wav", "c.wav", "a.wav"]);
  });

  it("pools counts for the rate and gives a reproducible interval around it", () => {
    const items = [counts(1, 10), counts(0, 10), counts(3, 10), counts(2, 20)];
    const result = bootstrapRate(items);
    expect(result.rate).toBeCloseTo(6 / 50);
    const [low, high] = result.ci95 ?? [Number.NaN, Number.NaN];
    expect(low).toBeLessThanOrEqual(result.rate ?? 0);
    expect(high).toBeGreaterThanOrEqual(result.rate ?? 0);
    expect(bootstrapRate(items)).toEqual(result);
    expect(bootstrapRate([counts(1, 10)]).ci95).toBeNull();
  });

  it("formats one row per engine and corpus", () => {
    const result = {
      engine: { id: "parakeet-tdt-0.6b-v3" },
      corpus: { id: "fleurs-fr", items: 100 },
      totals: { wer: 0.081, werCi95: [0.07, 0.093], cer: 0.03 },
      cost: { rtfx: 52.3, coldLoadMs: 1_400, peakFootprintBytes: 2_100_000_000 },
      status: "complete",
      stopReason: null,
      items: [
        { reference: "En 2007.", words: counts(1, 2) },
        { reference: "Bonjour à tous.", words: counts(0, 3) },
      ],
    } as unknown as AsrRunResult;
    expect(formatAsrTable([result]).split("\n")[2]).toBe(
      "| fleurs-fr | parakeet-tdt-0.6b-v3 | 100 | 8.1 % | 7.0 % – 9.3 % | 3.0 % | 0.0 % | 52.3× | 1.4 s | 2.1 GB |  |",
    );
  });
});
