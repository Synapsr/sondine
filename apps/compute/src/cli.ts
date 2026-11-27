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
import { formatServerLink, parseEndpoint, QuotaPlan } from "@sondine/engines/remote";
import { BillingService } from "./billing.ts";
import { ClientStore, planOf, SERVING_BEAT_MS, TOPUP_SECONDS } from "./clients.ts";
import { createComputeServer } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { createStripeHttp } from "./stripe.ts";

export const USAGE = `sondine-compute: transcribes for Macs that cannot run Sondine's model.

  sondine-compute serve                     runs the server
  sondine-compute add LABEL --endpoint URL [--plan own|trial|cloud] [--hours N | --minutes N]
                                            adds a Mac (use an opaque ID for invited Cloud plans)
  sondine-compute set-plan ID PLAN [--hours N | --minutes N]
                                            changes a Mac's plan (own, cloud) keeping its link
  sondine-compute topup ID [--hours N | --minutes N]
                                            adds persistent top-up hours to a Cloud plan (default 10 h)
  sondine-compute list                      the Macs, their plan, and the hours used
  sondine-compute remove ID                 removes one; its link stops working at once
  sondine-compute rekey ID --endpoint URL   a new link for the same place (a lost Mac); the old one stops
  sondine-compute places [N]                the Cloud wave's places, and how many are taken; N sets them (0 closes)
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
  SONDINE_COMPUTE_BETA_HOURS    hours of audio per open-beta place and month (default 40)
  SONDINE_COMPUTE_ADDRESS_HEADER  where a trusted tunnel puts the caller's address

Payment, for a server that sells its Cloud (ADR 047); all three, or none:
  SONDINE_COMPUTE_STRIPE_KEY             a restricted key: Checkout and portal sessions, prices and subscriptions
  SONDINE_COMPUTE_STRIPE_WEBHOOK_SECRET  the webhook's signing secret; Stripe calls PUBLIC_URL/v1/stripe
  SONDINE_COMPUTE_PUBLIC_URL             this server's public address, where Stripe sends the browser back
  SONDINE_COMPUTE_STRIPE_PORTAL          a customer portal configuration (bpc_…), optional
  SONDINE_COMPUTE_TERMS_URL              the dated terms Checkout links to, in English (default https://sondine.app/terms/2026-11-27)
  SONDINE_COMPUTE_TERMS_URL_FR           the same in French (default https://sondine.app/fr/terms/2026-11-27)
`;

export interface CliIo {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

class CliError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

function formatHours(seconds: number): string {
  return `${(seconds / 3_600).toFixed(1)} h`;
}

function parsePlan(raw: string | undefined, fallback: QuotaPlan): QuotaPlan {
  if (raw === undefined) return fallback;
  const parsed = QuotaPlan.safeParse(raw);
  if (!parsed.success || parsed.data === "beta" || parsed.data === "ended") {
    throw new CliError("plan must be one of: own, trial, cloud");
  }
  return parsed.data;
}

function parseLimitSeconds(
  hours: string | undefined,
  minutes: string | undefined,
): number | undefined {
  if (hours !== undefined && minutes !== undefined) {
    throw new CliError("use either --hours or --minutes, not both");
  }
  if (hours !== undefined) {
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0) {
      throw new CliError("--hours must be a positive number");
    }
    return value * 3_600;
  }
  if (minutes !== undefined) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) {
      throw new CliError("--minutes must be a positive number");
    }
    return value * 60;
  }
  return undefined;
}

function resolveId(clients: ClientStore, prefix: string | undefined): string {
  const found = clients
    .list()
    .filter(({ id }) => prefix !== undefined && prefix.length >= 6 && id.startsWith(prefix));
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) throw new CliError("no such Mac (see list)");
  return only.id;
}

