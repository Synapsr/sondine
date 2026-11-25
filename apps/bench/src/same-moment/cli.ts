import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseDuration } from "../duration.ts";
import { defaultResultsDirectory, userPath } from "../paths.ts";
import { pairsSchema, resultTable, runPair, type PairResult } from "./run.ts";
import { LONG_CASE, runSynthetic, SYNTHETIC_CASES, type SyntheticResult } from "./synthetic.ts";

export async function sameMomentMain(
  command: string | undefined,
  args: readonly string[],
  usageError: (message: string) => Error,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      pairs: { type: "string" },
      label: { type: "string" },
      search: { type: "string" },
      shift: { type: "string" },
      out: { type: "string" },
      long: { type: "boolean" },
      seed: { type: "string" },
    },
  });
  if (positionals.length > 0) throw usageError(`unexpected argument ${positionals[0] ?? ""}`);
  switch (command) {
    case "run": {
      if (values.pairs === undefined) throw usageError("same-moment run needs --pairs");
      const parsed = pairsSchema.safeParse(
        JSON.parse(readFileSync(userPath(values.pairs), "utf8")),
      );
      if (!parsed.success) throw usageError(`--pairs: ${parsed.error.message}`);
      const label = values.label ?? "local";
      if (!/^[\w.-]{1,40}$/.test(label)) throw usageError("--label: letters, digits, . _ - only");
      const options = {
        searchMs: parseDuration(values.search ?? "2m") * 1000,
        shiftMs: parseDuration(values.shift ?? "37s") * 1000,
      };
      const results: PairResult[] = [];
      for (const pair of parsed.data.pairs) {
        if (pair.mac.startsWith("~") || pair.phone.startsWith("~"))
          throw usageError(`${pair.id}: write paths in full, not with ~`);
        results.push(
          runPair({ ...pair, mac: userPath(pair.mac), phone: userPath(pair.phone) }, options),
        );
        console.error(`${pair.id}: ${results.at(-1)?.pass === true ? "pass" : "FAIL"}`);
      }
      console.log(resultTable(results));
      const directory = values.out === undefined ? defaultResultsDirectory : userPath(values.out);
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `same-moment-${label}.json`);
      writeFileSync(
        path,
        `${JSON.stringify({ label, ...options, method: "envelope-xcorr/1", results }, null, 2)}\n`,
      );
      console.log(`\nwritten: ${path}`);
      return results.every((result) => result.pass) ? 0 : 3;
    }
    case "synthetic": {
      const seed = Number(values.seed ?? "1");
      if (!Number.isInteger(seed)) throw usageError("--seed must be an integer");
      const cases = values.long === true ? [...SYNTHETIC_CASES, LONG_CASE] : SYNTHETIC_CASES;
      const results: SyntheticResult[] = cases.map((test, index) =>
        runSynthetic(test, seed * 100 + index * 10),
      );
      console.log(
        [
          "| pair | same room | found | worst error (ms) | peak | score | audio (min) | envelope (ms) | detect (ms) | CPU per hour of audio (ms) | |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          ...results.map(
            (r) =>
              `| ${r.id} | ${r.same ? "yes" : "no"} | ${r.linked ? "linked" : "no"} | ${r.errorMs ?? "—"} | ${r.peak} | ${r.score} | ${r.audioMinutes} | ${r.envelopeMs} | ${r.detectMs} | ${r.cpuMsPerHour} | ${r.pass ? "pass" : "FAIL"} |`,
          ),
        ].join("\n"),
      );
      return results.every((result) => result.pass) ? 0 : 3;
    }
    default:
      throw usageError(
        command === undefined
          ? "same-moment needs a command"
          : `unknown same-moment command "${command}"`,
      );
  }
}
