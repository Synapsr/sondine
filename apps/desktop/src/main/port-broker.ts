import { MessageChannelMain, type BrowserWindow, type MessagePortMain } from "electron";
import { PORT_REPLY_CHANNEL } from "../shared/bridge";

// Main brokers exactly one MessagePort between a window's renderer and core
// (architecture §11) and is not on the path afterwards: both ends talk oRPC
// directly. A reload or a core restart brokers a fresh pair.

/**
 * Creates a channel, hands one end to core (through `toCore`) and posts the
 * other to the window's main frame, which the preload forwards to the page.
 */
export function brokerPort(window: BrowserWindow, toCore: (port: MessagePortMain) => void): void {
  const { port1, port2 } = new MessageChannelMain();
  toCore(port1);
  window.webContents.mainFrame.postMessage(PORT_REPLY_CHANNEL, null, [port2]);
}
