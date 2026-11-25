# @sondine/engines

Engine contracts (ADR 005, ADR 016), the model store, and the speech.cpp
worker client. Core owns scheduling, supervision and the model jobs.
Engines never download: only the model store's downloader fetches, a
catalog artifact from its pinned URL, when the user starts it (ADR 002).

## Model store

```
~/Library/Application Support/Sondine/models/
  <artifactId>/<version>/
    model.gguf         the weights, read-only: a clone or copy of the user's file, or a download
    LICENSE.txt        the license text from the catalog
    NOTICE.txt         the notices the license asks us to keep
    manifest.json      written last: verified sha256, size, inode, mtime
    .download.partial  a download's bytes so far, kept for resume
    .download.json     its pinned URL, size, sha256, ETag, and bytes synced
```

- `src/models/catalog.ts` pins each artifact (URL, size, sha256, license text,
  its sha256 and upstream page, notices, known places a copy may sit).
- `importArtifact` checks the size, clones the file with `clonefile(2)`
  (`/bin/cp -c`: Node's `copyFile` cannot clone on macOS), hashes the clone,
  writes license, notices and manifest, and renames it into place. With
  `method: "clone"` (the default) the source must be on the models folder's
  volume; `clone-or-copy` (the app) copies otherwise, when the disk holds the
  file plus `DISK_HEADROOM_BYTES`.
- `downloadArtifact` fetches the pinned URL (redirects only within
  `DOWNLOAD_POLICY`), resumes a kept partial with `Range` and `If-Range`,
  checks the size, then hashes the complete file and installs it. The
  rules are in ADR 016 "Models". `downloadedBytes` and `discardDownload`
  read and delete a kept partial.
- `findArtifactFile` looks for a file of the artifact's size in the Hugging
  Face hub cache and the catalog's `knownLocations`: never a disk scan, never
  Downloads, Desktop or Documents (macOS would ask for access).
- `verifyArtifact(root, artifact, { rehash: "if-changed" })` at launch: a
  size, inode and mtime match is enough; anything else rehashes.
- `listInstalled(root)` reports every artifact with a manifest, cheaply.

Import a file you already have (`--copy` allows a copy when it is on
another volume):

```sh
node packages/engines/src/cli/import-model.ts nemotron-3.5-transcribe-30b-iq4nl /path/to/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-IQ4_NL.gguf
node packages/engines/src/cli/import-model.ts --list
```

## speech.cpp worker

`createSpeechWorkerEngine` implements `AsrEngine` over `speech worker`
(protocol 3): one process at a time, one request at a time, request ids
fenced, 10 s base64 chunks, deadlines (ready 180 s, request 120 s + 4 × audio,
cancel 10 s then SIGKILL, unload `unloadLatencyMs` + 10 s), the last 8 KiB of
stderr in errors, and output checked before it reaches the host
(`invalid_output`). `killStaleWorker` kills a pid an earlier core recorded,
only while it still runs our worker.

Where the executable comes from (main passes `--speech-binary` to core):

- packaged: `Sondine.app/Contents/Helpers/Sondine Speech.app/Contents/MacOS/speech`,
  staged from the pinned release (`src/speech-cpp/runtime.ts`) and signed by
  `apps/desktop/scripts/build-mac.mjs`;
- development: `SONDINE_SPEECH_BINARY`, else the app staged by the last
  `pnpm build:mac` (`apps/desktop/build/stage/`), else none.

Core builds the reference engine from the artifact its model manager
verified at launch, or installed while it runs
(`apps/desktop/src/core/analysis/analysis-layer.ts`):

```ts
const installed = models.installed(NEMOTRON_ARTIFACT.artifactId);
if (installed !== null && config.speechBinary !== null) {
  const engine = createNemotronEngine({ speechBinary: config.speechBinary, artifact: installed });
}
```

## Tests

`pnpm --filter @sondine/engines test` runs the client against
`test/fake-speech-worker.ts`, and the downloader against a local HTTP server
on 127.0.0.1 with a few MiB of random bytes. The real engine test loads about 17 GB; run it
alone: `SONDINE_REAL_ENGINE=1 pnpm --filter @sondine/engines exec vitest run src/nemotron.real.test.ts`.
It writes load and compute times, peak RSS and the transcript to
`$TMPDIR/sondine-real-engine.json` (or `SONDINE_REAL_ENGINE_REPORT`).
