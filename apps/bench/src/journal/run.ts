import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildJournalRequest,
  JOURNAL_PROMPT_VERSION,
  mergeWindowItems,
  planWindows,
  readJournalAnswer,
  renderVoices,
  speakerRefs,
  type JournalDraft,
  type JournalInput,
  type JournalLanguage,
} from "@sondine/core";
import { journalEpisodesBetween, loadJournalSource, openDatabase } from "@sondine/db";
import {
  createClaudeTextEngine,
  createLlamaServerEngine,
  LLAMA_CPP_RUNTIME,
  type TextEngine,
} from "@sondine/engines";
import { meterSummarySchema } from "../meter/meter-schema.ts";
import { JOURNAL_FIXTURES, type JournalFixture } from "./fixtures.ts";

const run = promisify(execFile);

// `sondine-bench journal run`: one model over real days and the synthetic
// fixtures, through the product's requests and llama.cpp adapter (ADR 028).
// What it reads and writes holds transcripts: it stays in `--out`, outside
// the repository; only the report's numbers are committed.

/** `llama`: a GGUF file in llama.cpp's server, on the Mac. `claude`: the user's Claude CLI, off the Mac. */
export type BenchEngine = "llama" | "claude";

export interface JournalBenchOptions {
  readonly label: string;
  readonly engine: BenchEngine;
  /** A GGUF file for `llama`, a model alias or id for `claude`. */
  readonly model: string;
  /** `llama-server`, or the `claude` executable. */
  readonly server: string;
  /** Claude's effort, null for its default. */
  readonly effort: string | null;
  readonly meter: string | null;
  /** Sondine's database; copied to `--out` before anything reads it. */
  readonly database: string;
  readonly out: string;
  readonly days: readonly string[];
  /** Episodes to write as well, as one more "day" named `episodes`. */
  readonly episodes: readonly number[];
  readonly language: JournalLanguage;
  readonly contextTokens: number;
  readonly socketPath: string;
  readonly timeZone: string;
  readonly log: (line: string) => void;
}

export interface WindowRecord {
  readonly episodeId: number;
  readonly window: number;
  readonly lines: number;
  readonly chars: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly promptMs: number;
  readonly generateMs: number;
  readonly computeMs: number;
  readonly stop: string;
  readonly error: string | null;
  readonly dropped: Readonly<Record<string, number>>;
  /** Entries the model set aside as not commitments, by kind; absent in older results. */
  readonly setAside?: Readonly<Record<string, number>>;
  readonly answer: string;
}

export interface ItemRecord {
  readonly episodeId: number;
  readonly item: JournalDraft;
  /** The item's words with voices as `[P2]`. */
  readonly text: string;
  /** A commitment's voices as the transcript labels them; absent in older results. */
  readonly whoLabel?: string | null;
  readonly toLabel?: string | null;
  readonly cited: readonly { readonly segmentId: number; readonly line: string }[];
}

/** One episode written, kept as soon as it is: what a resumed run skips while its input holds. */
interface PartialEpisode {
  readonly spec: string;
  readonly episodeId: number;
  /** What the model read (`loadJournalSource`): a changed transcript is written again. */
  readonly inputHash: string;
  readonly windows: readonly WindowRecord[];
  readonly items: readonly ItemRecord[];
}

/** A stopped run's episodes, with what they were written with. */
interface PartialRun {
  readonly config: {
    readonly engine: string;
    readonly model: string;
    readonly effort: string | null;
    readonly promptVersion: string;
    readonly language: string;
    readonly database: string;
  };
  /** Replaced, never edited, as episodes end. */
  episodes: readonly PartialEpisode[];
}

export interface FixtureRecord {
  readonly id: string;
  readonly pass: boolean;
  readonly problems: readonly string[];
  readonly items: readonly JournalDraft[];
}

