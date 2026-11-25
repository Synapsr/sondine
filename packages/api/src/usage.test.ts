import { isContractProcedure } from "@orpc/contract";
import { call, createRouterClient, ORPCError } from "@orpc/server";
import {
  ACTIVATION,
  COUNTED_EVENTS,
  USAGE_ONBOARDING,
  USAGE_RULES,
  type UsageError,
} from "@sondine/protocol";
import { describe, expect, it } from "vitest";
import { agentTools } from "./agent-tools";
import { contract } from "./contract";
import { ServiceFailure } from "./errors";
import type { ProcedureMeta } from "./meta";
import { PHONE_MEMORY_READS } from "./phone-procedures";
import { router } from "./router";
import { OnboardingStep } from "./schemas";
import type { ApiServices, UsageCounter } from "./services";

// What the anonymous statistics count (ADR 042): every procedure has a rule,
// and one middleware counts, with the caller's surface.

function events(node: unknown): { event: string; mcp: string | null }[] {
  if (isContractProcedure(node)) {
    const meta = node["~orpc"].meta as ProcedureMeta;
    return [{ event: meta.event, mcp: meta.mcp?.name ?? null }];
  }
  if (typeof node !== "object" || node === null) return [];
  return Object.values(node).flatMap(events);
}

class FakeCounter implements UsageCounter {
  consent: number | null = 1;
  readonly counted: string[] = [];
  readonly errors: UsageError[] = [];
  begin() {
    return this.consent;
  }
  succeeded(begun: number, surface: string, event: string) {
    this.counted.push(`${begun} ${surface} ${event}`);
  }
  failed(_begun: number, code: UsageError) {
    this.errors.push(code);
  }
}

const services = (overrides: object) => overrides as unknown as ApiServices;

describe("what counts as use", () => {
  const all = events(contract);

  it("gives every procedure a rule, and no rule to a procedure that is gone", () => {
    expect(Object.keys(USAGE_RULES).toSorted()).toEqual(all.map(({ event }) => event).toSorted());
  });

  it("never counts a stream, nor its own procedures but the two gestures", () => {
    for (const { event } of all) {
      if (event.endsWith("_watched")) expect(USAGE_RULES[event as "chat_watched"]).toBe("never");
    }
    expect(USAGE_RULES.usage_viewed).toBe("never");
    expect(USAGE_RULES.usage_sharing_set).toBe("never");
    expect(USAGE_RULES.process_crashed).toBe("never");
    expect(USAGE_RULES.diagnostic_viewed).toBe("never");
    expect(COUNTED_EVENTS[ACTIVATION.surface]).toContain(ACTIVATION.event);
  });

  it("offers agents and phones exactly the reads they can make", () => {
    const byTool = new Map(all.map(({ event, mcp }) => [mcp, event]));
    const tools = agentTools().map((tool) => byTool.get(tool.name) ?? "");
    expect(COUNTED_EVENTS.mcp.toSorted()).toEqual(tools.toSorted());
    for (const tool of Object.values(PHONE_MEMORY_READS)) {
      expect(COUNTED_EVENTS.mobile).toContain(byTool.get(tool));
    }
    // What the window repeats alone is never the window's use.
    for (const [event, rule] of Object.entries(USAGE_RULES)) {
      if (rule === "remote") expect(COUNTED_EVENTS.desktop).not.toContain(event);
    }
  });

  it("keeps the question, the report and the diagnostic out of agents' and phones' reach", () => {
    for (const { event, mcp } of all) {
      if (/^(?:usage|diagnostic|process_crashed|window_opened|conversation_opened)/u.test(event)) {
        expect(mcp, event).toBeNull();
      }
    }
  });

  it("knows the first run's steps", () => {
    expect(USAGE_ONBOARDING).toEqual([...OnboardingStep.options, "done"]);
  });
});

describe("the middleware", () => {
  it("counts a success with the caller's surface, and nothing of the input", async () => {
    const counter = new FakeCounter();
    const context = {
      services: services({ tags: { delete: async () => ({ recordings: 2 }) } }),
      usage: { counter, surface: "desktop" as const },
    };
    const client = createRouterClient(router, { context });
    await client.tags.delete({ tagId: 7 });
    await client.usage.conversationOpened();
    expect(counter.counted).toEqual(["1 desktop tag_deleted", "1 desktop conversation_opened"]);
    expect(counter.errors).toEqual([]);
  });

  it("counts nothing without a yes, nor for Sondine's own calls", async () => {
    const counter = new FakeCounter();
    counter.consent = null;
    const real = services({
      tags: { delete: async () => ({ recordings: 0 }) },
      listening: {
        pause: async () => {
          throw new Error("no");
        },
      },
    });
    const refused = createRouterClient(router, {
      context: { services: real, usage: { counter, surface: "desktop" } },
    });
    await refused.tags.delete({ tagId: 1 });
    await expect(refused.listening.pause()).rejects.toThrow();
    const own = createRouterClient(router, { context: { services: real } });
    await own.tags.delete({ tagId: 1 });
    expect(counter.counted).toEqual([]);
    expect(counter.errors).toEqual([]);
  });

  it("counts Sondine's own failures by code, not refused requests, and nothing of the message", async () => {
    const counter = new FakeCounter();
    const failing = async (error: unknown) => {
      const context = {
        services: services({
          listening: {
            pause: async () => {
              throw error;
            },
          },
        }),
        usage: { counter, surface: "desktop" as const },
      };
      await expect(call(router.listening.pause, {}, { context })).rejects.toThrow();
    };
    await failing(new ServiceFailure("helper-unavailable", "secret"));
    await failing(new ServiceFailure("helper-rejected", "secret", "x"));
    await failing(new ServiceFailure("timeout", "secret"));
    await failing(new TypeError("secret"));
    await failing(new ServiceFailure("not-found", "secret"));
    await failing(new ServiceFailure("invalid-input", "secret"));
    await failing(new ORPCError("BAD_REQUEST"));
    expect(counter.errors).toEqual([
      "api_helper_unavailable",
      "api_helper_rejected",
      "api_timeout",
      "api_internal",
    ]);
    expect(counter.counted).toEqual([]);
  });
});
