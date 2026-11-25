# Search from the iPhone against the same search on the Mac — 2026-11-13

Plan § M5.4's exit: « Search on the phone answers within 300 ms more than
the same search on the Mac (p95, local network) ». Measured here on
loopback only; the local network is to be measured on Téo's devices
(steps below).

## Loopback, end to end (`pnpm test:native`)

`apps/desktop/test/phone-sync-e2e.test.ts`, on this Mac (macOS 27.2, Apple
silicon), after the M5.3 steps of that test: the real core on a scratch data
directory, the real `sondine-lan` (TLS 1.3, its peer check, its byte copy)
behind the test's TCP proxy, and `sondine-phone-e2e`, SondinePhone's real
client (`MacMemory` over `URLSessionTransport`, pinned TLS, kept-alive
connection). The memory holds two phone recordings transcribed by the fake
engine; the word is « Bonjour », found in one of them.

- The Mac: `search.query` through the app's router in core, as the window
  calls it, 5 warm-up searches then 100 timed.
- The phone: `time-search`, 5 warm-up searches then 100 timed, each from
  `MacMemory.search` to the decoded answer (JSON out, TLS, relay, core's
  HTTP server, the same procedure, the answer decoded).

| Side  | p50     | p95     |
| ----- | ------- | ------- |
| Mac   | 5.12 ms | 5.51 ms |
| Phone | 5.79 ms | 6.20 ms |

The phone's p95 is **0.69 ms** over the Mac's (limit: 300 ms). The test
fails above 300 ms, and with `SONDINE_MEASURE_OUT=<file>` appends its
numbers as one JSON line:

```json
{
  "measure": "phone-search",
  "at": "2026-11-13T19:09:18.391Z",
  "path": "loopback, sondine-lan with TLS 1.3, core",
  "searches": 100,
  "macMs": { "p50": 5.12, "p95": 5.51 },
  "phoneMs": { "p50": 5.79, "p95": 6.2 },
  "overMs": 0.69
}
```

What loopback leaves out: the Wi-Fi's round trips (a few ms at home, more
on a busy 2.4 GHz band), the iPhone's radio waking up for the first request
after a pause, and its slower CPU decoding the JSON. A page of 20 results is
a few kB; the margin left for those is about 299 ms.

## On Téo's devices (to do)

Each side logs its time, never the words:

- core logs each phone read as `phone.read {"route":"search","status":"results","ms":…}`:
  the time of the same procedure the Mac's window calls, in core;
- the iPhone app logs each read as `read search <ms> ms` (subsystem
  `app.sondine.ios`, category `memory`): from the tap to the decoded answer.

Steps, with the iPhone paired and on the same Wi-Fi as the Mac:

1. Quit Sondine, then start it from Terminal so core's lines show:
   `/Applications/Sondine.app/Contents/MacOS/Sondine 2>&1 | grep phone.read`.
2. Connect the iPhone to the Mac by cable, open Console.app, select the
   iPhone, filter on `subsystem:app.sondine.ios category:memory`, Start.
3. On the iPhone, search a word with a few dozen results 25 times (type it,
   « Rechercher », clear the field, again), the app in front.
4. Copy both columns of milliseconds. Over the last 20 of each, take the
   p95 (the 19th smallest); the iPhone's p95 minus core's p95 must stay
   under 300 ms.
5. Optional, without the iPhone: from a second Mac on the same Wi-Fi,
   `sondine-phone-e2e --root <scratch> --mac <Mac's IP>:<port>` paired with
   the Mac (`{"cmd":"pair","url":"<QR text>"}`), then
   `{"cmd":"time-search","text":"<word>","count":100}` gives the client's
   times over the real network; revoke that « phone » in Settings ▸
   Téléphone afterwards.

Record the numbers below this line with the date, the Wi-Fi band and the
iPhone model.
