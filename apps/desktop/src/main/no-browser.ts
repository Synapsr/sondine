import { app } from "electron";

/**
 * `SONDINE_DEV_NO_BROWSER=1`, development only: nothing opens in the browser,
 * for the captures (`ux:cloud-shots`) and the flow lab (ADR 049), which must
 * reach no network. A packaged app ignores it.
 */
export const opensNoBrowser = (): boolean =>
  !app.isPackaged && process.env["SONDINE_DEV_NO_BROWSER"] === "1";
