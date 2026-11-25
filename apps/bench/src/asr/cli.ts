import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultResultsDirectory, userPath } from "../paths.ts";
import { prepareCorpus } from "./corpus.ts";
import { CORPUS_IDS, ENGINE_IDS, type CorpusId, type EngineId } from "./ids.ts";
import { formatMeetingsTable, runMeetings, type MeetingsRunResult } from "./meetings.ts";
import { formatAsrTable, loadAsrResult } from "./report.ts";
import { runAsr } from "./run.ts";

const log = (line: string) => console.error(line);

function corpusIds(value: string | undefined, error: (message: string) => Error): CorpusId[] {
  const ids = (value ?? "").split(",").filter((id) => id !== "");
  if (ids.length === 0) throw error("--corpus is required");
  return ids.map((id) => {
    if (!(CORPUS_IDS as readonly string[]).includes(id)) throw error(`unknown corpus ${id}`);
    return id as CorpusId;
  });
}

export async function asrMain(
  command: string | undefined,
  args: readonly string[],
  error: (message: string) => Error,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      corpus: { type: "string" },
      engine: { type: "string" },
      size: { type: "string" },
      label: { type: "string" },
      "results-dir": { type: "string" },
    },
  });
  const size = Number(values.size ?? 100);
  if (!Number.isInteger(size) || size <= 0) throw error("--size must be a positive integer");
  switch (command) {
    case "fetch": {
      for (const id of corpusIds(values.corpus, error)) {
        const corpus = await prepareCorpus(id, size, log);
        console.log(`${corpus.id}: ${corpus.items.length} items in ${corpus.directory}`);
      }
      return 0;
    }
    case "run": {
      const engine = values.engine;
      if (engine === undefined || !(ENGINE_IDS as readonly string[]).includes(engine)) {
        throw error(`--engine must be one of ${ENGINE_IDS.join(", ")}`);
      }
      const [id] = corpusIds(values.corpus, error);
      if (id === undefined) throw error("--corpus is required");
      const corpus = await prepareCorpus(id, size, log);
      const { path, result } = await runAsr({
        engineId: engine as EngineId,
        corpus,
        label: values.label ?? "local",
        resultsDirectory:
          values["results-dir"] === undefined
            ? defaultResultsDirectory
            : userPath(values["results-dir"]),
        log,
      });
      console.log(formatAsrTable([result]));
      console.log(`\nwritten: ${path}`);
      return result.status === "complete" ? 0 : 3;
    }
    case "meetings": {
      const engine = values.engine;
      if (engine === undefined || !(ENGINE_IDS as readonly string[]).includes(engine)) {
        throw error(`--engine must be one of ${ENGINE_IDS.join(", ")}`);
      }
      const { path, result } = await runMeetings({
        engineId: engine as EngineId,
        resultsDirectory:
          values["results-dir"] === undefined
            ? defaultResultsDirectory
            : userPath(values["results-dir"]),
        log,
      });
      console.log(formatMeetingsTable([result]));
      console.log(`\nwritten: ${path}`);
      return 0;
    }
    case "meetings-report": {
      if (positionals.length === 0) throw error("asr meetings-report needs result files");
      const results = positionals.map(
        (path) => JSON.parse(readFileSync(userPath(path), "utf8")) as MeetingsRunResult,
      );
      console.log(formatMeetingsTable(results));
      return 0;
    }
    case "report": {
      if (positionals.length === 0) throw error("asr report needs result files");
      console.log(formatAsrTable(positionals.map((path) => loadAsrResult(userPath(path)))));
      return 0;
    }
    default:
      throw error(
        command === undefined ? "asr needs a command" : `unknown asr command "${command}"`,
      );
  }
}