/** The Cloud's payment, when the environment gives all it needs; else none. */
function billingFrom(
  env: Readonly<Record<string, string | undefined>>,
  clients: ClientStore,
  log: (event: string, fields?: Readonly<Record<string, string | number>>) => void,
): BillingService | null {
  const apiKey = env["SONDINE_COMPUTE_STRIPE_KEY"];
  const webhookSecret = env["SONDINE_COMPUTE_STRIPE_WEBHOOK_SECRET"];
  const publicUrl = parseEndpoint(env["SONDINE_COMPUTE_PUBLIC_URL"] ?? "");
  const given = [apiKey, webhookSecret, env["SONDINE_COMPUTE_PUBLIC_URL"]].filter(
    (value) => value !== undefined && value !== "",
  ).length;
  if (given === 0) return null;
  if (apiKey === undefined || webhookSecret === undefined || publicUrl === null) {
    throw new CliError(
      "payment needs SONDINE_COMPUTE_STRIPE_KEY, SONDINE_COMPUTE_STRIPE_WEBHOOK_SECRET and SONDINE_COMPUTE_PUBLIC_URL",
    );
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(publicUrl).hostname);
  if (!publicUrl.startsWith("https://") && !local) {
    throw new CliError("SONDINE_COMPUTE_PUBLIC_URL must be https");
  }
  const portal = env["SONDINE_COMPUTE_STRIPE_PORTAL"];
  return new BillingService(clients, {
    stripe: createStripeHttp({
      apiKey,
      ...(env["SONDINE_COMPUTE_STRIPE_API"] === undefined
        ? {}
        : { apiBase: env["SONDINE_COMPUTE_STRIPE_API"] }),
    }),
    webhookSecret,
    publicUrl,
    termsUrl: {
      // A fixed version: what a buyer accepts never changes under them.
      en: env["SONDINE_COMPUTE_TERMS_URL"] ?? "https://sondine.app/terms/2026-11-27",
      fr: env["SONDINE_COMPUTE_TERMS_URL_FR"] ?? "https://sondine.app/fr/terms/2026-11-27",
    },
    ...(portal === undefined || portal === "" ? {} : { portalConfiguration: portal }),
    log,
  });
}

