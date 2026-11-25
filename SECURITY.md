# Security

Sondine keeps a record of what people said around its user. A flaw that lets
another process, another device or a website read that record is the most
serious kind of bug this project can have.

## Report a vulnerability privately

Use GitHub's private reporting: the **Security** tab of this repository, then
**Report a vulnerability**. Do not open a public issue, discussion or pull
request for it.

Please include what an attacker can reach, the version and macOS version, and
the steps to reproduce. Never attach real recordings or transcripts; describe
them or use invented data.

We aim to answer within a week. Once a fix is released, the advisory is
published with credit to you, unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. Releases are listed on
[sondine-releases](https://github.com/teo-goulois/sondine-releases/releases).

## Scope

In scope: the desktop app and its helpers, the browser extension, the local
MCP server, the iPhone app and its sync with the Mac, the updates, the
compute server (`apps/compute`) and the sealed channel to it, the beta at
`cloud.sondine.app`, the statistics endpoint `stats.sondine.app`, and the site
`sondine.app`.

Out of scope: a Mac or iPhone already compromised by an administrator-level
attacker, models the user chose to download, and the user's own agent CLI
once they turned it on.

Known limits, not vulnerabilities: whoever administers a compute server (the
user's, or the beta's at Synapsr) can read the audio and the text it works on,
and an agent the user connects may forward what it reads to its provider.
[docs/network.md](docs/network.md) lists what leaves and who can see it.
Please test against a compute server of your own, never the beta's other
users.
