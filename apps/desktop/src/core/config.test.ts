import { describe, expect, it } from "vitest";
import { coreArgv, type CoreArguments } from "../shared/core-messages";
import { coreConfigFrom, parseCoreArguments } from "./config";

const args: CoreArguments = {
  dataDir: "/Users/t/Library/Group Containers/P5G8WAJ2G2.app.sondine",
  migrationsDir: "/Applications/Sondine.app/Contents/Resources/drizzle",
  helperSocket: "/Users/t/Library/Group Containers/P5G8WAJ2G2.app.sondine/run/audio.sock",
  appVersion: "0.1.0",
  macosVersion: "27.0.1",
  updateBlock: null,
  updateTestFeed: null,
  statsEndpoint: "https://stats.sondine.app/v1/report",
  modelsDir: "/Users/t/Library/Application Support/Sondine/models",
  speechBinary:
    "/Applications/Sondine.app/Contents/Helpers/Sondine Speech.app/Contents/MacOS/speech",
  voiceBinary:
    "/Applications/Sondine.app/Contents/Helpers/Sondine Voice.app/Contents/MacOS/sondine-voice",
  voiceModel:
    "/Applications/Sondine.app/Contents/Helpers/Sondine Voice.app/Contents/Resources/wespeaker_v2.mlmodelc",
  textServer:
    "/Applications/Sondine.app/Contents/Helpers/Sondine Text.app/Contents/MacOS/llama-server",
  textSocket: "/Users/t/Library/Containers/app.sondine.text/Data/tmp/sondine-text.sock",
  agentRelay: "/Applications/Sondine.app/Contents/Helpers/sondine-mcp",
  agentRelaySocketArgument: false,
  browserRelay: "/Applications/Sondine.app/Contents/Helpers/sondine-browser",
  browserRelaySocketArgument: false,
  browserExtension: "/Applications/Sondine.app/Contents/Resources/browser-extension",
  phoneRelay: "/Applications/Sondine.app/Contents/Helpers/sondine-lan",
  phoneRelayLoopback: false,
  voiceRecorder: true,
};

describe("core arguments", () => {
  it("survive main's argv, spaces included", () => {
    // utilityProcess.fork passes them after the module path.
    expect(parseCoreArguments(["/app/core.js", ...coreArgv(args)])).toEqual(args);
  });

  it("carry the absence of a speech executable", () => {
    const without = { ...args, speechBinary: null };
    expect(coreArgv(without).some((arg) => arg.startsWith("--speech-binary"))).toBe(false);
    expect(parseCoreArguments(coreArgv(without))).toEqual(without);
  });

  it("give core its models folder and speech executable", () => {
    expect(coreConfigFrom(args)).toMatchObject({
      modelsDir: args.modelsDir,
      speechBinary: args.speechBinary,
    });
  });

  it("give core the journal's server and its socket, or neither (ADR 028)", () => {
    expect(coreConfigFrom(args).textServer).toEqual({
      binary: args.textServer,
      socket: args.textSocket,
    });
    const none = { ...args, textServer: null, textSocket: null };
    expect(parseCoreArguments(coreArgv(none))).toEqual(none);
    expect(coreConfigFrom(none).textServer).toBeNull();
  });

  it("give core the agents' socket and relay, with or without the socket argument", () => {
    expect(coreConfigFrom(args)).toMatchObject({
      agentSocket: `${args.dataDir}/run/mcp.sock`,
      agentRelay: { path: args.agentRelay, socketArgument: false },
    });
    const dev = {
      ...args,
      agentRelay: "/repo/native/.build/debug/sondine-mcp",
      agentRelaySocketArgument: true,
    };
    expect(parseCoreArguments(coreArgv(dev))).toEqual(dev);
    const none = { ...args, agentRelay: null };
    expect(parseCoreArguments(coreArgv(none))).toEqual(none);
    expect(coreConfigFrom(none).agentRelay).toBeNull();
  });

  it("give core the browser link's socket, relay and extension (ADR 023)", () => {
    expect(coreConfigFrom(args)).toMatchObject({
      browserSocket: `${args.dataDir}/run/browser.sock`,
      browserRelay: { path: args.browserRelay, socketArgument: false },
      browserExtension: {
        source: args.browserExtension,
        target: `${args.dataDir}/browser-extension`,
      },
      nativeHostsDir: null,
    });
    const none = { ...args, browserRelay: null, browserExtension: null };
    expect(parseCoreArguments(coreArgv(none))).toEqual(none);
    expect(coreConfigFrom(none)).toMatchObject({ browserRelay: null, browserExtension: null });
  });

  it("give core the phones' socket and relay, loopback in development only (ADR 008)", () => {
    expect(coreConfigFrom(args)).toMatchObject({
      phoneSocket: `${args.dataDir}/run/phone.sock`,
      phoneRelay: { path: args.phoneRelay, allowLoopback: false },
    });
    const dev = {
      ...args,
      phoneRelay: "/repo/native/.build/debug/sondine-lan",
      phoneRelayLoopback: true,
    };
    expect(parseCoreArguments(coreArgv(dev))).toEqual(dev);
    expect(coreConfigFrom(dev).phoneRelay).toEqual({ path: dev.phoneRelay, allowLoopback: true });
    const none = { ...args, phoneRelay: null };
    expect(parseCoreArguments(coreArgv(none))).toEqual(none);
    expect(coreConfigFrom(none).phoneRelay).toBeNull();
  });
});
