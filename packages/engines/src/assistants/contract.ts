/**
 * Assistant providers (ADR 027): the user's own agent CLIs (Claude Code,
 * Codex), signed in to their subscriptions, driven so that they read
 * Sondine through its tools and nothing else. Product code depends on these
 * types, never on a provider.
 */

/** Codex is not offered yet (ADR 027): its built-in tools cannot all be turned off. */
export type AssistantProviderId = "claude";

export interface AssistantModel {
  /** What the CLI takes as its model. */
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** Reasoning effort levels the model accepts, weakest first; empty when it takes none. */
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
  /** The provider's own default. */
  readonly isDefault: boolean;
}

export type AssistantState =
  /** Installed, signed in, models known. */
  | "ready"
  /** No executable on the login shell's PATH. */
  | "missing"
  /** Installed, but it refused Sondine's flags or protocol: too old or too new. */
  | "unsupported"
  /** Installed, nobody signed in. */
  | "signed-out"
  /** Could not be asked (it crashed, timed out). */
  | "failed";

export interface AssistantAccount {
  readonly email: string | null;
  /** The plan as the provider names it (`max`, `pro`, `plus`...), when it says. */
  readonly plan: string | null;
  /** A subscription, or an API key billed by use. */
  readonly billing: "subscription" | "api-key";
}

export interface AssistantStatus {
  readonly provider: AssistantProviderId;
  readonly state: AssistantState;
  readonly executable: string | null;
  readonly version: string | null;
  /** The provider's own folder (`CLAUDE_CONFIG_DIR`, `~/.claude`), which holds its sign-in. */
  readonly home: string | null;
  readonly account: AssistantAccount | null;
  readonly models: readonly AssistantModel[];
  /** A short reason for a state other than ready, never private text. */
  readonly problem: string | null;
}

/** An MCP server the provider starts over stdio (Sondine's relay, ADR 011). */
export interface McpStdioServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface AssistantSessionOptions {
  readonly model: string;
  readonly effort: string | null;
  /** The system prompt; replaces the provider's own. */
  readonly instructions: string;
  /** Sondine's tools: the server and the tool names it offers. Null: no tool at all. */
  readonly tools: { readonly server: McpStdioServer; readonly names: readonly string[] } | null;
  /** An empty folder the session starts in. */
  readonly workingDirectory: string;
}

export type AssistantErrorCode =
  | "signed-out"
  /** The subscription's limit, or a rate limit. */
  | "usage-limit"
  /** The conversation outgrew the model's context. */
  | "context-full"
  /** The provider could not be reached or answered with an error. */
  | "unavailable"
  /** The process exited or stopped answering. */
  | "crashed"
  /** It offered or used a tool that is not Sondine's: stopped (the tripwire). */
  | "refused-tool"
  /** It said something the adapter cannot read. */
  | "protocol";

export interface AssistantFailure {
  readonly code: AssistantErrorCode;
  /** Short and safe to show: never stderr or the model's text. */
  readonly message: string;
}

export type AssistantEvent =
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "tool-started";
      readonly callId: string;
      /** The tool's name on Sondine's server, without the provider's prefix. */
      readonly tool: string;
      readonly input: unknown;
    }
  | { readonly type: "tool-ended"; readonly callId: string; readonly ok: boolean }
  | { readonly type: "turn-ended"; readonly reason: "complete" | "interrupted" }
  /** The turn failed; the session takes another message. */
  | { readonly type: "turn-failed"; readonly failure: AssistantFailure }
  /** The session is over: nothing more comes, `send` refuses. */
  | { readonly type: "failed"; readonly failure: AssistantFailure };

export type AssistantListener = (event: AssistantEvent) => void;

export interface AssistantSession {
  /** Starts a turn; throws while one runs or after the session ended. */
  readonly send: (text: string) => void;
  /** Stops the turn that runs, if any; it ends with `interrupted`. */
  readonly interrupt: () => void;
  /** Ends the session and its processes. */
  readonly close: () => Promise<void>;
  readonly running: () => boolean;
}

export interface AssistantProvider {
  readonly id: AssistantProviderId;
  /** Asks the CLI who is signed in and which models it offers; reaches no model. */
  readonly detect: (signal?: AbortSignal) => Promise<AssistantStatus>;
  readonly open: (
    options: AssistantSessionOptions,
    listener: AssistantListener,
  ) => AssistantSession;
}
