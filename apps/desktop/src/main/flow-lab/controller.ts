import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { AppClient } from "@sondine/api";
import { openDatabase, type Database } from "@sondine/db";
import { ARTIFACT_LAYOUT, MODEL_CATALOG, modelsDirectory } from "@sondine/engines";
import {
  DEFAULT_SITUATION,
  FIRST_POSITION,
  findStep,
  LabPosition,
  nextPosition,
  situationOf,
  type FakeCloudScenario,
  type LabAction,
  type LabCommand,
  type LabCoreSettings,
  type LabSituation,
  type LabStep,
  type LabView,
} from "../../shared/flow-lab";
import { log } from "../log";
import { seedInvented } from "./invented-data";

// Development only (ADR 049): puts a step's starting state back. Core and the
// helper stop, the data folder is emptied (the window's profile stays), the
// step's data is seeded, the fake Cloud and the situation are set, both
// start again, the step's actions run through core as the user's would, and
// the window opens the step's page.

/** What scripts/dev-lab.mjs prepared, in the lab's folder. */
export interface LabPaths {
  readonly root: string;
  readonly data: string;
  readonly home: string;
  /** The fake helper's permissions (test/fake-helper/cli.ts). */
  readonly permissions: string;
  /** The fake Cloud's scenarios, through dev-lab.mjs. */
  readonly cloudControl: string;
  /** The fake `claude`. */
  readonly claude: string;
  readonly position: string;
}

export function labPaths(root: string): LabPaths {
  return {
    root,
    data: join(root, "data"),
    home: join(root, "home"),
    permissions: join(root, "permissions"),
    cloudControl: join(root, "cloud.sock"),
    claude: join(root, "bin", "claude"),
    position: join(root, "position.json"),
  };
}

export interface FlowLabDeps {
  readonly paths: LabPaths;
  readonly migrationsDir: string;
  /** The lab's fake Cloud, as dev-lab.mjs started it. */
  readonly cloud: { readonly endpoint: string; readonly key: string } | null;
  /** Stops the helper and core and waits for both. */
  readonly stop: () => Promise<void>;
  readonly start: () => void;
  readonly client: () => AppClient | null;
  /** Opens the window on a page, as a fresh load. */
  readonly load: (path: string, localStorage: Readonly<Record<string, string | null>>) => void;
  readonly resize: (width: number, height: number) => void;
  readonly publish: (view: LabView) => void;
}

export interface FlowLab {
  view(): LabView;
  run(command: LabCommand): Promise<LabView>;
  /** Puts back the step saved last, at the lab's launch. */
  resume(): Promise<LabView>;
}

/** Kept when the data folder is emptied: Chromium's profile (the HUD's choices, the language, the theme). */
const KEPT = new Set(["electron"]);

