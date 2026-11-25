import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeProvider, makeLocator } from "@sondine/engines";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { log } from "../log";
import { CoreState } from "../status/core-state";
import { ChatKeys } from "./chat-keys";
import { chatInstructions } from "./chat-instructions";
import { makeChatService, prepareWorkDirectory, type ChatService } from "./chat-service";

// Discussions in core (ADR 027): the providers found through the login
// shell, the relay the agent reads Sondine with, a private working folder
// outside the app group container (a CLI working in it would make macOS ask
// Téo about another app's data), emptied at start and removed at stop, and
// the deletions the discussions follow.

const providerLog = (event: string, fields: Record<string, string | number | boolean | null>) =>
  log.info(event, fields);

export class Chat extends Context.Service<Chat, ChatService>()("sondine/core/Chat") {}

export const chatLayer = Layer.effect(
  Chat,
  Effect.gen(function* () {
    const db = yield* Database;
    const keys = yield* ChatKeys;
    const config = yield* CoreConfig;
    const state = yield* CoreState;
    // One folder per data directory, so a development build never empties the installed app's.
    const tag = createHash("sha256").update(config.dataDir).digest("hex").slice(0, 12);
    const workDirectory = join(tmpdir(), `app.sondine.chat-${tag}`);
    prepareWorkDirectory(workDirectory);
    const locator = makeLocator({ names: ["claude"], inherited: process.env });
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const service = makeChatService({
      db,
      keys,
      providers: [
        createClaudeProvider({ locate: () => locator.locate("claude"), log: providerLog }),
      ],
      relay:
        config.agentRelay === null
          ? null
          : {
              command: config.agentRelay.path,
              args: config.agentRelay.socketArgument ? ["--socket", config.agentSocket] : [],
            },
      workDirectory,
      instructions: (nowMs) => chatInstructions(timeZone, nowMs),
      relocate: () => locator.refresh(),
    });
    // Anything deleted erases the discussions that read Sondine before it.
    let deletions = (yield* SubscriptionRef.get(state.status)).deletions;
    yield* SubscriptionRef.changes(state.status).pipe(
      Stream.runForEach((status) =>
        Effect.sync(() => {
          if (status.deletions === deletions) return;
          deletions = status.deletions;
          service.deleted();
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await service.close();
        rmSync(workDirectory, { recursive: true, force: true });
      }),
    );
    return Chat.of(service);
  }),
);
