# Operator Guide — Deploying, Measuring, and Verifying Sondine Cloud (TEE)

_Design document revised after adversarial review (Pass 1, [ADR 040](../../decisions/040-remote-compute.md), [threat model](../threat-model.md))._

This guide is for the Synapsr team (and any independent operator or security auditor) deploying a verifiable confidential instance of `sondine-compute`, publishing its measurements to a transparency log, signing the quorum trust policy, and verifying live attestation.

---

## 0. The beta, on an ordinary server

The team starts over Tailscale, with no public port (["Your machine"](using-your-own-server.md)). What follows is for outside testers.

The beta is the same `sondine-compute` as ["Your machine"](using-your-own-server.md), operated by Synapsr. Sections 1 to 6 describe the confidential cloud and do not apply to it.

- **Server:** NVIDIA card with 12 GB or more, 32 GB of RAM, no other service that holds the card all the time.
- **Deployment:** a `systemd` user service ([`apps/compute/README.md`](../../../apps/compute/README.md)), kept out of the swap (`MemorySwapMax=0`) and of crash dumps (`LimitCORE=1`). The tunnel only sees ciphertext. `SONDINE_COMPUTE_BETA_PLACES` opens the beta: 5 today, 10 planned.
- **Logs:** one line per event, its time and a word (`beta-claimed`, `transcribed`, `failed` with a code, `expired`). No content, no duration, no place, no address. Keep no access log in front of the service either. The machine's journal keeps these lines as long as it is set to: set a limit.
- **State on disk:** per place, `clients/` (CLI and open-beta `claim` only) holds a hash of its token, an operator label (use an opaque ID for invited plans, never a real name or e-mail), its plan (`own`, `beta`, `trial`, `cloud`), included/top-up limits, and when it was made; `usage/` (running server only) holds when it was last charged and **the seconds transcribed in the current UTC month**, plus cumulative `totalSeconds` for `trial` clients and `extraSpent` once top-ups are used (`own` and open-beta places without top-ups keep only the current month). Open-beta places stay until given back (the Mac asks once), removed (`remove`) or reclaimed after 14 idle days; invited plans (`trial`, `cloud`) refuse `leave`, are never reclaimed, and stay until removed by the operator. Tell users so, and say nothing stronger than this list.
- **Not a ZDR:** nothing is kept of the content by the program, but that is not zero data retention towards you, the administrators. Never announce it as such.
- **Administrators:** anyone with root or Docker access can read the program's memory, **including an AI agent installed on the machine**. Take those rights away from it, or move it. Keep the list current, keep it short, turn on two-factor authentication. The app tells testers that the people and programs who administer the server could read it.
- **Access:** Cloudflare Tunnel (`cloudflared`) to `cloud.sondine.app`, with no open port. The service hands out its places (`POST /v1/open`, a `claim`), with revocable tokens, at most three a day per address (a salted hash, in memory). No account, no payment. Places back to 0 closes the beta.
- **Limits:** one request at a time, two per client and thirty in all, 1.5 GB of audio in memory, 40 hours a month per place; the rest is told to wait.
- **Exit:** when the confidential cloud opens, revoke the places and destroy the instance. Each Mac asks the person again.

---

## 1. Infrastructure overview

Sondine Cloud strictly separates **five roles** so no single component holds customer identity, client IP, and plaintext content together:

