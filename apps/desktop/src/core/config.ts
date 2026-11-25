import { join } from "node:path";
import { parseArgs } from "node:util";
import type { UpdateBlock } from "@sondine/api";
import { Context, Layer } from "effect";
import { CoreArguments } from "../shared/core-messages";
import { DATA_LAYOUT } from "../shared/data-layout";

export interface CoreConfigShape {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly migrationsDir: string;
  readonly helperSocket: string;
  readonly spoolDir: string;
  readonly spansPath: string;
  /** The browser link's trace (ADR 023). */
  readonly browserTracePath: string;
  readonly appVersion: string;
  /** macOS's, as main reads it: `27.0.1`. */
  readonly macosVersion: string;
  /** Where the anonymous statistics go (ADR 042); null but in a packaged release. */
  readonly statsEndpoint: string | null;
  /** Why this app cannot replace itself, and a test build's own feed (ADR 045). */
  readonly updates: { readonly blocked: UpdateBlock | null; readonly testFeed: string | null };
  /** `~/Library/Application Support/Sondine/models` (packages/engines model store). */
  readonly modelsDir: string;
  /** The speech.cpp worker executable, or null: analysis then waits for one. */
  readonly speechBinary: string | null;
  /** llama-server and its socket, or null: the journal then waits for one (ADR 028). */
  readonly textServer: { readonly binary: string; readonly socket: string } | null;
  /** sondine-voice and its model, or null: voices are named but never suggested. */
  readonly voiceTool: { readonly binary: string; readonly model: string } | null;
  /** Where agents' MCP sessions arrive (ADR 011). */
  readonly agentSocket: string;
  /** The relay agents start, and whether they must pass it `--socket`; null when none reaches the data. */
  readonly agentRelay: { readonly path: string; readonly socketArgument: boolean } | null;
  /** Where the browser extension's link arrives (ADR 023). */
  readonly browserSocket: string;
  /** The relay browsers start, and whether it needs `--socket`; null when none reaches the data. */
  readonly browserRelay: { readonly path: string; readonly socketArgument: boolean } | null;
  /** The unpacked extension this build carries, and where the user loads it from. */
  readonly browserExtension: { readonly source: string; readonly target: string } | null;
  /**
   * Development only (`SONDINE_NATIVE_HOSTS_DIR`): the one folder the native
   * host manifest goes to, so a development build never replaces the
   * installed app's in the user's browsers.
   */
  readonly nativeHostsDir: string | null;
  /** Where paired phones' connections arrive, through the relay (ADR 008). */
  readonly phoneSocket: string;
  /** The relay core starts for phones, and whether it accepts loopback peers; null when none reaches the data. */
  readonly phoneRelay: { readonly path: string; readonly allowLoopback: boolean } | null;
  /** Where a voice read is recorded, then deleted once embedded (ADR 034); null when main cannot record one. */
  readonly voiceReadDir: string | null;
}

export class CoreConfig extends Context.Service<CoreConfig, CoreConfigShape>()(
  "sondine/core/CoreConfig",
) {}

