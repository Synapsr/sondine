import type { PlaybackRoute } from "@sondine/db";
import type { DevicesEvent } from "@sondine/protocol";

// Where the Mac plays sound now, from the helper's latest device list: the
// room hears speakers, not headphones. Headphones are the built-in jack
// (`hdpn`), Bluetooth (AirPods, headsets: a Bluetooth speaker is taken for
// headphones), or a device named so (a USB headset). Anything else, or no
// device list yet, counts as speakers: the microphone likely hears it.

export function outputRoute(devices: DevicesEvent | null): PlaybackRoute {
  const output = devices?.devices.find((device) => device.uid === devices.defaultOutputUid);
  if (output === undefined) return "speakers";
  if (output.dataSource === "hdpn") return "headphones";
  if (output.transport === "bluetooth" || output.transport === "bluetooth-le") return "headphones";
  if (/headphone|headset|casque|écouteur/i.test(`${output.uid} ${output.name}`)) {
    return "headphones";
  }
  return "speakers";
}
