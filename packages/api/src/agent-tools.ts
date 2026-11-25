import { isContractProcedure } from "@orpc/contract";
import type * as z from "zod";
import { contract } from "./contract";
import type { McpToolMeta } from "./meta";

/**
 * The tools agents may call in release 1 (ADR 011), by MCP name: read-only
 * reads of transcripts, days, people, the journal and its commitments (ADR
 * 028) and the listening state. An explicit
 * list, so new metadata never widens access by itself; diagnostics, writes
 * and everything with `mcp: null` stay off.
 */
export const AGENT_TOOLS = [
  "get_status",
  "get_day_overview",
  "list_episodes",
  "get_episode",
  "get_context_item",
  "search_transcripts",
  "list_people",
  "get_person",
  "get_journal",
  "list_commitments",
] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];

export interface AgentTool {
  readonly name: AgentToolName;
  /** The procedure's path in the router, for example `["episodes", "get"]`. */
  readonly path: readonly string[];
  readonly meta: McpToolMeta;
  /** The procedure's own input schema: agents' arguments are validated as the app's are. */
  readonly input: z.ZodType;
}

interface ProcedureNode {
  readonly "~orpc": {
    readonly meta: { readonly mcp: McpToolMeta | null };
    readonly inputSchema?: unknown;
  };
}

function* walk(node: unknown, path: string[]): Generator<{ path: string[]; node: ProcedureNode }> {
  if (isContractProcedure(node)) {
    yield { path, node: node as unknown as ProcedureNode };
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, child] of Object.entries(node)) yield* walk(child, [...path, key]);
}

/** The release's tools, in `AGENT_TOOLS` order; throws when one is missing or writes. */
export function agentTools(): AgentTool[] {
  const byName = new Map<string, AgentTool>();
  for (const { path, node } of walk(contract, [])) {
    const meta = node["~orpc"].meta.mcp;
    if (meta === null || !(AGENT_TOOLS as readonly string[]).includes(meta.name)) continue;
    if (!meta.readOnlyHint || meta.destructiveHint) {
      throw new Error(`${meta.name} is listed for agents but is not read-only`);
    }
    byName.set(meta.name, {
      name: meta.name as AgentToolName,
      path,
      meta,
      input: node["~orpc"].inputSchema as z.ZodType,
    });
  }
  return AGENT_TOOLS.map((name) => {
    const tool = byName.get(name);
    if (tool === undefined) throw new Error(`No procedure offers the agent tool ${name}`);
    return tool;
  });
}