export function createFlowLab(deps: FlowLabDeps): FlowLab {
  let position = readPosition(deps.paths.position);
  let busy = false;
  let problem: string | null = null;
  let generation = 0;
  let loadedAtMs = 0;

  const view = (): LabView => {
    const found = findStep(position.journey, position.step);
    return {
      position,
      situation: found === null ? DEFAULT_SITUATION : situationOf(found.step, position.situation),
      busy,
      problem,
      last: found !== null && found.index === found.journey.steps.length - 1,
      generation,
      loadedAtMs,
    };
  };
  const publish = () => deps.publish(view());

  async function apply(next: LabPosition): Promise<void> {
    const found = findStep(next.journey, next.step);
    if (found === null) return;
    position = next;
    busy = true;
    problem = null;
    publish();
    const situation = situationOf(found.step, next.situation);
    try {
      await deps.stop();
      prepare(found.step, situation);
      if (situation.model === "present") await installModel();
      deps.start();
      const client = await readyClient(deps.client);
      await cloud(deps.paths.cloudControl, [
        "reset",
        situation.wave === "full" ? "wave-full" : "wave-70",
      ]);
      for (const action of found.step.actions ?? []) await act(action, client);
      writeFileSync(deps.paths.position, `${JSON.stringify(position)}\n`);
      generation += 1;
      loadedAtMs = Date.now();
      deps.load(found.step.path, {
        "sondine.dev.small-mac": situation.mac === "small" ? "1" : null,
      });
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      log.warn("flow-lab.apply-failed", { step: `${next.journey}/${next.step}`, problem });
    } finally {
      busy = false;
      publish();
    }
  }

  /** The data folder, the models and the situation, while nothing runs. */
  function prepare(step: LabStep, situation: LabSituation): void {
    const { paths } = deps;
    mkdirSync(paths.data, { recursive: true });
    for (const entry of readdirSync(paths.data)) {
      if (!KEPT.has(entry)) rmSync(join(paths.data, entry), { recursive: true, force: true });
    }
    rmSync(modelsDirectory(paths.home), { recursive: true, force: true });
    writeFileSync(paths.permissions, situation.permissions);
    process.env["SONDINE_FLOW_LAB"] = JSON.stringify(coreSettings(deps, situation));

    const seeds = (step.actions ?? []).filter(isSeed);
    if (step.data === "empty" && seeds.length === 0) return;
    const db = openDatabase(join(paths.data, "sondine.db"), {
      migrationsFolder: deps.migrationsDir,
    });
    try {
      const now = Date.now();
      if (step.data === "invented") seedInvented(db, { now });
      for (const action of seeds) seed(db, action, now);
    } finally {
      db.close();
    }
  }

  async function act(action: LabAction, client: AppClient): Promise<void> {
    switch (action.type) {
      case "cloud-trial": {
        const joined = await client.compute.joinBeta({});
        if (joined.outcome !== "joined") throw new Error(`Cloud : ${joined.outcome}`);
        await client.compute.choose({ destination: "beta" });
        return;
      }
      case "cloud":
        return cloud(deps.paths.cloudControl, [action.scenario]);
      case "cloud-checkout":
        await client.compute.openBilling({ page: "subscription", locale: "fr" });
        return;
      case "chat":
        await client.chat.setEnabled({ enabled: action.enabled });
        return;
      case "check-updates":
        await client.updates.check();
        return;
      case "first-run":
      case "first-run-done":
      case "setting":
      case "phone-paired":
        return;
    }
  }

  // The model the first run asks for, as installed: an empty file of its size
  // (APFS keeps it sparse) and its manifest, which the launch check trusts
  // while the file's size, inode and mtime match.
  async function installModel(): Promise<void> {
    for (const artifact of MODEL_CATALOG.filter((candidate) => candidate.role === "final")) {
      const dir = join(modelsDirectory(deps.paths.home), artifact.artifactId, artifact.version);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, artifact.fileName);
      const handle = await open(file, "w");
      await handle.truncate(artifact.sizeBytes);
      await handle.close();
      const stats = await stat(file, { bigint: true });
      await writeFile(join(dir, ARTIFACT_LAYOUT.license), artifact.license.text);
      await writeFile(join(dir, ARTIFACT_LAYOUT.notices), artifact.notices);
      const atMs = Date.now();
      await writeFile(
        join(dir, ARTIFACT_LAYOUT.manifest),
        `${JSON.stringify(
          {
            format: "sondine-model-artifact",
            formatVersion: 1,
            artifactId: artifact.artifactId,
            version: artifact.version,
            fileName: artifact.fileName,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            licenseId: artifact.license.id,
            url: artifact.url,
            importedAtMs: atMs,
            verifiedAtMs: atMs,
            file: {
              sizeBytes: Number(stats.size),
              ino: stats.ino.toString(),
              mtimeNs: stats.mtimeNs.toString(),
            },
          },
          null,
          2,
        )}\n`,
      );
    }
  }

  let queue = Promise.resolve();
  const serial = (work: () => Promise<void>) => {
    const done = queue.then(work);
    queue = done.catch(() => undefined);
    return done;
  };

  return {
    view,
    run: (command) =>
      serial(async () => {
        if (command.type === "size") {
          deps.resize(command.width, command.height);
          return;
        }
        const next = nextPosition(position, command);
        if (next !== null) await apply(next);
      }).then(view),
    resume: () => serial(() => apply(position)).then(view),
  };
}