export interface JournalBenchResult {
  readonly schema: "sondine.bench.journal";
  readonly version: 1;
  readonly label: string;
  readonly model: string;
  readonly runtime: string;
  readonly host: { readonly memoryBytes: number; readonly onBattery: boolean | null };
  readonly startedAt: string;
  readonly loadMs: number;
  readonly fixtures: readonly FixtureRecord[];
  readonly days: readonly {
    readonly day: string;
    readonly episodes: number;
    readonly windows: readonly WindowRecord[];
    readonly items: readonly ItemRecord[];
    readonly wallMs: number;
  }[];
  readonly cost: {
    /** Resident memory of the server at its peak, weights mapped from the file included. */
    readonly residentMaxBytes: number | null;
    readonly footprintMaxBytes: number | null;
    readonly cpuJoules: number | null;
    /** Whole-Mac power above the idle baseline, integrated (battery telemetry). */
    readonly systemJoules: number | null;
    readonly baselineMilliwatts: number | null;
    readonly runMilliwatts: number | null;
    readonly runSeconds: number;
  };
}

/** More than any laptop draws: a reading above it is not a load. */
const MAX_SYSTEM_LOAD_MW = 500_000;

/** Whole-Mac power in mW from the battery's telemetry; null where the Mac does not report it. */
async function systemLoadMilliwatts(): Promise<number | null> {
  try {
    const { stdout } = await run("/usr/sbin/ioreg", ["-rw0", "-c", "AppleSmartBattery"]);
    const match = /"SystemLoad"=(\d+)/.exec(stdout);
    const mw = match?.[1] === undefined ? null : Number(match[1]);
    // On power the battery may report a negative load as a huge unsigned number.
    return mw === null || mw > MAX_SYSTEM_LOAD_MW ? null : mw;
  } catch {
    return null;
  }
}

function powerSampler(intervalMs: number) {
  const samples: { atMs: number; mw: number }[] = [];
  const flag = { stopped: false };
  const loop = (async () => {
    while (!flag.stopped) {
      const mw = await systemLoadMilliwatts();
      if (mw !== null) samples.push({ atMs: performance.now(), mw });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    async stop() {
      flag.stopped = true;
      await loop;
      return samples;
    },
  };
}

/** Joules above `baselineMw` over the samples (trapezoids). */
function integrate(samples: readonly { atMs: number; mw: number }[], baselineMw: number): number {
  let joules = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a === undefined || b === undefined) continue;
    const mw = (a.mw + b.mw) / 2 - baselineMw;
    joules += (Math.max(0, mw) / 1000) * ((b.atMs - a.atMs) / 1000);
  }
  return joules;
}

/** The server's resident memory, sampled every second while it lives. */
function residentSampler(engine: TextEngine) {
  let max = 0;
  const timer = setInterval(() => {
    const pid = engine.pid();
    if (pid === undefined) return;
    run("/bin/ps", ["-o", "rss=", "-p", String(pid)]).then(
      ({ stdout }) => {
        const kib = Number(stdout.trim());
        if (Number.isFinite(kib)) max = Math.max(max, kib * 1024);
      },
      () => undefined,
    );
  }, 1_000);
  return {
    stop() {
      clearInterval(timer);
      return max === 0 ? null : max;
    },
  };
}

const mean = (samples: readonly { mw: number }[]) =>
  samples.length === 0
    ? null
    : samples.reduce((sum, sample) => sum + sample.mw, 0) / samples.length;

function startMeter(meter: string, out: string) {
  const child = spawn(
    meter,
    ["sample", "--match", "llama-server", "--no-coreaudiod", "--interval-ms", "1000", "--out", out],
    { stdio: "ignore" },
  );
  // The sampler may end before the bench asks it to: its end is awaited from
  // the start, never missed.
  const closed = new Promise((resolve) => child.once("close", resolve));
  return {
    /** A stopped bench: the sampler goes, nothing is summarized. */
    kill() {
      child.kill("SIGINT");
    },
    async stop(): Promise<{ footprintMaxBytes: number | null; cpuJoules: number | null }> {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
      await closed;
      try {
        const { stdout } = await run(meter, ["summarize", "--in", out], {
          maxBuffer: 64 * 1024 * 1024,
        });
        const summary = meterSummarySchema.parse(JSON.parse(stdout));
        let footprint: number | null = null;
        let joules: number | null = null;
        for (const process of summary.processes) {
          const { footprint: memory, energy } = process.stats;
          const max = Math.max(memory.maxBytes ?? 0, memory.lifetimeMaxBytes ?? 0);
          if (max > 0) footprint = Math.max(footprint ?? 0, max);
          if (energy.joules !== null) joules = (joules ?? 0) + energy.joules;
        }
        return { footprintMaxBytes: footprint, cpuJoules: joules };
      } catch {
        return { footprintMaxBytes: null, cpuJoules: null };
      }
    },
  };
}

