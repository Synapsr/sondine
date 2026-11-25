import { parseArgs } from "node:util";
import { createSelfEchoDetector } from "@sondine/engines";
import { caseInput, SELF_ECHO_CASES } from "@sondine/engines/self-echo-synthetic";

/** A case passes the bench when this share of its seeds get the verdict it must. */
const MIN_RIGHT = 0.85;

interface CaseResult {
  readonly id: string;
  readonly want: string;
  readonly right: number;
  readonly seeds: number;
  /** Seeds that got another verdict, and which. */
  readonly wrong: readonly string[];
  readonly speechMinutes: number;
  readonly detectMs: number;
}

export function selfEchoMain(
  command: string | undefined,
  args: readonly string[],
  usageError: (message: string) => Error,
): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { seeds: { type: "string" } },
  });
  if (positionals.length > 0) throw usageError(`unexpected argument ${positionals[0] ?? ""}`);
  if (command !== "synthetic") throw usageError(`unknown self-echo command "${command ?? ""}"`);
  const seeds = Number(values.seeds ?? "40");
  if (!Number.isInteger(seeds) || seeds <= 0)
    throw usageError("--seeds must be a positive integer");
  const detector = createSelfEchoDetector();
  const results: CaseResult[] = SELF_ECHO_CASES.map((test) => {
    let right = 0;
    let judgedMs = 0;
    let detectMs = 0;
    const wrong: string[] = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const input = caseInput(test, seed);
      const started = performance.now();
      const verdict = detector.detect(input);
      detectMs += performance.now() - started;
      judgedMs += input.toMs - input.fromMs;
      if (verdict.kind === test.want) right += 1;
      else wrong.push(`${seed}:${verdict.kind}`);
    }
    return {
      id: test.id,
      want: test.want,
      right,
      seeds,
      wrong,
      speechMinutes: judgedMs / 60_000,
      detectMs,
    };
  });
  const total = results.reduce((sum, result) => sum + result.speechMinutes, 0);
  const cpu = results.reduce((sum, result) => sum + result.detectMs, 0);
  console.log(
    [
      `envelope-echo/1, ${seeds} seeds per case`,
      "",
      "| case | must be | right | wrong (seed:verdict) | |",
      "| --- | --- | --- | --- | --- |",
      ...results.map(
        (r) =>
          `| ${r.id} | ${r.want} | ${r.right}/${r.seeds} | ${r.wrong.slice(0, 6).join(" ") || "—"} | ${r.right >= MIN_RIGHT * r.seeds ? "pass" : "FAIL"} |`,
      ),
      "",
      `CPU: ${Math.round(cpu)} ms for ${total.toFixed(1)} min judged, ${((cpu / total) * 60).toFixed(0)} ms per hour of speech.`,
    ].join("\n"),
  );
  return results.every((result) => result.right >= MIN_RIGHT * result.seeds) ? 0 : 3;
}
