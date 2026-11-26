import { accessSync, constants, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createSpeechWorkerEngine,
  NEMOTRON_ARTIFACT,
  NEMOTRON_CAPABILITIES,
  NEMOTRON_MANIFEST,
  NEMOTRON_RESOURCES,
  nemotronProgress,
  repairWordTimes,
  sha256File,
  SPEECH_CPP_RUNTIME,
} from "@sondine/engines";
import { formatServerLink, parseEndpoint } from "@sondine/engines/remote";
import { ClientStore } from "./clients.ts";
import { createComputeServer } from "./server.ts";
import { Sessions } from "./sessions.ts";

const USAGE = `sondine-compute: transcribes for Macs that cannot run Sondine's model.

  sondine-compute serve                     runs the server
  sondine-compute add NAME --endpoint URL   adds a Mac, and prints the link to paste in Sondine
  sondine-compute list                      the Macs, and the hours each used this month
  sondine-compute remove ID                 removes one; its link stops working at once
  sondine-compute key                       the server's public key

Environment:
  SONDINE_COMPUTE_STATE    the server's key and the Macs' hashes (default ./state)
  SONDINE_COMPUTE_MODEL    the model file, checked by its SHA-256 (default ./model/model.gguf)
  SONDINE_COMPUTE_SPEECH   speech.cpp ${SPEECH_CPP_RUNTIME.version}'s executable (default ./speech)
  SONDINE_COMPUTE_LISTEN   address:port (default 127.0.0.1:8443)
  SONDINE_COMPUTE_NAME     the name Sondine shows (default this machine's)
  SONDINE_COMPUTE_THREADS  the CPU's threads (default 8)
  SONDINE_COMPUTE_DEVICE   gpu, cpu or auto (default gpu)
  SONDINE_COMPUTE_IDLE_UNLOAD_SEC  seconds without work before the model leaves the card (default 180; 0: never)
  SONDINE_COMPUTE_BETA_PLACES   places anyone may take in one click (default 0: none)
  SONDINE_COMPUTE_BETA_HOURS    hours of audio per place and month (default 40)
  SONDINE_COMPUTE_ADDRESS_HEADER  where a trusted tunnel puts the caller's address
`;

const env = (name: string, fallback: string) => process.env[`SONDINE_COMPUTE_${name}`] ?? fallback;
const log = (event: string, fields: Readonly<Record<string, string | number>> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function positive(name: string, fallback: string): number {
  const value = Number(env(name, fallback));
  if (!Number.isFinite(value) || value < 0) fail(`SONDINE_COMPUTE_${name} is not a number`);
  return value;
}

async function serve(clients: ClientStore): Promise<void> {
  const weights = env("MODEL", join("model", "model.gguf"));
  const executable = env("SPEECH", "./speech");
  if (!existsSync(weights)) fail(`no model at ${weights}`);
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    fail(`no speech.cpp at ${executable}`);
  }
  log("verifying");
  if ((await sha256File(weights)) !== NEMOTRON_ARTIFACT.sha256) {
    fail("the model file is not the one Sondine uses");
  }
  const engine = createSpeechWorkerEngine({
    manifest: NEMOTRON_MANIFEST,
    capabilities: NEMOTRON_CAPABILITIES,
    resources: NEMOTRON_RESOURCES,
    executable,
    weights,
    modelSha256: NEMOTRON_ARTIFACT.sha256,
    runtimeVersion: SPEECH_CPP_RUNTIME.version,
    device: env("DEVICE", "gpu"),
    threads: positive("THREADS", "8"),
    progress: nemotronProgress(),
    wordTimes: repairWordTimes,
    onExit: ({ code, signal, expected }) => {
      if (!expected) log("worker-exited", { code: code ?? -1, signal: signal ?? "" });
    },
  });
  const idleUnloadSec = positive("IDLE_UNLOAD_SEC", "180");
  const sessions = new Sessions({
    engine,
    limits: { unloadMs: idleUnloadSec === 0 ? Number.POSITIVE_INFINITY : idleUnloadSec * 1000 },
    log,
    known: (id) => clients.has(id),
    onTranscribed: (id, seconds) => clients.charge(id, seconds),
  });
  const places = positive("BETA_PLACES", "0");
  const header = process.env["SONDINE_COMPUTE_ADDRESS_HEADER"]?.toLowerCase();
  const server = createComputeServer({
    clients,
    sessions,
    name: env("NAME", hostname()).slice(0, 64),
    beta: places === 0 ? null : { places, secondsPerMonth: positive("BETA_HOURS", "40") * 3600 },
    log,
    ...(header === undefined ? {} : { addressHeader: header }),
  });
  const listen = /^(.*):(\d+)$/.exec(env("LISTEN", "127.0.0.1:8443"));
  if (listen?.[1] === undefined) fail("SONDINE_COMPUTE_LISTEN is not address:port");
  server.listen(Number(listen[2]), listen[1], () => log("listening", { places }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    void sessions.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { endpoint: { type: "string" }, help: { type: "boolean" } },
});
const [command, argument] = positionals;
if (command === undefined || values.help === true) {
  console.log(USAGE);
  process.exit(command === undefined ? 1 : 0);
}
process.umask(0o077);
const clients = new ClientStore(env("STATE", "state"));
switch (command) {
  case "serve":
    await serve(clients);
    break;
  case "add": {
    const endpoint = parseEndpoint(values.endpoint ?? "");
    if (argument === undefined || endpoint === null) {
      fail("sondine-compute add NAME --endpoint http://address:8443");
    }
    const { token } = clients.add("own", argument.slice(0, 64));
    const serverKey = clients.key().publicKey.toString("base64url");
    console.log(formatServerLink({ endpoint, serverKey, token }));
    break;
  }
  case "list":
    for (const { id, client, usage } of clients.list()) {
      const hours = (usage.seconds / 3600).toFixed(1);
      console.log(`${id.slice(0, 12)}  ${client.kind}  ${hours} h  ${client.name}`);
    }
    break;
  case "remove": {
    const found = clients
      .list()
      .filter(
        ({ id }) => argument !== undefined && argument.length >= 6 && id.startsWith(argument),
      );
    const only = found.length === 1 ? found[0] : undefined;
    if (only === undefined) fail("no such Mac (see list)");
    clients.remove(only.id);
    break;
  }
  case "key":
    console.log(clients.key().publicKey.toString("base64url"));
    break;
  default:
    fail(USAGE);
}