export async function runCli(args: readonly string[], io: CliIo = {}): Promise<number> {
  const envMap = io.env ?? process.env;
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  const env = (name: string, fallback: string) => envMap[`SONDINE_COMPUTE_${name}`] ?? fallback;
  const log = (event: string, fields: Readonly<Record<string, string | number>> = {}) =>
    out(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
  const positive = (name: string, fallback: string): number => {
    const value = Number(env(name, fallback));
    if (!Number.isFinite(value) || value < 0) {
      throw new CliError(`SONDINE_COMPUTE_${name} is not a number`);
    }
    return value;
  };

  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        endpoint: { type: "string" },
        plan: { type: "string" },
        hours: { type: "string" },
        minutes: { type: "string" },
        help: { type: "boolean" },
      },
    });
    const [command, argument, secondArgument] = positionals;
    if (command === undefined || values.help === true) {
      out(USAGE);
      return command === undefined ? 1 : 0;
    }
    process.umask(0o077);
    const clients = new ClientStore(env("STATE", "state"));
    switch (command) {
      case "serve": {
        // Settings first: a server that should take payments never starts without.
        const billing = billingFrom(envMap, clients, log);
        const weights = env("MODEL", join("model", "model.gguf"));
        const executable = env("SPEECH", "./speech");
        if (!existsSync(weights)) throw new CliError(`no model at ${weights}`);
        try {
          accessSync(executable, constants.X_OK);
        } catch {
          throw new CliError(`no speech.cpp at ${executable}`);
        }
        log("verifying");
        if ((await sha256File(weights)) !== NEMOTRON_ARTIFACT.sha256) {
          throw new CliError("the model file is not the one Sondine uses");
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
        const places = positive("BETA_PLACES", "0");
        const betaSecondsPerMonth = places === 0 ? null : positive("BETA_HOURS", "40") * 3_600;
        const sessions = new Sessions({
          engine,
          limits: {
            unloadMs: idleUnloadSec === 0 ? Number.POSITIVE_INFINITY : idleUnloadSec * 1000,
          },
          log,
          known: (id) => clients.has(id),
          onTranscribed: (id, seconds) => clients.charge(id, seconds, betaSecondsPerMonth),
        });
        const header = envMap["SONDINE_COMPUTE_ADDRESS_HEADER"]?.toLowerCase();
        const server = createComputeServer({
          clients,
          sessions,
          billing,
          name: env("NAME", hostname()).slice(0, 64),
          beta:
            betaSecondsPerMonth === null ? null : { places, secondsPerMonth: betaSecondsPerMonth },
          log,
          ...(header === undefined ? {} : { addressHeader: header }),
        });
        const listen = /^(.*):(\d+)$/.exec(env("LISTEN", "127.0.0.1:8443"));
        if (listen?.[1] === undefined)
          throw new CliError("SONDINE_COMPUTE_LISTEN is not address:port");
        // `rekey` moves a place's files: it waits for no server to run on them.
        clients.beat();
        const beat = setInterval(() => clients.beat(), SERVING_BEAT_MS);
        beat.unref();
        server.listen(Number(listen[2]), listen[1], () =>
          log("listening", { places, wave: clients.wave().places, billing: billing ? 1 : 0 }),
        );
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          clearInterval(beat);
          clients.stopped();
          server.close();
          server.closeAllConnections();
          void sessions.stop().finally(() => process.exit(0));
        };
        process.on("SIGTERM", stop);
        process.on("SIGINT", stop);
        return 0;
      }
      case "add": {
        const endpoint = parseEndpoint(values.endpoint ?? "");
        if (argument === undefined || endpoint === null) {
          throw new CliError(
            "sondine-compute add LABEL --endpoint http://address:8443 [--plan own|trial|cloud]",
          );
        }
        const plan = parsePlan(values.plan, "own");
        const limitSeconds = parseLimitSeconds(values.hours, values.minutes);
        if (plan === "own" && limitSeconds !== undefined) {
          throw new CliError("--hours and --minutes do not apply to the unlimited own plan");
        }
        const kind = plan === "own" ? "own" : "beta";
        const { token } = clients.add(kind, argument.slice(0, 64), {
          plan,
          ...(limitSeconds === undefined ? {} : { limitSeconds }),
        });
        const serverKey = clients.key().publicKey.toString("base64url");
        out(formatServerLink({ endpoint, serverKey, token }));
        return 0;
      }
      case "set-plan": {
        const id = resolveId(clients, argument);
        if (secondArgument === undefined && values.plan === undefined) {
          throw new CliError("sondine-compute set-plan ID own|cloud [--hours N | --minutes N]");
        }
        const plan = parsePlan(secondArgument ?? values.plan, "cloud");
        const limitSeconds = parseLimitSeconds(values.hours, values.minutes);
        if (plan === "own" && limitSeconds !== undefined) {
          throw new CliError("--hours and --minutes do not apply to the unlimited own plan");
        }
        const result = clients.setPlan(
          id,
          plan,
          limitSeconds === undefined ? {} : { limitSeconds },
        );
        if (!result.ok) {
          throw new CliError(
            result.reason === "downgrade"
              ? "cannot downgrade a client to trial"
              : "no such Mac (see list)",
          );
        }
        const snapshot = clients.quota(id);
        const limit =
          snapshot?.limitSeconds === null || snapshot?.limitSeconds === undefined
            ? "unlimited"
            : formatHours(snapshot.limitSeconds);
        out(`${id.slice(0, 12)}  ${plan}  ${limit}`);
        return 0;
      }
      case "topup": {
        const id = resolveId(clients, argument);
        const extraSeconds = parseLimitSeconds(values.hours, values.minutes) ?? TOPUP_SECONDS;
        const result = clients.topUp(id, extraSeconds);
        if (!result.ok) {
          throw new CliError(
            result.reason === "unsupported-plan"
              ? "top-ups apply only to monthly plans (upgrade trial to cloud first)"
              : "could not add top-up hours",
          );
        }
        out(
          `${id.slice(0, 12)}  +${formatHours(extraSeconds)} top-up (${formatHours(result.remainingSeconds)} left)`,
        );
        return 0;
      }
      case "list": {
        const betaHours = positive("BETA_HOURS", "40") * 3_600;
        for (const { id, client } of clients.list()) {
          const billing = clients.billing(id);
          const plan = planOf(client, billing);
          const snapshot = clients.quota(id, betaHours);
          const used = ((snapshot?.usedSeconds ?? 0) / 3_600).toFixed(2);
          const limit =
            snapshot?.limitSeconds === null || snapshot?.limitSeconds === undefined
              ? `${used} h`
              : `${used}/${(snapshot.limitSeconds / 3_600).toFixed(1)} h`;
          const extra =
            snapshot !== null && snapshot.extraSeconds > 0
              ? ` (+${formatHours(snapshot.extraSeconds)})`
              : "";
          const status =
            billing?.subscription === undefined ? "" : `  ${billing.subscription.status}`;
          out(`${id.slice(0, 12)}  ${plan.padEnd(5)}  ${limit}${extra}  ${client.name}${status}`);
        }
        return 0;
      }
      case "remove": {
        clients.remove(resolveId(clients, argument));
        return 0;
      }
      case "rekey": {
        const endpoint = parseEndpoint(values.endpoint ?? "");
        if (endpoint === null) {
          throw new CliError("sondine-compute rekey ID --endpoint https://address");
        }
        if (clients.serving()) {
          throw new CliError(
            "stop the server first (docker compose stop compute): it writes the files rekey moves",
          );
        }
        const moved = clients.rekey(resolveId(clients, argument));
        if (moved === null) throw new CliError("no such Mac (see list)");
        const serverKey = clients.key().publicKey.toString("base64url");
        out(formatServerLink({ endpoint, serverKey, token: moved.token }));
        return 0;
      }
      case "places": {
        if (argument !== undefined) {
          const wanted = Number(argument);
          if (!Number.isInteger(wanted) || wanted < 0) {
            throw new CliError("places must be a whole number, 0 or more");
          }
          clients.setWavePlaces(wanted);
        }
        const { places: waveplaces, taken } = clients.wave();
        out(`${taken} taken of ${waveplaces} places`);
        return 0;
      }
      case "key":
        out(clients.key().publicKey.toString("base64url"));
        return 0;
      default:
        throw new CliError(USAGE);
    }
  } catch (error) {
    if (error instanceof CliError) {
      err(error.message);
      return error.code;
    }
    throw error;
  }
}