1. **Billing & Privacy Pass Issuer (outside TEE)**: manages subscriptions/packs (e.g., Stripe) and blindly signs **RSA Blind Signature tokens (RFC 9578 Token Type `0x0002`, publicly verifiable)**. Never handles audio or compute requests.
2. **OHTTP Relay (operated by a legally independent third party)**: receives OHTTP envelopes from Macs, strips client IP addresses, and forwards opaque payloads to Synapsr's gateway. Sees client IP and encrypted traffic sizes/timings; never holds HPKE keys.
3. **Synapsr Routing Gateway (outside TEE, stateless)**: terminates OHTTP and holds its key, routes to active TEE enclaves, and serves `/v1/attestation` plus the signed `CloudTrustPolicy`. Never sees client IPs or plaintext.
4. **Minimal Shared Double-Spend Registry (content-free)**: stores only `{ epochId, SHA256(token_authenticator), state: "reserved" | "spent", expiresAt }` to prevent double spending across multiple TEE nodes and across restarts. **Receives no content, no IP, and no user identifier.** Queried by enclaves over a dedicated private mTLS link restricted to this single endpoint.
5. **TEE Compute Nodes (`sondine-compute` inside confidential VMs)**:
   - CPU: **AMD SEV-SNP** (e.g., Azure `Standard_NCC40ads_H100_v5` in `westeurope`) or **Intel TDX** (TEE neocloud; _note:_ GCP's confidential `a3-highgpu-1g` is currently documented under Spot/Flex-start provisioning and requires contractual validation before permanent interactive use).
   - GPU: **NVIDIA H100 / H200 / B200** in **Confidential Computing mode (`cc_mode=ON`)**. _(Hardware note: on H100, CPU RAM and PCIe transfers are encrypted; on-package HBM is protected by hardware memory isolation, not encrypted.)_
   - Inside the enclave: **strict process separation between the minimal front-end** (holds the enclave HPKE key, handles session crypto and Privacy Pass; OHTTP ends at the gateway, no GPU code) **and the isolated GPU worker process** (engine to be chosen, see [costs](gpu-cost-and-latency.md) §3; zero access to enclave private keys, `seccomp`, read-only `dm-verity` rootfs).

---

## 2. Building a reproducible server image

- **Pinned toolchain**: Nix / Bazel or digest-pinned Dockerfiles, minimal hardened Linux kernel, deterministic `initramfs` (`SOURCE_DATE_EPOCH=0`).
- **Immutable rootfs (`dm-verity`)**: mounted read-only and verified by Merkle tree rooted in the measured initrd.
- **Verified model weights**: Nemotron 30B mounted from a measured `dm-verity` volume or SHA-256 verified at boot prior to accepting any traffic.
- **Minimal attack surface**: no `sshd`, no interactive shell, no `gdb`/`strace`/`ptrace` (`kernel.yama.ptrace_scope=3`), serial console disabled or restricted to aggregate counters, guest firewall (`nftables`) permitting outbound connections **only** to the private mTLS double-spend registry (plus replies on inbound connections).

CI outputs `release-measurements.json`:

- `gitCommit`, tag, and `imageSha256`;
- `direct` profile: `sevSnpMeasurement` (computed offline via `sev-snp-measure` for the exact vCPU topology) and/or `tdxMrtd` + `tdxRtmr0..3`;
- `azure-vtpm` profile: PCR values (SHA-256; kernel, command line, initrd carrying the `dm-verity` root hash) and the allowed Microsoft paravisor measurements (`sev-snp-measure` does not apply);
- `minCpuTcb`, `minGpuDriverVersion`, `gpuRimHashes`;
- `models`: `{ artifactId, version, sha256 }` matching `packages/engines/src/models/catalog.ts`.

---

## 3. Transparency (Rekor) AND quorum authorization

> **Core rule:** recording a measurement in Sigstore Rekor makes it **publicly observable**, but **does not authorize execution** (compromised CI could publish a backdoored image to Rekor). The Sondine app requires **both**: a valid Rekor proof **and** a quorum-signed trust policy.

1. **Publish to Sigstore Rekor (public auditability)**:
   ```bash
   cosign sign-blob \
     --bundle release-measurements.sigstore.json \
     release-measurements.json
   ```
   Publish the Git commit, exact rebuild instructions, and Rekor log entry (with independent witness-signed checkpoint) in public release notes.
2. **Audit window (regular updates)**: wait 24 h between Rekor publication and adding the measurement to the production policy so independent auditors can rebuild and verify it.
3. **Out-of-CI quorum signing of `CloudTrustPolicy` (authorization)**:
   - At least **2 of 3 independent maintainers** (separate hardware keys, outside automated CI) verify the measurement and cosign `CloudTrustPolicy`:
     - `policyVersion`: strictly monotonic integer (anti-rollback enforced by every Mac);
     - `issuedAtMs` / `expiresAtMs`: short TTL (**24 h** max, refreshed by quorum or a scoped operational refresh key that can _never_ add new measurements — only re-timestamp the same quorum-approved set or revoke an existing one);
     - `allowedMeasurements`, `revokedMeasurements`, `minCpuTcb`, `minGpuTcb`, `allowedPlatforms`, allowed paravisors, the OHTTP key configuration, and active Privacy Pass issuer public keys by epoch;
     - the signed policy is itself **recorded in Rekor**, then published as a static file on the relay, one per epoch (2 h overlap at most).
4. **Emergency rule (critical 0-day)**: quorum can immediately bump `policyVersion`, add the affected measurement to `revokedMeasurements`, publish the patched image to Rekor, and authorize it without waiting 24 h.

---

## 4. Deploying a TEE node

1. **Recommended EU provisioning**:
   - **Azure `Standard_NCC40ads_H100_v5`** (AMD SEV-SNP + 1× H100 NVL 94 GB, `westeurope`, available on-demand and 1–3 yr reserved), immutable OS disk, no persistent data disks, GPU `cc_mode=ON`. Attestation profile `azure-vtpm`, **to be validated by a real trial before any reservation**.
   - **Physical security:** require the host's commitments on access to the machines. TEE.fail shows that physical access is enough to read sessions (threat model §4.2).
   - _(GCP note: confidential `a3-highgpu-1g` in `europe-west4` currently provisions as Spot/Flex-start — do not rely on it for permanent interactive capacity without contractual non-preemptible guarantees.)_
2. **Boot sequence (`sondine-compute --mode=tee`)**:
   - Verifies `/dev/sev-guest` or `/dev/tdx_guest` (`direct` profile), or the vTPM (`azure-vtpm` profile), and NVIDIA CC (`nvidia-smi conf-compute -f` → `ON`, active SPDM session). Failure → `exit 1`.
   - Verifies Nemotron's SHA-256 digest and loads it into the isolated GPU worker process.
   - Front-end generates an ephemeral **HPKE X25519** keypair in protected RAM (rotated every **≤ 6 h**, never hits disk) and fetches stapled dated OCSP/CRL/TCB proofs (refreshed every ≤ 12 h, valid ≤ 24 h).
   - Loads the Privacy Pass Issuer RSA public key (RFC 9578 `0x0002`).
3. **Frequent recycling**: every TEE node is terminated and recreated automatically every **6–24 h** (or on key rotation), bounding any RCE window and wiping all RAM/HBM.

---

## 5. Verifying attestation (operators and external auditors)

```bash
sondine-compute verify-attestation \
  --relay https://ohttp-relay.example.net/sondine \
  --gateway https://cloud.sondine.app \
  --trust-roots embedded
```

Local checks (identical to the macOS app):

1. **Signed policy**: 2-of-3 quorum signature, not expired (`expiresAtMs`), and no rollback (`policyVersion >= lastSeen`).
2. **Freshness**: the client's 32-byte nonce appears in the CPU evidence (`report_data` in the `direct` profile, vTPM quote and `user-data` in the `azure-vtpm` profile) and in the GPU evidence.
3. **Hardware chains & dated revocation**: AMD ARK/ASK/VCEK (or Intel Root CA/PCK) and NVIDIA RIM/OCSP verified, `debug_enabled == false`, `cc_mode == ON`, valid SPDM binding, stapled OCSP/CRL/TCB proofs not expired (≤ 24 h), and TCB ≥ policy minimum.
4. **HPKE key binding**: `binding = SHA-512(nonce || enclavePublicKey || sha256(gpuEvidence))`. `direct` profile: `report_data == binding`. `azure-vtpm` profile: `report_data` is the hash of the runtime claims, `user-data == binding`, the paravisor measurement is allowed, and the vTPM quote (signed by `HCLAkPub`) carries the nonce and our image's PCRs. In both, the platform must be in `allowedPlatforms` if the policy lists any.
5. **Dual software lock**: measurement is in `CloudTrustPolicy.allowedMeasurements` (not in `revokedMeasurements`) **AND** has a valid Rekor inclusion proof with witness checkpoint.

---

## 6. Privacy Pass operations, observability, and incident response

- **Allowed metrics** (aggregated only): requests/min, p50/p95 latency, GPU/VRAM utilization, error counts by code (`4xx`/`5xx`), expired sessions, double-spend registry health.
- **Strictly forbidden**: audio/transcript content, individually correlatable durations, client IP addresses, plaintext token identifiers in logs.
- **Privacy Pass key rotation**: one RSA keypair per monthly epoch (7-day overlap window at month boundary).
- **Incident response & real revocation bound**:
  1. Quorum immediately publishes a new `CloudTrustPolicy` revoking the affected measurement: online Macs reject old nodes on next policy refresh (and no later than the **24 h** cached policy TTL).
  2. Old TEE instances are terminated immediately on infrastructure (cutting access in seconds regardless of client cache).
  3. Patched image is published to Rekor, quorum-approved, and rolled out.
  4. A public post-mortem is published in the repository.
