# sondine-compute

Transcribes for Macs that cannot run Sondine's model (ADR 040): the same
weights as on a Mac, behind an HTTP server whose every message is sealed for
its own key (`packages/engines/src/remote`). On disk it keeps its key and, per
Mac, a hash of its token, the name you gave it, when it was added, when it was
last used and the seconds transcribed that month; never audio or text
([docs/network.md](../../docs/network.md)).

Whoever administers the machine, or any program with its rights (an agent
with Docker or `sudo` included), can read what it works on.

## Install (Linux x86-64, NVIDIA card with 8 GB or more, 32 GB of RAM)

Node 24, the NVIDIA driver and `libvulkan1`. Then, in an empty folder:

```bash
# speech.cpp 0.9.3, the release Sondine uses, checked
curl -fsSLO https://github.com/nyosegawa/speech.cpp/releases/download/v0.9.3/speech-0.9.3-linux-x64-vulkan.zip
curl -fsSL https://github.com/nyosegawa/speech.cpp/releases/download/v0.9.3/SHA256SUMS | grep linux-x64-vulkan | sha256sum -c -
unzip speech-0.9.3-linux-x64-vulkan.zip

# the model, 19 GB; the server checks its SHA-256 at each start
mkdir -p model && curl -fL -o model/model.gguf \
  https://huggingface.co/sakasegawa/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-GGUF/resolve/55d289085ed6b1acd1cfd2e6cf279fdeb32fee5f/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-IQ4_NL.gguf

# the server, from this repository: pnpm --filter @sondine/compute build
cp <repository>/apps/compute/dist/sondine-compute.js .
```

Run it, on an address your Macs reach (Tailscale's here):

```bash
SONDINE_COMPUTE_LISTEN=100.x.y.z:8443 node sondine-compute.js serve
```

`node sondine-compute.js` lists the settings. The card needs 3.7 GB free, and
each of the 23 layers of experts it keeps takes 0.72 GB more; the others run on
the CPU. The model leaves the card after three minutes without work.

## Add a Mac

```bash
node sondine-compute.js add "Marie's Mac" --endpoint http://100.x.y.z:8443
```

Paste the line it prints in Sondine: Réglages ▸ Transcription ▸ Votre machine.
It holds that Mac's token: send it as you would a password. `list` shows the
Macs, `remove` takes one's access away at once.

## As a service

`~/.config/systemd/user/sondine-compute.service`, then
`systemctl --user enable --now sondine-compute` (and
`loginctl enable-linger`, so it runs without a session):

```ini
[Service]
WorkingDirectory=%h/sondine-compute
Environment=SONDINE_COMPUTE_LISTEN=100.x.y.z:8443
ExecStart=/usr/bin/node sondine-compute.js serve
Restart=on-failure
RestartSec=10
UMask=0077
LimitCORE=1
MemorySwapMax=0
NoNewPrivileges=yes

[Install]
WantedBy=default.target
```

`LimitCORE=1` keeps a crash from being dumped, audio included: at 0, Ubuntu's
apport still writes the dump to `/var/crash`. `MemorySwapMax=0` keeps the service's memory, and the model's process, out of
swap, where it would outlive the request. Without that line, turn the
machine's swap off, or encrypt it with a key made at each start.

## The beta

`SONDINE_COMPUTE_BETA_PLACES=10` lets anyone take a place in one click, until
all are taken; when all are, a place unused for two weeks goes to the next person.
`SONDINE_COMPUTE_BETA_HOURS` bounds each one's month. Behind Cloudflare Tunnel,
`SONDINE_COMPUTE_ADDRESS_HEADER=cf-connecting-ip` lets the server slow down
claims by address. The app knows the beta by `CLOUD_BETA`
(`apps/desktop/src/shared/cloud.ts`): the tunnel's URL and the key
`sondine-compute key` prints. Taking places back to 0 closes it.