export function coreConfigFrom(args: CoreArguments): CoreConfigShape {
  return {
    dataDir: args.dataDir,
    databasePath: join(args.dataDir, DATA_LAYOUT.database),
    migrationsDir: args.migrationsDir,
    helperSocket: args.helperSocket,
    spoolDir: DATA_LAYOUT.spoolDir,
    spansPath: join(args.dataDir, DATA_LAYOUT.spansFile),
    browserTracePath: join(args.dataDir, DATA_LAYOUT.browserTraceFile),
    appVersion: args.appVersion,
    macosVersion: args.macosVersion,
    statsEndpoint: args.statsEndpoint,
    updates: { blocked: args.updateBlock, testFeed: args.updateTestFeed },
    modelsDir: args.modelsDir,
    speechBinary: args.speechBinary,
    textServer:
      args.textServer === null || args.textSocket === null
        ? null
        : { binary: args.textServer, socket: args.textSocket },
    voiceTool:
      args.voiceBinary === null || args.voiceModel === null
        ? null
        : { binary: args.voiceBinary, model: args.voiceModel },
    agentSocket: join(args.dataDir, DATA_LAYOUT.agentSocket),
    agentRelay:
      args.agentRelay === null
        ? null
        : { path: args.agentRelay, socketArgument: args.agentRelaySocketArgument },
    browserSocket: join(args.dataDir, DATA_LAYOUT.browserSocket),
    browserRelay:
      args.browserRelay === null
        ? null
        : { path: args.browserRelay, socketArgument: args.browserRelaySocketArgument },
    browserExtension:
      args.browserExtension === null
        ? null
        : {
            source: args.browserExtension,
            target: join(args.dataDir, DATA_LAYOUT.browserExtensionDir),
          },
    nativeHostsDir:
      args.browserRelaySocketArgument && process.env["SONDINE_NATIVE_HOSTS_DIR"] !== undefined
        ? process.env["SONDINE_NATIVE_HOSTS_DIR"]
        : null,
    phoneSocket: join(args.dataDir, DATA_LAYOUT.phoneSocket),
    phoneRelay:
      args.phoneRelay === null
        ? null
        : { path: args.phoneRelay, allowLoopback: args.phoneRelayLoopback },
    voiceReadDir: args.voiceRecorder ? join(args.dataDir, DATA_LAYOUT.voiceReadDir) : null,
  };
}

/** Reads the arguments main passed to `utilityProcess.fork` (see `coreArgv`). */
export function parseCoreArguments(argv: readonly string[]): CoreArguments {
  const { values } = parseArgs({
    args: [...argv],
    strict: false,
    options: {
      "data-dir": { type: "string" },
      "migrations-dir": { type: "string" },
      "helper-socket": { type: "string" },
      "app-version": { type: "string" },
      "macos-version": { type: "string" },
      "stats-endpoint": { type: "string" },
      "update-block": { type: "string" },
      "update-test-feed": { type: "string" },
      "models-dir": { type: "string" },
      "speech-binary": { type: "string" },
      "voice-binary": { type: "string" },
      "voice-model": { type: "string" },
      "text-server": { type: "string" },
      "text-socket": { type: "string" },
      "agent-relay": { type: "string" },
      "agent-relay-socket-argument": { type: "boolean" },
      "browser-relay": { type: "string" },
      "browser-relay-socket-argument": { type: "boolean" },
      "browser-extension": { type: "string" },
      "phone-relay": { type: "string" },
      "phone-relay-loopback": { type: "boolean" },
      "voice-recorder": { type: "boolean" },
    },
  });
  return CoreArguments.parse({
    dataDir: values["data-dir"],
    migrationsDir: values["migrations-dir"],
    helperSocket: values["helper-socket"],
    appVersion: values["app-version"],
    macosVersion: values["macos-version"],
    statsEndpoint: values["stats-endpoint"] ?? null,
    updateBlock: values["update-block"] ?? null,
    updateTestFeed: values["update-test-feed"] ?? null,
    modelsDir: values["models-dir"],
    speechBinary: values["speech-binary"] ?? null,
    voiceBinary: values["voice-binary"] ?? null,
    voiceModel: values["voice-model"] ?? null,
    textServer: values["text-server"] ?? null,
    textSocket: values["text-socket"] ?? null,
    agentRelay: values["agent-relay"] ?? null,
    agentRelaySocketArgument: values["agent-relay-socket-argument"] === true,
    browserRelay: values["browser-relay"] ?? null,
    browserRelaySocketArgument: values["browser-relay-socket-argument"] === true,
    browserExtension: values["browser-extension"] ?? null,
    phoneRelay: values["phone-relay"] ?? null,
    phoneRelayLoopback: values["phone-relay-loopback"] === true,
    voiceRecorder: values["voice-recorder"] === true,
  });
}

export const coreConfigLayer = (config: CoreConfigShape) => Layer.succeed(CoreConfig, config);
