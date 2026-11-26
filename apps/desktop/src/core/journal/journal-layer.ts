import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatProvider } from "@sondine/api";
import {
  createClaudeProvider,
  createClaudeTextEngine,
  createJournalEngine,
  JOURNAL_ARTIFACT,
  makeLocator,
  stopWorkerProcesses,
  type StopWorkersReport,
  type TextEngine,
} from "@sondine/engines";
import { journalSettings } from "@sondine/db";
import { usageError } from "@sondine/protocol";
import { Context, Effect, Layer } from "effect";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { log } from "../log";
import { Models } from "../models/models-layer";
import { prepareWorkDirectory, providerOf } from "../chat/chat-service";
import { JournalWork } from "./journal-work";
import { VocabularyWork } from "./vocabulary-work";
import { UsageStatistics } from "../usage/usage-layer";

// The daily journal in core (ADR 028): its model, once Models has verified
// it and the build has the server; the user's Claude, through their CLI,
// for the writers that use it (run in a private empty folder, never the
// app's container, ADR 027); and the work the analysis scheduler runs.

/** The model the user's Claude writes with: the one measured on Téo's days. */
const CLAUDE_JOURNAL_MODEL = "haiku";

export class JournalEngineProvider extends Context.Service<
  JournalEngineProvider,
  { readonly current: () => TextEngine | null }
>()("sondine/core/JournalEngineProvider") {}

/** One engine per verified file: a model installed while core runs is used at once. */
export const journalEngineLayer = Layer.effect(
  JournalEngineProvider,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const models = yield* Models;
    const server = config.textServer;
    let engine: { readonly path: string; readonly engine: TextEngine } | null = null;
    return JournalEngineProvider.of({
      current: () => {
        if (server === null) return null;
        const installed = models.installed(JOURNAL_ARTIFACT.artifactId);
        if (installed === null) return engine?.engine ?? null;
        if (engine?.path !== installed.path) {
          engine = {
            path: installed.path,
            engine: createJournalEngine({
              server: server.binary,
              socket: server.socket,
              artifact: installed,
              onExit: (exit) => {
                if (!exit.expected) {
                  log.warn("journal.server-exited", {
                    code: exit.code,
                    signal: exit.signal,
                    during: exit.during,
                  });
                }
              },
            }),
          };
        }
        return engine.engine;
      },
    });
  }),
);

export interface JournalService {
  readonly work: JournalWork;
  /** The user's Claude CLI as the journal would use it, asked now. */
  claudeStatus(): Promise<ChatProvider>;
  /** Stops every process running the journal's server: at start, only orphans can. */
  stopServers(): Promise<StopWorkersReport>;
}

export class Journal extends Context.Service<Journal, JournalService>()("sondine/core/Journal") {}

export const journalLayer = Layer.effect(
  Journal,
  Effect.gen(function* () {
    const db = yield* Database;
    const engines = yield* JournalEngineProvider;
    const usage = yield* UsageStatistics;
    const config = yield* CoreConfig;
    // One folder per data directory, so a development build never empties the installed app's.
    const tag = createHash("sha256").update(config.dataDir).digest("hex").slice(0, 12);
    const workDirectory = join(tmpdir(), `app.sondine.journal-${tag}`);
    prepareWorkDirectory(workDirectory);
    const locator = makeLocator({ names: ["claude"], inherited: process.env });
    const locate = () => locator.locate("claude");
    const claude = createClaudeTextEngine({
      locate,
      model: CLAUDE_JOURNAL_MODEL,
      effort: null,
      workDirectory,
    });
    let claudeState: ChatProvider["state"] | null = null;
    const provider = createClaudeProvider({
      locate,
      log: (event, fields) => log.info(event, fields),
    });
    const work = new JournalWork({
      db,
      device: engines.current,
      claude: () => claude,
      writer: () => journalSettings(db).writer,
      enabled: () => journalSettings(db).enabled,
      language: () => journalSettings(db).language,
      timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      onFailed: (code) => usage.error(usageError("journal", code)),
      vocabulary: new VocabularyWork({ db, log }),
      log,
    });
    const server = config.textServer?.binary ?? null;
    return Journal.of({
      work,
      claudeStatus: async () => {
        // A CLI installed or signed in since the last look is found again;
        // a ready one is not looked for again (the login shell takes seconds).
        if (claudeState !== "ready") locator.refresh();
        const status = providerOf(await provider.detect());
        claudeState = status.state;
        return status;
      },
      stopServers: () =>
        server === null
          ? Promise.resolve({ stopped: [], survivors: [] })
          : stopWorkerProcesses(server),
    });
  }),
);
