import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { macAddresses } from "./phone-layer";

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

const v6 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: "ffff:ffff:ffff:ffff::",
  family: "IPv6",
  mac: "00:00:00:00:00:00",
  internal: false,
  cidr: `${address}/64`,
  scopeid: 0,
});

// The order of `hello`'s addresses: the phone tries the tunnel's only when the others do not answer.
const interfaces = {
  lo0: [v4("127.0.0.1", true)],
  // A VPN's tunnel listed first, as macOS may list them.
  utun4: [v4("100.88.10.20"), v6("fd7a:115c:a1e0::9001:ba2a")],
  utun7: [v4("172.20.0.2")],
  en0: [v4("192.168.1.24"), v6("fe80::1c2b:3a4d:5e6f:7081")],
  en8: [v4("10.0.0.2")],
  awdl0: [v6("fe80::4:5")],
};

describe("the Mac's addresses for a phone", () => {
  it("lists the home network's, and Tailscale's only when allowed, last", () => {
    expect(macAddresses(false, interfaces)).toEqual(["192.168.1.24", "10.0.0.2"]);
    expect(macAddresses(true, interfaces)).toEqual(["192.168.1.24", "10.0.0.2", "100.88.10.20"]);
  });

  it("never lists Tailscale's range on a network that is not a tunnel", () => {
    const carrier = { en0: [v4("100.70.1.2")], utun3: [v4("100.88.10.20")] };
    expect(macAddresses(false, carrier)).toEqual([]);
    expect(macAddresses(true, carrier)).toEqual(["100.88.10.20"]);
  });
});