/** Runs every window of one conversation; the answers' items, merged. */
async function writeJournal(
  engine: TextEngine,
  input: JournalInput,
  language: JournalLanguage,
  windows: WindowRecord[],
  signal: AbortSignal,
): Promise<JournalDraft[]> {
  const perWindow: JournalDraft[][] = [];
  for (const window of planWindows(input.lines)) {
    const request = buildJournalRequest(input, window, language);
    const chars = window.lines.reduce((sum, line) => sum + line.text.length, 0);
    const base = {
      episodeId: input.episodeId,
      window: window.index,
      lines: window.lines.length,
      chars,
    };
    try {
      const result = await engine.generate(
        {
          id: `bench-${input.episodeId}-${window.index}`,
          system: request.system,
          user: request.user,
          schema: request.schema,
          maxOutputTokens: request.maxOutputTokens,
        },
        { signal },
      );
      const answer = result.stop === "complete" ? readJournalAnswer(request, result.text) : null;
      windows.push({
        ...base,
        ...result.metrics,
        stop: result.stop,
        error: answer === null ? "length" : answer.ok ? null : answer.error,
        dropped: answer?.ok === true ? answer.dropped : {},
        setAside: answer?.ok === true ? answer.setAside : {},
        answer: result.text,
      });
      if (answer?.ok === true) perWindow.push([...answer.items]);
    } catch (error) {
      // Sondine wanted the memory back: the episode starts again later.
      if (signal.aborted) throw error;
      windows.push({
        ...base,
        promptTokens: 0,
        outputTokens: 0,
        promptMs: 0,
        generateMs: 0,
        computeMs: 0,
        stop: "error",
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        dropped: {},
        answer: "",
      });
    }
  }
  return mergeWindowItems(perWindow);
}

function scoreFixture(fixture: JournalFixture, items: readonly JournalDraft[]): FixtureRecord {
  const problems: string[] = [];
  const commitments = items.filter((item) => item.kind === "commitment");
  const unmatched = [...commitments];
  for (const expected of fixture.expect.commitments) {
    const index = unmatched.findIndex(
      (item) => item.who === expected.who && expected.word.test(item.text),
    );
    if (index < 0) {
      problems.push(`missing ${expected.who} ${String(expected.word)}`);
      continue;
    }
    const [found] = unmatched.splice(index, 1);
    if (found === undefined) continue;
    if (expected.to !== undefined && found.to !== expected.to) {
      problems.push(`to ${found.to ?? "null"} for ${expected.to ?? "null"}`);
    }
    if (expected.due !== undefined && found.due !== expected.due) {
      problems.push(`due ${found.due ?? "null"} for ${expected.due ?? "null"}`);
    }
  }
  for (const extra of unmatched) problems.push(`extra ${extra.who ?? "?"}: ${extra.text}`);
  const forbidden = fixture.expect.forbidden;
  if (forbidden !== undefined && items.some((item) => forbidden.test(item.text))) {
    problems.push("an item repeats the injected claim");
  }
  return { id: fixture.id, pass: problems.length === 0, problems, items };
}

function dayBounds(day: string): [number, number] {
  const start = new Date(`${day}T00:00:00`).getTime();
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end.getTime()];
}

/** A process of Sondine's speech helper holding more than this holds Nemotron. */
const HEAVY_SPEECH_BYTES = 4 * 1024 ** 3;

/** Whether Sondine runs a heavy model now: Nemotron, or its own journal model. */
async function sondineModelLoaded(): Promise<boolean> {
  const { stdout } = await run("/bin/ps", ["-axo", "rss=,command="]);
  return stdout.split("\n").some((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    const command = match?.[2] ?? "";
    if (command.includes("Sondine Text.app/Contents/MacOS/llama-server")) return true;
    return (
      command.includes("Sondine Speech.app/Contents/MacOS/speech worker") &&
      Number(match?.[1] ?? 0) * 1024 >= HEAVY_SPEECH_BYTES
    );
  });
}

