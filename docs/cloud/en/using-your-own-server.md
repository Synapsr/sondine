# Using your own machine (`sondine-compute`)

_Guide to what is built ([ADR 040](../../decisions/040-remote-compute.md), 2026-11-24)._

If you have a Linux PC with an NVIDIA card, or another 32 GB Mac, it can transcribe for a Mac that is too small. It is free, involves no server of ours, and is off until you choose it.

- **Only the audio of finished conversations leaves**, voices and spoken names included. The text comes back to your Mac. Voice profiles, people and your database stay on the Mac, and the server never gets your journal, which is written on the Mac unless you chose Claude.
- **Everything is encrypted all the way to the program**, whatever the network (Noise NK). The program archives no audio or text.
- **It keeps, per Mac,** a hash of its token, the name you gave it, when it was added and last used, and the seconds transcribed in the last month it was used, until you `remove` it.
- **Private zones that keep no text never leave**, even with "Transcribe now".
- **Whoever administers that machine can technically read** what it computes, AI agents with Docker or `sudo` included. On a rented VM, so can its host.

---

## Which machine for which model

Sondine uses **Nemotron 3.5 Transcribe 30B in IQ4_NL** (19.0 GB). On 100 English utterances, larger versions do no better (8.64 to 8.77% word errors for all three, [author's measurements](https://github.com/nyosegawa/speech.cpp/blob/v0.11.2/docs/models/nemotron-transcribe.md)); French and speaker separation are not measured there. It is the compromise we chose.

| Machine                                  | Nemotron 30B                           | Speed (× real time)                                | Our advice                           |
| ---------------------------------------- | -------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| Apple Silicon Mac, 8, 16 or 24 GB        | No                                     | —                                                  | 32 GB required (24 GB not validated) |
| **Apple Silicon Mac, 32 GB or more**     | Yes, whole on the GPU                  | 2.7 to 4.3 on M5 _(measured)_                      | **Recommended, the simplest**        |
| Linux PC, 8 GB NVIDIA + 32 GB of RAM     | Yes, 18 of 23 layers in RAM (13 GB)    | 2.1 to 2.8 on RTX 2080 _(author's measurement)_    | Minimum                              |
| Linux PC, 12 GB NVIDIA + 32 GB of RAM    | Yes, ~12 layers in RAM (~9 GB)         | not measured                                       | Fine                                 |
| Linux PC, 16 GB NVIDIA + 32 GB of RAM    | Yes, 6 to 10 layers in RAM (4 to 7 GB) | 6.6 to 8.4 on RTX 5080 _(measured, 10 and 45 min)_ | Good                                 |
| **Linux PC, 24 GB NVIDIA or more**       | Yes, whole on the card (18.4 GiB)      | not measured (13 to 26 on H100)                    | **Fastest at home**                  |
| Linux PC or server, no GPU, 32 GB of RAM | Possible                               | unknown                                            | Only to try                          |
| AMD or Intel card (Vulkan)               | Possible                               | unknown                                            | Not checked by the author            |

The card needs about 3.7 GB free, plus 0.72 GB for each expert layer it keeps; the rest goes to RAM. **With less than 3.7 GB free, loading is refused.** On a Mac under 32 GB, Sondine keeps near-live text and dictations (Parakeet) local.

---

## Install the server (Linux)

You need Linux x86-64 (glibc 2.34 or later), Node 24, the NVIDIA driver, `libvulkan1` and 25 GB of disk. The exact commands (engine, model, service at startup, or a Docker container with the NVIDIA Container Toolkit) are in [`apps/compute/README.md`](../../../apps/compute/README.md). The server checks the model's fingerprint at each start and refuses any other file.

Have it listen on its **Tailscale** address (`tailscale ip -4`): nothing is exposed to the internet. On a local network, its local address works too.

## Connect a Mac

1. On the machine: `node sondine-compute.js add "Marie's Mac" --endpoint http://100.x.y.z:8443`.
2. Copy the line it prints. It holds that Mac's token: send it as you would a password.
3. In Sondine: **Settings ▸ Transcription ▸ Your machine** (or **Your machine** at the first run), paste the line, **Connect**.

`list` shows the Macs and their hours this month; `remove` takes access away at once. In Sondine, **This Mac** stops what is leaving, and **Forget this machine** erases the link.

## Another Mac as the server

The same program, with the macOS archive of `speech.cpp` 0.9.3. **Not tried yet.** Avoid a Mac whose Sondine transcribes too: two 19 GB models do not fit together in 32 GB.

## Day to day

- **Machine off or offline:** conversations wait on the Mac, and Sondine tries again less and less often (30 seconds to 15 minutes), without counting them as failed. "Transcribe now" tries at once. Retention keeps running: "Keep audio" protects a conversation.
- **Several Macs:** one request at a time, each in turn.
- **Deletion:** what is leaving stops within about a second. What already left cannot be called back; the server forgets it on cancellation, or ten minutes after it last heard from your Mac or finished transcribing.
- **Network:** audio leaves uncompressed, about 115 MB per hour (1 min 30 s at 10 Mbps).
- **Card:** the model frees it after three minutes without work. `SONDINE_COMPUTE_IDLE_UNLOAD_SEC` on the server changes that delay, and `0` keeps the model loaded, so a conversation starts at once.
