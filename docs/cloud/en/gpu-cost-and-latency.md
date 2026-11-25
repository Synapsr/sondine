# Cost per audio hour and latency by machine

_Design document ([ADR 040](../../decisions/040-remote-compute.md)), revised on 2026-11-24. Final transcription only: the journal does not go to a server in v1. **Sondine has measured a single NVIDIA machine (RTX 5080, §2).** Azure prices come from Azure's public API (Linux, `westeurope`, 2026-11-24); the neocloud price is unverified. Nothing should be announced before `sondine-bench` runs on the chosen machine._

---

## 1. What is measured

All figures are for Nemotron 3.5 Transcribe 30B in IQ4_NL (a 19.0 GB file).

| Machine                              | Speed (× real time) | Memory                         | Source                                                                          |
| ------------------------------------ | ------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Mac M5 32 GB, `speech.cpp` 0.9.3     | **2.7 to 4.3**      | 17.1 to 19 GB peak             | our measurements (ADR 016, ADR 018), conversations with speakers and timestamps |
| Mac M5 32 GB                         | 5.4 to 8.5          | 17.2 GiB                       | [`speech.cpp`'s author][page], short utterances                                 |
| NVIDIA H100 80 GB, Vulkan            | 13 to 26            | 18.4 GiB of VRAM               | [`speech.cpp`'s author][page], short utterances                                 |
| NVIDIA RTX 2080 8 GB + Core i9-9900K | 2.1 to 2.8          | 6.1 GiB of VRAM + 13 GB of RAM | [`speech.cpp`'s author][page]                                                   |

On the M5, our conversations run about half as fast as the author's short utterances. We therefore assume **7 to 25× for an H100**, one stream.

An earlier version of this document assumed 40 to 60× per stream and 75× overall. The published measurements contradict it: **the confidential cloud costs more than we stated**.

Two routes could lower the cost, to be measured:

- **Several requests at once**: `speech.cpp` has not been measured that way.
- **vLLM 0.32 and NVIDIA's NeMo Speech plugin**, the model's official serving stack, built for one 80 GB GPU.

A larger version is not planned. On 100 English utterances (FLEURS), the author measures 8.77% word errors with IQ4_NL (19 GB), 8.64% with Q8_0 (35.8 GB) and 8.73% with F16 (67.4 GB). French and speaker separation are not measured there.

**Network:** 35 to 50 MB per hour of speech in FLAC, or 3 to 5 s of upload at 100 Mbps, 30 to 40 s at 10 Mbps.

---

## 2. Beta on a Synapsr server

Machine measured on 2026-11-24: an **RTX 5080 (16 GB)** and 32 GB of RAM, on Linux, with 13.5 GB free on the card. `speech.cpp` 0.9.3 on Vulkan keeps 13 of 23 expert layers on the card, and the CPU computes the other 10.

- **Measured speed: 6.6× real time over 45 minutes** (412 s), 8.4× over 10 minutes (71 s), 4.1× over 1 minute, with speakers and timestamps. One hour of audio therefore takes about **9 minutes**, plus 19 to 21 s of loading when the model is not already resident. `speech.cpp` 0.11.2 reaches 8.8× over 10 minutes.
- **Conditions:** a synthetic two-voice French conversation, one pass per duration, no real recording. Both voices are told apart. Real conversations may run slower.
- **Memory:** at its peak, 15.4 GiB of the card's 15.9 GiB (other programs included), and 9.2 GB of RAM. Almost nothing is left for another GPU use during computation.
- **Capacity:** 10 people at 1.6 h per working day need ~2 h 25 of computation per day. Keeping the machine idle three quarters of the time, it would serve about 25. The queue remains the weak point: one request at a time.
- **Sharing:** when other services use the card, the engine moves more experts to RAM and slows down.
- **CPU only:** servers without a GPU can run the Linux CPU build. Speed unknown.
- **Cost:** nothing to rent. Electricity and operating time remain. No redundancy and no guarantee: during an outage, conversations wait on the Mac.

---

## 3. Confidential cloud (attested H100), later

| Offer (confidential H100)  | Price    | Cost per audio hour at 60% utilization | At 25%         |
| -------------------------- | -------- | -------------------------------------- | -------------- |
| TEE neocloud (unverified)  | ~$3.08/h | $0.21 to $0.73                         | $0.49 to $1.76 |
| Azure EU, reserved 3 years | $4.90/h  | $0.33 to $1.17                         | $0.78 to $2.80 |
| Azure EU, reserved 1 year  | $6.67/h  | $0.44 to $1.59                         | $1.07 to $3.81 |
| Azure EU, on demand        | $8.90/h  | $0.59 to $2.12                         | $1.42 to $5.09 |

Cost = hourly price ÷ (speed × utilization), at 7 to 25×, one stream, without the overhead of NVIDIA's confidential mode. Redundancy takes two nodes.

**The engine is not settled in confidential mode.** On Linux, `speech.cpp` is released for Vulkan and for the CPU; its CUDA version builds, but [its author does not check it][install]. NVIDIA lists CUDA/Vulkan interop among the features [incompatible with confidential mode][cc], and we found no support for Vulkan in that mode. To try: `speech.cpp` built for CUDA, then vLLM.

[page]: https://github.com/nyosegawa/speech.cpp/blob/v0.11.2/docs/models/nemotron-transcribe.md
[install]: https://github.com/nyosegawa/speech.cpp/blob/v0.11.2/docs/install.md
[cc]: https://docs.nvidia.com/confidential-computing/release-notes/r570-trd1.md