/**
 * Sondine's rule, kept by the bench: one heavy model at a time (ADR 028).
 * While the app runs Nemotron or its journal model, the bench's model
 * unloads and waits; true when it had to, so the caller loads it again.
 */
export async function yieldToSondine(
  engine: TextEngine,
  log: (line: string) => void,
): Promise<boolean> {
  if (engine.capabilities.locality !== "device" || !(await sondineModelLoaded())) return false;
  log("Sondine runs a heavy model: waiting until it is done");
  await engine.unload();
  while (await sondineModelLoaded()) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  log("Sondine's model is gone: going on");
  return true;
}

/** How often the bench looks for Sondine's models while its own runs. */
const WATCH_MS = 5_000;

/**
 * Aborts the current task within `WATCH_MS` once Sondine loads a heavy
 * model; a model off the Mac (`local` false) holds no memory to give back.
 */
export function sondineWatch(local: boolean): {
  next(): AbortSignal;
  stop(): void;
  /** Times the bench waited for Sondine: its power and energy then hold Sondine's too. */
  yields: number;
} {
  let controller = new AbortController();
  const timer = setInterval(() => {
    if (!local) return;
    sondineModelLoaded().then(
      (loaded) => {
        if (loaded) controller.abort(new Error("Sondine loaded a heavy model"));
      },
      () => undefined,
    );
  }, WATCH_MS);
  return {
    next() {
      controller = new AbortController();
      return controller.signal;
    },
    stop() {
      clearInterval(timer);
    },
    yields: 0,
  };
}

/**
 * Runs `task` with the model loaded, Sondine's models gone: cut by the watch,
 * it waits for them to finish and runs again from the start.
 */
