# Sync through Tailscale: packet captures (M5.5)

Plan § M5.5's exits on the devices: with « Autoriser par Tailscale » off a
peer from 100.64.0.0/10 is refused, on a paired phone syncs and reads, an
unpaired one is refused; and Sondine's processes talk to the phone's tunnel
address only, never to a Tailscale host. Built and tested on one Mac
(ADR 008, « Built at M5.5 »); these are the steps for Téo's iPhone and Mac.
Nothing measured yet.

Nothing here is committed but this file: captures hold addresses and
timings, and stay in the scratch folder named below, outside the
repository.

## Before

1. Tailscale on the Mac and the iPhone, same tailnet. Note both addresses:
   `tailscale ip -4` on the Mac (or the menu bar); the iPhone's in the
   Tailscale app. Below, `MAC_TS` and `PHONE_TS`.
2. Sondine on the Mac: Settings ▸ Téléphone ▸ « Autoriser par Tailscale »
   on. The iPhone at home on the Wi-Fi: open Sondine once, wait for « À la
   maison » on screen 5 (Mac): its `hello` taught it `MAC_TS`.
3. The tunnel interface on the Mac: `ifconfig | grep -B3 "inet $MAC_TS"`,
   say `utun4` (below `UTUN`).
4. Sondine's processes: `pgrep -fl sondine-lan` (the relay, the only one
   with a port) and core: `pgrep -fl "utility.*core"` or Activity Monitor.

## On the Mac: what the relay talks to

```sh
mkdir -p ~/sondine-captures/ts && cd ~/sondine-captures/ts
# Everything on the tunnel while the phone syncs (stop with ^C).
sudo tcpdump -i "$UTUN" -n -w mac-utun.pcap
# Sondine's sockets, every few seconds, during the same sync.
while true; do date; sudo lsof -nP -a -i -p "$(pgrep -d, -f 'sondine-lan|Sondine')"; sleep 2; done > lsof.txt
```

What to check:

- `tcpdump -nr mac-utun.pcap 'tcp port <relay port>'`: every packet is
  between `MAC_TS` and `PHONE_TS`.
- `lsof.txt`: the relay holds its listening socket and connections with
  `PHONE_TS` only; core holds no TCP socket at all (its phone socket is a
  Unix socket). No line to a `*.tailscale.com` or DERP address
  (`tailscale netcheck` lists the DERP regions) from a Sondine process.
- macOS's own view, per process: `nettop -m tcp -p sondine-lan -L 1`
  during the sync.

## On the iPhone: rvictl

The iPhone by cable to the Mac, trusted.

```sh
UDID=<the iPhone's UDID>   # xcrun xctrace list devices, or Finder ▸ iPhone ▸ click the serial
rvictl -s "$UDID"                     # makes rvi0
sudo tcpdump -i rvi0 -k NP -n -w phone.pcapng   # -k NP: process name and PID in each packet's metadata
# … the test below …
rvictl -x "$UDID"
```

What to check, with `tcpdump -r phone.pcapng -k NP -n`:

- Packets of process `Sondine` go to `MAC_TS` on the relay's port only,
  on cellular (step 2 below) and nothing else (no DNS, no other host).
- The WireGuard packets (UDP 41641, or HTTPS to DERP) belong to the
  Tailscale extension, not to `Sondine`.

## The test, in order

1. Mac switch off; iPhone on cellular (Wi-Fi off), Tailscale on. Screen 5
   « Synchroniser maintenant »: the Mac is not reachable; the relay's
   lines in core's log say `refused a peer (shared (100.64/10)): not on an
   allowed path` (or nothing reaches it if the relay was stopped).
2. Switch on. « Synchroniser maintenant »: within a few seconds « Joignable »,
   « Chemin : Par Tailscale »; Settings ▸ Téléphone says « …, par
   Tailscale ». Record 20 s, stop: it reaches the Mac (« Transcrit » after
   the analysis); open the result, play a few seconds.
3. Pairing on that path (optional: it needs « Oublier ce Mac » on the
   iPhone, then pairing again at home): on cellular, scan a new QR from
   « Appairer un iPhone… »; the phone says « Appairez à la maison, sur le
   même Wi-Fi que le Mac. » and the Mac shows no six digits.
4. An unpaired phone: from another tailnet device, `curl -sk
   https://$MAC_TS:<port>/v1/hello -H 'authorization: Bearer
   sdp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' -d '{}'` answers 401
   `unauthorized` (with the switch on), and nothing at all with it off.
5. Back home on the Wi-Fi, Tailscale still on: « Chemin : À la maison ».
6. Timing: from « Synchroniser maintenant » to « Joignable » on cellular,
   five times (target: a few seconds; the finder waits 2 s at most for
   home, 4 s at most for the tunnel).

Then `rm -rf ~/sondine-captures/ts` once read.
