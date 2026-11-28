import { type ComponentType, useEffect, useState } from "react";

// The flow lab's HUD (ADR 049), beside the app in the lab only
// (`pnpm dev:lab`). Its code is reached only through the import below, which
// Vite drops from production builds; in `pnpm dev`, main answers null and
// nothing loads.

const loadHud = import.meta.env.DEV ? () => import("./flow-lab-hud") : null;

function DevelopmentFlowLab() {
  const [Hud, setHud] = useState<ComponentType | null>(null);
  useEffect(() => {
    const bridge = window.sondine.flowLab;
    if (loadHud === null || bridge === undefined) return;
    let active = true;
    void bridge
      .run(null)
      .then(async (view) => {
        if (view === null || !active) return;
        const { FlowLabHud } = await loadHud();
        if (active) setHud(() => FlowLabHud);
      })
      // Not the lab: main has no handler.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return Hud === null ? null : <Hud />;
}

export const FlowLabRoot = loadHud === null ? () => null : DevelopmentFlowLab;