const isSeed = (
  action: LabAction,
): action is Extract<
  LabAction,
  { type: "first-run" | "first-run-done" | "setting" | "phone-paired" }
> =>
  action.type === "first-run" ||
  action.type === "first-run-done" ||
  action.type === "setting" ||
  action.type === "phone-paired";

function setting(db: Database, key: string, value: unknown, now: number): void {
  if (value === null) {
    db.statement("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(key, JSON.stringify(value), now);
}

function seed(
  db: Database,
  action: Extract<LabAction, { type: "first-run" | "first-run-done" | "setting" | "phone-paired" }>,
  now: number,
): void {
  switch (action.type) {
    case "first-run":
      // As core keeps a fresh install (core/onboarding.ts): paused until the first run's end.
      setting(db, "onboarding", onboardingRow(action.step, now, null), now);
      setting(db, "capture.paused", { microphone: true, systemAudio: true }, now);
      return;
    case "first-run-done":
      setting(db, "onboarding", onboardingRow("start", now - 60_000, now), now);
      return;
    case "setting":
      setting(db, action.key, action.value, now);
      return;
    case "phone-paired":
      db.statement(
        `INSERT INTO phone_devices (device_id, name, credential_hash, paired_at_ms, last_contact_at_ms, uploads)
         VALUES ('ux-iphone', 'iPhone d’Alex', ?, ?, ?, 1)
         ON CONFLICT (device_id) DO NOTHING`,
      ).run(randomBytes(32), now - 3 * 86_400_000, now - 3_600_000);
      setting(db, "phone.enabled", true, now);
      return;
  }
}

function onboardingRow(step: string, startedAtMs: number, completedAtMs: number | null) {
  return { origin: "first-run", step, startedAtMs, completedAtMs, goal: null, cloudNotify: false };
}

function coreSettings(deps: FlowLabDeps, situation: LabSituation): LabCoreSettings {
  return {
    cloud: deps.cloud,
    offline: situation.network === "offline",
    update: "0.12.1",
    agent: {
      executable: situation.agent === "missing" ? null : deps.paths.claude,
      mode: situation.agent === "signed-out" ? "signed-out" : "normal",
    },
  };
}

function readPosition(path: string): LabPosition {
  if (!existsSync(path)) return FIRST_POSITION;
  try {
    const parsed = LabPosition.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success && findStep(parsed.data.journey, parsed.data.step) !== null
      ? parsed.data
      : FIRST_POSITION;
  } catch {
    return FIRST_POSITION;
  }
}

async function readyClient(client: () => AppClient | null): Promise<AppClient> {
  for (let waited = 0; waited < 30_000; waited += 100) {
    const ready = client();
    if (ready !== null) return ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("core ne démarre pas");
}

/** Scenarios for the fake Cloud, one a line, each answered `ok <scenario>`. */
function cloud(
  socket: string,
  scenarios: readonly FakeCloudScenario[] | readonly string[],
): Promise<void> {
  if (scenarios.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let buffer = "";
    let waiting = [...scenarios];
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("le faux Cloud ne répond pas"));
    }, 10_000);
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line !== `ok ${waiting[0]}`) {
          clearTimeout(timer);
          connection.destroy();
          reject(new Error(`faux Cloud : ${line}`));
          return;
        }
        waiting = waiting.slice(1);
        if (waiting.length === 0) {
          clearTimeout(timer);
          connection.end();
          resolve();
        }
      }
    });
    connection.write(scenarios.map((scenario) => `${scenario}\n`).join(""));
  });
}
