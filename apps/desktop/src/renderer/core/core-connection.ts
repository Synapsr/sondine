import { createORPCClient, DynamicLink } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { AppClient } from "@sondine/api";
import { PORT_WINDOW_MESSAGE, type SondineBridge } from "../../shared/bridge";

// The renderer's side of the brokered MessagePort. The preload hands each new
// port over with window.postMessage; a reload or a core restart brings a new
// one, and calls made meanwhile wait for it. The oRPC client stays the same
// object, so TanStack Query utilities built on it never change.

export interface CoreConnection {
  readonly client: AppClient;
  /** Called after a replacement port arrives (core restarted). */
  onReconnect(listener: () => void): () => void;
}

export function createCoreConnection(
  bridge: SondineBridge,
  target: Window = window,
): CoreConnection {
  let port: MessagePort | null = null;
  let link: RPCLink<object> | null = null;
  let waiting: ((link: RPCLink<object>) => void)[] = [];
  const listeners = new Set<() => void>();

  target.addEventListener("message", (event) => {
    if (event.source !== target || event.origin !== target.location.origin) return;
    if (event.data !== PORT_WINDOW_MESSAGE) return;
    const [next] = event.ports;
    if (next === undefined) return;
    const replacing = port !== null;
    port?.close();
    port = next;
    next.start();
    link = new RPCLink({ port: next });
    for (const resolve of waiting) resolve(link);
    waiting = [];
    if (replacing) for (const listener of listeners) listener();
  });

  const current = (): RPCLink<object> | Promise<RPCLink<object>> =>
    link ?? new Promise((resolve) => waiting.push(resolve));

  const client: AppClient = createORPCClient(new DynamicLink(() => current()));
  bridge.requestCorePort();

  return {
    client,
    onReconnect(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
