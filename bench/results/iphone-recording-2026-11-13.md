# iPhone recording: device exits of M5.1 (2026-11-13)

Téo's iPhone 16 Pro, iOS 27, Sondine 0.1.0 (263160751) from TestFlight,
ALAC 16 kHz mono, built-in microphone. The files came by AirDrop and were
read by the Mac's import (`readPhoneFile`, `prepareImport`, `importRecording`)
on a scratch database, then deleted. Nothing was listened to or transcribed.
Numbers only.

## 1. First recording and import (2026-11-12)

One file of 566,974 bytes, 42.4 s; its header valid (part 1, built-in
microphone, `utcOffsetMin` 60); start at 09:02:20 Paris, time not uncertain;
imported as `in_person` with the « iPhone » mark; sent twice, the second
time « déjà là ».

## 2. Five forced quits while recording (2026-11-13)

Téo started « Enregistrer », read the counter on screen, then removed the
app from the app switcher at once. The counter shows whole seconds, so at
the reading the recording had run between the time read and one second
more; the loss is that span minus the file's length (floored at 0), plus
the reaction between reading and the swipe, which is not measured.

| Read on screen | File length | Lost (s)  | Notice on reopening | Import                  |
| -------------- | ----------- | --------- | ------------------- | ----------------------- |
| 0:00:20        | 20.22 s     | 0 – 0.8   | yes                 | read to its end, part 1 |
| 0:01:01        | 60.16 s     | 0.8 – 1.8 | yes                 | read to its end, part 1 |
| 0:02:31        | 150.02 s    | 1.0 – 2.0 | yes                 | read to its end, part 1 |
| 0:05:00        | 300.03 s    | 0 – 1.0   | yes                 | read to its end, part 1 |
| 0:10:00        | 600.06 s    | 0 – 0.9   | yes                 | read to its end, part 1 |

Each loss is within the 2 s target (ADR 032; the writer's fragment
interval is 2 s). Every header was valid, its start plausible (not
« heure incertaine »), and each file imported as one episode.

Open: the empty battery, interruptions with the phone locked, 3 h locked,
battery against Voice Memos, the codec on real speech, the packet capture.

## 3. First pairing and sync at home (M5.2, 2026-11-13)

Téo's iPhone (TestFlight 0.1.0 (263171716)) and his Mac on a home
Wi-Fi (IPv4 and global IPv6). Two faults first, both on the
Mac's relay: it refused the iPhone's global IPv6 address (now accepted
when it is in a prefix the Mac holds on the Wi-Fi), and under App Sandbox
without `network.client` it never answered a peer on the Wi-Fi (the kernel
denied each answer as `network-outbound`; ADR 008). Then, from core's log:

- Pairing: the six digits matched, paired in 11 s from the QR.
- The six recordings already on the phone (20 s to 10 min, 1,182 s in all)
  were received and stored in 1.2 s, each import 62 to 214 ms.
- Five deletions on the phone ran the Mac's deletion (`held: true`).
- A new 9 s recording was stored about a second after « Arrêter ».

Open on the devices: a transfer cut three ways, a deletion on the Mac
reaching the phone, a revocation, the packet captures.
