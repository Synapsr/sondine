import { parseArgs } from "node:util";
import { userPath } from "../paths.ts";
import { addGolden, goldenRoot, goldenStatus, SCENARIOS, type ScenarioId } from "./golden.ts";

const log = (line: string) => console.error(line);

export async function goldenMain(
  command: string | undefined,
  args: readonly string[],
  error: (message: string) => Error,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { scenario: { type: "string" } },
  });
  switch (command) {
    case "add": {
      const [file] = positionals;
      if (file === undefined || positionals.length !== 1)
        throw error("golden add needs one audio file");
      const scenario = values.scenario;
      if (scenario === undefined || !(scenario in SCENARIOS)) {
        throw error(`--scenario must be one of ${Object.keys(SCENARIOS).join(", ")}`);
      }
      const directory = await addGolden(userPath(file), scenario as ScenarioId, log);
      console.log(`seeded: ${directory}/reference.txt`);
      return 0;
    }
    case "status": {
      const items = goldenStatus();
      if (items.length === 0) console.log(`nothing yet in ${goldenRoot}`);
      for (const item of items) {
        const minutes = (item.durationMs / 60_000).toFixed(1);
        console.log(
          `${item.scenario.padEnd(12)} ${minutes} min  ${item.status}  ${item.turns} tours${item.problem === null ? "" : `  (${item.problem})`}`,
        );
      }
      return 0;
    }
    default:
      throw error(
        command === undefined ? "golden needs a command" : `unknown golden command "${command}"`,
      );
  }
}
