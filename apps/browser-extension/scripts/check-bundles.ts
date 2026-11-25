// The check every build runs when done (WXT's `build:done` hook): each script
// of the built extension must parse as a classic script (content scripts
// cannot be modules) and must not reach the network or load code (ADR 002).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";

/** Calls that reach the network or load code; none may appear in a bundle. */
const FORBIDDEN =
  /\b(?:fetch|importScripts|sendBeacon)\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource|WebTransport|RTCPeerConnection)\b|\bimport\s*\(/;

/** Throws unless `code` parses as a classic script that reaches no network. */
export function checkScript(name: string, code: string): void {
  void new Script(code, { filename: name });
  const forbidden = FORBIDDEN.exec(code);
  if (forbidden !== null) throw new Error(`${name} calls ${forbidden[0]}`);
}

/** Checks every script in a built extension's folder. */
export function checkBundles(outDir: string): void {
  for (const file of readdirSync(outDir, { recursive: true, encoding: "utf8" })) {
    if (file.endsWith(".js")) checkScript(file, readFileSync(join(outDir, file), "utf8"));
  }
}
