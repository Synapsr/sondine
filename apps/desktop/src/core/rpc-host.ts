import { onMessagePortClose, type SupportedMessagePort } from "@orpc/client/message-port";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { router } from "@sondine/api";
import { Context, Effect, Layer } from "effect";
import { Api } from "./api-services";
import { log } from "./log";
import { UsageStatistics } from "./usage/usage-layer";

/** Electron's MessagePortMain and Node's worker MessagePort both fit. */
export type CorePort = SupportedMessagePort & { start(): void };

export interface RpcHostService {
  /** Serves the router on `port` until it closes. */
  attach(port: CorePort, label: string): void;
  readonly openPorts: () => number;
}

export class RpcHost extends Context.Service<RpcHost, RpcHostService>()("sondine/core/RpcHost") {}

export const rpcHostLayer = Layer.effect(
  RpcHost,
  Effect.gen(function* () {
    const services = yield* Api;
    const usage = { counter: yield* UsageStatistics, surface: "desktop" } as const;
    const handler = new RPCHandler(router, {
      interceptors: [
        onError((error) => {
          log.error("rpc.error", {
            message: error instanceof Error ? error.message : String(error),
          });
        }),
      ],
    });
    let open = 0;
    return RpcHost.of({
      attach(port, label) {
        handler.upgrade(port, { context: { services, usage } });
        open += 1;
        onMessagePortClose(port, () => {
          open -= 1;
          log.info("rpc.port-closed", { label, open });
        });
        port.start();
        log.info("rpc.port-attached", { label, open });
      },
      openPorts: () => open,
    });
  }),
);
