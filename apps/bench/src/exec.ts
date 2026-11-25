import { execFile } from "node:child_process";

export interface ToolOutput {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a short command without a shell. Never rejects: failures come back as `ok: false`. */
export function runTool(
  command: string,
  args: readonly string[],
  timeoutMs = 15_000,
): Promise<ToolOutput> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout, stderr });
      },
    );
  });
}

/** stdout when the command succeeded, else null. */
export async function toolText(
  command: string,
  args: readonly string[],
  timeoutMs?: number,
): Promise<string | null> {
  const output = await runTool(command, args, timeoutMs);
  return output.ok ? output.stdout : null;
}
