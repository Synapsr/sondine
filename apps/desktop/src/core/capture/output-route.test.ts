import type { DevicesEvent } from "@sondine/protocol";
import { describe, expect, it } from "vitest";
import { outputRoute } from "./output-route";

type Device = DevicesEvent["devices"][number];

const device = (uid: string, overrides: Partial<Device> = {}): Device => ({
  uid,
  name: uid,
  transport: "built-in",
  transportCode: null,
  input: false,
  output: true,
  alive: true,
  nominalRate: 48_000,
  dataSource: null,
  loopback: false,
  ...overrides,
});

const playingOn = (output: Device): DevicesEvent => ({
  type: "devices",
  defaultInputUid: null,
  defaultOutputUid: output.uid,
  devices: [output],
});

describe("outputRoute", () => {
  it("tells the speakers from headphones", () => {
    expect(outputRoute(playingOn(device("BuiltInSpeakerDevice", { dataSource: "ispk" })))).toBe(
      "speakers",
    );
    expect(outputRoute(playingOn(device("BuiltInHeadphoneOutputDevice")))).toBe("headphones");
    expect(outputRoute(playingOn(device("BuiltInSpeakerDevice", { dataSource: "hdpn" })))).toBe(
      "headphones",
    );
    expect(
      outputRoute(playingOn(device("AirPods", { name: "AirPods Pro", transport: "bluetooth" }))),
    ).toBe("headphones");
    expect(outputRoute(playingOn(device("Studio Display", { transport: "displayport" })))).toBe(
      "speakers",
    );
  });

  it("takes an unknown output for the speakers", () => {
    expect(outputRoute(null)).toBe("speakers");
  });
});
