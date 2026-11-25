// Development only (SONDINE_SMOKE=1): opens and closes the window on a timer
// so a scripted run can check that the renderer comes and goes, and that it
// gets status from core each time. The app keeps running with the window
// closed afterwards, which is the state the always-on budget measures.

export interface WindowSmokeActions {
  open(): void;
  close(): void;
  log(event: string): void;
}

export const SMOKE_STEPS: readonly { readonly atMs: number; readonly step: "open" | "close" }[] = [
  { atMs: 0, step: "open" },
  { atMs: 6_000, step: "close" },
  { atMs: 9_000, step: "open" },
  { atMs: 14_000, step: "close" },
];

export function runWindowSmoke(actions: WindowSmokeActions): void {
  for (const { atMs, step } of SMOKE_STEPS) {
    setTimeout(() => {
      actions.log(`smoke.${step}`);
      if (step === "open") actions.open();
      else actions.close();
    }, atMs).unref();
  }
}
