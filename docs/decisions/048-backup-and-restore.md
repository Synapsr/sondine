# 048 — A whole backup in one file, and its restore

Status: Accepted — 2026-11-27 (Téo: « pouvoir exporter et importer… si je
l'installe plus tard, juste importer, pour tout récupérer d'un coup »; the
design agreed in thread; « la phrase de passe est facultative », with the
choice explicit). Amends ADR 013 (the export it promised may go without
encryption, by the user's choice). Builds on ADR 006, ADR 008, ADR 015,
ADR 016, ADR 017, ADR 040, ADR 042.

## Context

Deleting Sondine deletes the group container (ADR 013), which Time Machine
and cloud backup skip on purpose. Nothing let the user take everything with
them: the M2 exports are one episode's audio or text. A reinstall, or a new
Mac, started from nothing, and with the Cloud (ADR 040, 0.11.0) a Mac
without an account loses its seat with its token.

## Decision

### What a backup holds

| Data                                                                                                                                                                                    | Where                                          | In the backup                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The database (episodes, transcripts, assertions, voices and their embeddings, people, journal, tags, context, commitments, vocabulary, discussions, agents' key hashes, jobs, settings) | `sondine.db`                                   | Yes, as a copy taken with SQLite's online backup while the app runs                                                                           |
| Archived speech audio                                                                                                                                                                   | `archive/`                                     | Yes, unless « Inclure l'audio » is off; only the bytes of the chunks the copy holds as `archived`, every other byte of a file written as zero |
| Audio still in the spool, not archived yet (the last minutes)                                                                                                                           | `spool/`                                       | No: its chunks leave as `expired`, with their text                                                                                            |
| The spool's manifests (envelopes, 800 MB on Téo's Mac)                                                                                                                                  | `spool/`                                       | No: a restored run without manifests closes as `helper_exit` (architecture §3)                                                                |
| Context files and their previews (ADR 024)                                                                                                                                              | `context/`                                     | Yes, those the copy points to                                                                                                                 |
| The Mac's identity for its phones (ADR 008) and the phones' credential hashes                                                                                                           | `lan/`, `phone_devices`                        | Yes                                                                                                                                           |
| Compute servers and the Cloud seat's token (ADR 040)                                                                                                                                    | `settings.compute`                             | Yes                                                                                                                                           |
| The window's language, appearance and shortcuts                                                                                                                                         | its `localStorage`                             | Yes, as `renderer.json` (three named keys)                                                                                                    |
| Models                                                                                                                                                                                  | `~/Library/Application Support/Sondine/models` | No: the restore lists the ones the backed-up Mac had, each downloaded on a click                                                              |
| Diagnostics, sockets, inboxes, staging, updates, the extension's copy                                                                                                                   | the container                                  | No                                                                                                                                            |
| macOS permissions, login item, agents' own configuration                                                                                                                                | the system                                     | Cannot be: asked again                                                                                                                        |
| Undo history (ADR 017)                                                                                                                                                                  | memory                                         | No, as at every restart                                                                                                                       |

Settings that describe a moment of this Mac never travel:
`capture.pause-deadline`, `capture.pause-reminded`, `capture.call-listen`,
`updates.installing`, `updates.updated`, `sondine.dev.small-mac`,
`backup.restored`.

### The file

`.sondine`: a magic, a clear header (format, protection), then frames of
at most 1 MiB, each with its length and a « last » flag. The frames carry a
tar stream: `summary.json` first (what the restore screen shows), the files,
then `manifest.json` with each file's size and SHA-256. The last frame holds
the SHA-256 of the clear header and the whole stream. Core writes it next to
the destination (`.partial`) and renames it once complete; audio never
crosses oRPC or JSON.

### Protection

- By default a passphrase of at least 12 characters (« Générer » gives 24
  random characters, about 120 bits). scrypt (N = 2^17, r = 8, p = 1) gives
  the key; each frame is AES-256-GCM, its nonce a random prefix and its
  index, the clear header and the « last » flag authenticated. An HMAC of a
  fixed label under the key tells a wrong passphrase from damage. A lost
  passphrase is a lost backup: there is no key of rescue.
- « Sans phrase de passe » is the user's explicit choice, under a line that
  says everything that was said, the voices and the Cloud token will be
  readable by whoever finds the file. The mode is in the clear header;
  integrity holds the same (the stream's digest, each file's SHA-256), and
  its summary and restore ask nothing. This partly contradicts ADR 013's
  « encrypted local export »: the default stays encrypted, and the other way
  is the user's decision, made knowingly.
- The protection lives in one module (`backup-crypto.ts`): changing it
  changes nothing else.

### Consistency while the app runs

- The export holds retention (`Retention.hold`): no pass, scrub, expiry or
  import moves an archive file meanwhile. Capture does not wait.
- A deletion while it runs (`Status.deletions` changes) throws the backup
  away (`stale`): a deletion always wins (ADR 006).
- No VACUUM of the copy: it held core's thread about 3 s for a 165 MB
  database. `secure_delete` is on, so free pages hold nothing deleted.

### Restore

- Only a replacement, never a merge: ids are rowids (ADR 017), assertions
  are anchored to runs.
- Core opens the backup, checks its migrations against this build's (a
  migration this build lacks, or a changed one, refuses it as newer: update
  Sondine first; an older one migrates at launch), and the room on the data
  volume (its files + 10 %). It unpacks into `restore-staging/`, refusing
  any name outside a fixed list, checks each file against the manifest and
  the stream against its digest, then the staged database's own
  migrations, prepares it (listening paused, the restore's note), and
  writes `restore-staging/READY.json` last.
- Main relaunches Sondine. At launch, before the helper or core start, it
  moves the current data aside, in `before-restore/<stamp>/`, and the
  staging in: renames on one volume, so nothing is copied, and the marker
  says which half a crash interrupted. A staging without a marker is
  removed.
- The data set aside stays until the user deletes it (Settings ▸ Données).
- After the restore, a note: listening is paused until « Reprendre
  l'écoute »; macOS may ask its permissions again; models to download again;
  if the old Mac still runs, its iPhones should be revoked on one of the two
  (both answer with the same identity). Phones reconnect without pairing
  again. A seat restored on a second Mac of the same person shares its
  quota.

### The app

- Settings ▸ « Données »: the sizes, « Exporter une sauvegarde… »,
  « Restaurer une sauvegarde… », the data from before a restore. The first
  run offers « Restaurer une sauvegarde… » under its first step.
- `backup.*` procedures, all `mcp: null`: an agent never exports the memory
  or replaces it; no phone reaches them. Their events are `never` in
  `USAGE_RULES`: counting them needs a new version of the question
  (ADR 042).
- No network: `docs/network.md` lists the backup among what is not a
  network use. A file saved in an iCloud Drive folder is sent by macOS, as
  the user chose; encrypted by default.

## Measured (2026-11-27, Apple M5, internal SSD, invented data)

4.23 GB of invented archive audio over 220 spool files, beside a process
writing like the helper's spool (two tracks, a 64 KB block and its manifest
line, each `fsync`ed, every 2 s):

|                               | Time   | Core CPU | Spool commit p50 / p99 | Core's event loop p99 / max |
| ----------------------------- | ------ | -------- | ---------------------- | --------------------------- |
| Nothing (30 s)                | —      | —        | 9.1 / 20.3 ms          | 16.6 / 76 ms                |
| Export, with a passphrase     | 18.3 s | 20.2 s   | 12.5 / 34.9 ms         | 20.4 / 303 ms               |
| Export, without               | 13.4 s | 13.8 s   | 12.2 / 21.3 ms         | 17.8 / 173 ms               |
| Restore, unpacking and checks | 11.0 s | 13.7 s   | 8.2 / 38.9 ms          | 12.3 / 24 ms                |

A 165 MB database: its online copy 0.75 to 1.2 s (off core's thread), its
cleaning 3 ms. A real export of Téo's data (about 4.3 GB) should take about
20 s on the same kind of Mac, the backup weighing what its files do.

## Consequences

- The last minutes before an export keep their text but not their audio.
- An export uses about one core of core's process while it runs; capture's
  commits stay within their usual spread.
- A backup carries the Cloud token: a reinstalled Mac keeps its seat without
  an account.
