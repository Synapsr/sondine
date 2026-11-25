import type { UsageReport } from "@sondine/protocol";

// One report leaves the Mac (ADR 042): one POST to the Worker, no redirect,
// a generic user agent, nothing about the user but the report itself. The
// answer's body is never read. Who may call it, and when, is usage.ts.

const TIMEOUT_MS = 15_000;

export async function sendReport(
  endpoint: string,
  report: UsageReport,
  options: {
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
    readonly signal: AbortSignal;
  },
): Promise<boolean> {
  try {
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Sondine" },
      body: JSON.stringify(report),
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.any([
        options.signal,
        AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      ]),
    });
    await response.body?.cancel();
    return response.status === 204;
  } catch {
    return false;
  }
}
