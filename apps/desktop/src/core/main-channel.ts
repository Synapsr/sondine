import { Context, Layer } from "effect";
import type { CoreToMain } from "../shared/core-messages";

/** Core's side of `process.parentPort`; tests use a recording fake. */
export interface MainChannelService {
  post(message: CoreToMain): void;
}

export class MainChannel extends Context.Service<MainChannel, MainChannelService>()(
  "sondine/core/MainChannel",
) {}

export const mainChannelLayer = (channel: MainChannelService) =>
  Layer.succeed(MainChannel, channel);
