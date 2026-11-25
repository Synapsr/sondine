/**
 * How a procedure is offered to agents through MCP (ADR 011). The bridge
 * registers a tool only for procedures with `mcp`; release 1 exposes the
 * read-only ones.
 */
export interface McpToolMeta {
  /** Tool name, snake_case, unique across the router. */
  readonly name: string;
  /** Written for a model: what the tool does and when to call it. */
  readonly description: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
}

export interface ProcedureMeta {
  /** `null` keeps the procedure off MCP, for example a stream only the app consumes. */
  readonly mcp: McpToolMeta | null;
  /**
   * Event name, `object_verb` in snake_case (for example `listening_paused`).
   * `USAGE_RULES` (`packages/protocol`) says whether the anonymous statistics
   * count it (ADR 042).
   */
  readonly event: string;
}

export const EVENT_NAME_PATTERN = /^[a-z]+(?:_[a-z]+)+$/;
export const MCP_TOOL_NAME_PATTERN = /^[a-z]+(?:_[a-z]+)+$/;
