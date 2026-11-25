// What the global setup built (test/global-setup.ts), read from its folders,
// and fakes to run the scripts against.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inject } from "vitest";
import type { BuildName } from "./global-setup.ts";

/** Each entry's script, where WXT writes it. */
export const SCRIPTS = {
  background: "background.js",
  youtube: "content-scripts/youtube.js",
  pages: "content-scripts/pages.js",
} as const;

/** The folder of one build: the extension as a browser loads it. */
export function builtFolder(build: BuildName): string {
  return join(inject("extensionBuilds"), build);
}

/** Every file of a build, by path inside it. */
export function builtFiles(build: BuildName): string[] {
  const folder = builtFolder(build);
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .toSorted();
}

export function readBuilt(build: BuildName, path: string): string {
  return readFileSync(join(builtFolder(build), path), "utf8");
}

/** An entry's script in the unpacked build. */
export function script(entry: keyof typeof SCRIPTS): string {
  return readBuilt("unpacked", SCRIPTS[entry]);
}

/** A JSON file of a build, as an object. */
export function readBuiltJson(build: BuildName, path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readBuilt(build, path));
  if (!isRecord(value)) throw new Error(`${path} is not a JSON object`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lets pending promises and their callbacks run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** An extension event: listeners added and removed, fired by the test. */
export class FakeEvent<Args extends unknown[]> {
  readonly listeners = new Set<(...args: Args) => unknown>();

  addListener(listener: (...args: Args) => unknown): void {
    this.listeners.add(listener);
  }

  removeListener(listener: (...args: Args) => unknown): void {
    this.listeners.delete(listener);
  }

  fire(...args: Args): void {
    for (const listener of this.listeners) listener(...args);
  }
}

/** What crossed the browser's messaging, as JSON (and out of the script's realm). */
export function asJson(values: readonly unknown[]): unknown[] {
  return values.map((value): unknown => JSON.parse(JSON.stringify(value)));
}