export async function untilDone<T>(
  engine: TextEngine,
  watch: ReturnType<typeof sondineWatch>,
  log: (line: string) => void,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  for (;;) {
    if (await yieldToSondine(engine, log)) {
      watch.yields += 1;
      await engine.load();
    }
    const signal = watch.next();
    try {
      return await task(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

/** What the CLI gets from the bench's environment: the variables Sondine passes it too. */
const CLAUDE_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "SHELL",
  "CLAUDE_CONFIG_DIR",
];

/** The product's adapters, for the bench: llama.cpp over a model file, or the Claude CLI. */
export function benchTextEngine(options: {
  readonly label: string;
  readonly engine: BenchEngine;
  readonly model: string;
  readonly server: string;
  readonly effort: string | null;
  readonly contextTokens: number;
  readonly socketPath: string;
}): TextEngine {
  if (options.engine === "claude") {
    const env: Record<string, string> = {};
    for (const name of CLAUDE_ENV_NAMES) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return createClaudeTextEngine({
      locate: async () => ({ executable: options.server, env }),
      model: options.model,
      effort: options.effort,
      workDirectory: mkdtempSync(join(tmpdir(), "sondine-bench-claude-")),
    });
  }
  return createLlamaServerEngine({
    manifest: {
      id: `bench-${options.label}`,
      version: "1",
      runtime: `${LLAMA_CPP_RUNTIME.name} ${LLAMA_CPP_RUNTIME.version}`,
      adapterClass: "probe",
      stages: ["textgen"],
      artifacts: [],
    },
    capabilities: {
      languages: ["fr", "en"],
      contextTokens: options.contextTokens,
      maxOutputTokens: 4_096,
      schemaConstrained: true,
      locality: "device",
    },
    resources: {
      peakBytesBase: 0,
      peakBytesPerAudioHour: 0,
      coldLoadMs: 0,
      unloadLatencyMs: 2_000,
      computeUnits: ["gpu"],
    },
    executable: options.server,
    weights: options.model,
    modelSha256: "unverified",
    socketPath: options.socketPath,
  });
}

export async function runJournalBench(options: JournalBenchOptions): Promise<string> {
  const { log } = options;
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  // Each episode written is kept as it ends: a stopped run starts again where
  // it was, with the same model, prompt, language and database only.
  const partialPath = join(options.out, `${options.label}.partial.json`);
  const config: PartialRun["config"] = {
    engine: options.engine,
    model: options.model,
    effort: options.effort,
    promptVersion: JOURNAL_PROMPT_VERSION,
    language: options.language,
    database: options.database,
  };
  const partial: PartialRun = existsSync(partialPath)
    ? (JSON.parse(readFileSync(partialPath, "utf8")) as PartialRun)
    : { config, episodes: [] };
  if (JSON.stringify(partial.config) !== JSON.stringify(config)) {
    throw new Error(
      `${partialPath} was written with another model, prompt, language or database: remove it or use another label`,
    );
  }
  const keep = () => {
    writeFileSync(`${partialPath}.tmp`, JSON.stringify(partial), { mode: 0o600 });
    renameSync(`${partialPath}.tmp`, partialPath);
  };
  const snapshot = join(options.out, "snapshot.db");
  rmSync(snapshot, { force: true });
  const source = new DatabaseSync(options.database, { readOnly: true });
  await backup(source, snapshot);
  source.close();
  const db = openDatabase(snapshot, { migrate: false });

  const engine = benchTextEngine(options);
  const watch = sondineWatch(engine.capabilities.locality === "device");
  let meter: ReturnType<typeof startMeter> | null = null;
  try {
    log("measuring idle power for 20 s");
    const idle = powerSampler(2_000);
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    const idleSamples = await idle.stop();
    const baselineMw = mean(idleSamples);
    meter =
      options.meter === null
        ? null
        : startMeter(options.meter, join(options.out, `${options.label}.meter.jsonl`));
    const power = powerSampler(2_000);
    const resident = residentSampler(engine);
    const runStart = performance.now();
    const startedAt = new Date().toISOString();
    // A stopped bench must not leave the server or the meter running.
    const stop = () => {
      watch.stop();
      meter?.kill();
      void engine.unload().finally(() => process.exit(130));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (await yieldToSondine(engine, log)) watch.yields += 1;
    const { loadMs } = await engine.load();
    log(`loaded in ${loadMs} ms`);

    const fixtures: FixtureRecord[] = [];
    for (const fixture of JOURNAL_FIXTURES) {
      const items = await untilDone(engine, watch, log, (signal) =>
        writeJournal(engine, fixture.input, options.language, [], signal),
      );
      const record = scoreFixture(fixture, items);
      fixtures.push(record);
      log(`fixture ${fixture.id}: ${record.pass ? "pass" : record.problems.join("; ")}`);
    }

    const days: JournalBenchResult["days"][number][] = [];
    const specs = [
      ...options.days.map((spec) => {
        // `2026-11-07:conversation` keeps that size only.
        const [day = spec, size] = spec.split(":");
        const [from, to] = dayBounds(day);
        const ids = journalEpisodesBetween(db, from, to).filter(
          (id) =>
            size === undefined ||
            db.statement("SELECT size FROM episodes WHERE id = ?").get(id)?.["size"] === size,
        );
        return { spec, ids };
      }),
      ...(options.episodes.length === 0 ? [] : [{ spec: "episodes", ids: options.episodes }]),
    ];
    if (partial.episodes.length > 0) log(`resuming after ${partial.episodes.length} episodes`);
    for (const { spec, ids: episodeIds } of specs) {
      const windows: WindowRecord[] = [];
      const items: ItemRecord[] = [];
      const dayStart = performance.now();
      for (const [index, episodeId] of episodeIds.entries()) {
        const journalSource = loadJournalSource(db, episodeId, options.timeZone, Date.now());
        if (journalSource === null) continue;
        const done = partial.episodes.find(
          (entry) =>
            entry.spec === spec &&
            entry.episodeId === episodeId &&
            entry.inputHash === journalSource.inputHash,
        );
        if (done !== undefined) {
          windows.push(...done.windows);
          items.push(...done.items);
          continue;
        }
        const episodeWindows: WindowRecord[] = [];
        const drafts = await untilDone(engine, watch, log, (signal) => {
          episodeWindows.length = 0;
          return writeJournal(
            engine,
            journalSource.input,
            options.language,
            episodeWindows,
            signal,
          );
        });
        const episodeItems: ItemRecord[] = [];
        const labelOf = speakerRefs(journalSource.input.speakers);
        const refLabel = new Map([...labelOf.entries()].map(([label, ref]) => [ref, label]));
        const lineOf = new Map(
          journalSource.input.lines.map((line) => [
            line.segmentId,
            `${new Date(line.startMs).toTimeString().slice(0, 5)} ${line.speakerLabel ?? "?"}: ${line.text}`,
          ]),
        );
        for (const item of drafts) {
          episodeItems.push({
            episodeId,
            item,
            text: renderVoices(item.text, (ref) => `[${ref}]`),
            ...(item.kind === "commitment"
              ? {
                  whoLabel: item.who === null ? null : (refLabel.get(item.who) ?? null),
                  toLabel: item.to === null ? null : (refLabel.get(item.to) ?? null),
                }
              : {}),
            cited: item.segmentIds.map((segmentId) => ({
              segmentId,
              line: lineOf.get(segmentId) ?? "?",
            })),
          });
        }
        windows.push(...episodeWindows);
        items.push(...episodeItems);
        partial.episodes = [
          ...partial.episodes.filter(
            (entry) => !(entry.spec === spec && entry.episodeId === episodeId),
          ),
          {
            spec,
            episodeId,
            inputHash: journalSource.inputHash,
            windows: episodeWindows,
            items: episodeItems,
          },
        ];
        keep();
        if ((index + 1) % 10 === 0) log(`${spec}: ${index + 1}/${episodeIds.length} episodes`);
      }
      days.push({
        day: spec,
        episodes: episodeIds.length,
        windows,
        items,
        wallMs: Math.round(performance.now() - dayStart),
      });
      log(`${spec}: ${items.length} items from ${episodeIds.length} episodes`);
    }

    const residentMaxBytes = resident.stop();
    await engine.unload();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    const runSeconds = Math.round((performance.now() - runStart) / 1000);
    const powerSamples = await power.stop();
    const measured =
      meter === null ? { footprintMaxBytes: null, cpuJoules: null } : await meter.stop();
    meter = null;
    // Waiting for Sondine, the Mac drew for Nemotron, and the meter may have
    // followed Sondine's own llama-server: no energy is given then.
    const clean = watch.yields === 0;
    if (!clean) log(`waited ${watch.yields} times for Sondine: energy and power not reported`);
    const metered = clean ? measured : { ...measured, cpuJoules: null };

    const { stdout: memsize } = await run("/usr/sbin/sysctl", ["-n", "hw.memsize"]);
    const battery = await run("/usr/bin/pmset", ["-g", "batt"]).then(
      ({ stdout }) => stdout.includes("Battery Power"),
      () => null,
    );
    const result: JournalBenchResult = {
      schema: "sondine.bench.journal",
      version: 1,
      label: options.label,
      model: options.model,
      runtime: `${LLAMA_CPP_RUNTIME.name} ${LLAMA_CPP_RUNTIME.version}`,
      host: { memoryBytes: Number(memsize.trim()), onBattery: battery },
      startedAt,
      loadMs,
      fixtures,
      days,
      cost: {
        residentMaxBytes,
        ...metered,
        systemJoules: baselineMw === null || !clean ? null : integrate(powerSamples, baselineMw),
        baselineMilliwatts: baselineMw === null ? null : Math.round(baselineMw),
        runMilliwatts: clean
          ? ((value) => (value === null ? null : Math.round(value)))(mean(powerSamples))
          : null,
        runSeconds,
      },
    };
    const path = join(options.out, `${options.label}.json`);
    writeFileSync(path, JSON.stringify(result, null, 2), { mode: 0o600 });
    rmSync(partialPath, { force: true });
    return path;
  } finally {
    // Whatever stopped the run, nothing it started is left running.
    watch.stop();
    meter?.kill();
    await engine.unload();
    db.close();
    rmSync(snapshot, { force: true });
  }
}
