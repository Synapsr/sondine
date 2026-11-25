import type { SondineBridge } from "../shared/bridge";

declare global {
  interface Window {
    /** Exposed by the preload script; the renderer's only door to the app. */
    readonly sondine: SondineBridge;
  }
}
