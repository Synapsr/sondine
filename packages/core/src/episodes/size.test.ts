import { describe, expect, it } from "vitest";

import { groupEpisodes } from "./grouping";
import {
  SIZE_TABLE_V1,
  SIZE_TABLE_VERSION,
  decideSize,
  sizeInputOf,
  type EpisodeSize,
  type SizeDecisionInput,
} from "./size";
import type { EpisodeContext } from "./types";

const MIN = 60_000;
const oneSpeaker = (turns: number) => ({ speakers: 1, turns });
const s = (seconds: number): bigint => BigInt(seconds) * 1_000_000_000n;

function input(overrides: Partial<SizeDecisionInput> = {}): SizeDecisionInput {
  return {
    context: "in_person",
    voicedMs: 10_000,
    elapsedMs: 30_000,
    episodeOpen: false,
    diarization: { speakers: 1, turns: 1 },
    ...overrides,
  };
}

describe("size table v1 rows", () => {
  it.each([
    // [label, input, size, rule]
    ["trace just below 1.5 s", input({ voicedMs: 1_499 }), "trace", "trace"],
    ["moment at exactly 1.5 s", input({ voicedMs: 1_500 }), "moment", "moment"],
    ["trace wins over call", input({ context: "call", voicedMs: 1_499 }), "trace", "trace"],
    ["call at 1.5 s", input({ context: "call", voicedMs: 1_500 }), "conversation", "call"],
    [
      "short call",
      input({ context: "call", voicedMs: 15_000, elapsedMs: 20_000 }),
      "conversation",
      "call",
    ],
    ["moment below 60 s voiced", input({ voicedMs: 59_999 }), "moment", "moment"],
    ["conversation at 60 s voiced", input({ voicedMs: 60_000 }), "conversation", "voiced"],
    [
      "media at 60 s voiced",
      input({ context: "media", voicedMs: 60_000 }),
      "conversation",
      "voiced",
    ],
    ["mixed below thresholds", input({ context: "mixed", voicedMs: 30_000 }), "moment", "moment"],
    [
      "elapsed just under 3 min with 2 speakers",
      input({ elapsedMs: 3 * MIN - 1, diarization: { speakers: 2, turns: 10 } }),
      "moment",
      "moment",
    ],
    [
      "elapsed 3 min with 2 speakers",
      input({ elapsedMs: 3 * MIN, diarization: { speakers: 2, turns: 1 } }),
      "conversation",
      "elapsed-speakers",
    ],
    [
      "elapsed 3 min, one speaker, 6 turns",
      input({ elapsedMs: 3 * MIN, diarization: { speakers: 1, turns: 6 } }),
      "conversation",
      "elapsed-turns",
    ],
    [
      "elapsed 3 min, one speaker, 5 turns",
      input({ elapsedMs: 3 * MIN, diarization: { speakers: 1, turns: 5 } }),
      "moment",
      "moment",
    ],
    [
      "elapsed 3 min before diarization",
      input({ elapsedMs: 3 * MIN, diarization: null }),
      "moment",
      "moment",
    ],
  ] as const)("%s", (_label, value, size, rule) => {
    const decision = decideSize(value);
    expect(decision.size).toBe(size);
    expect(decision.rule).toBe(rule);
    expect(decision.version).toBe(SIZE_TABLE_VERSION);
  });

  it("gives every input exactly one size (total table)", () => {
    const contexts: readonly EpisodeContext[] = ["call", "in_person", "media", "mixed"];
    const voiced = [0, 1_499, 1_500, 30_000, 59_999, 60_000, 600_000];
    const elapsed = [0, 179_999, 180_000, 3_600_000];
    const diarizations = [
      null,
      { speakers: 1, turns: 5 },
      { speakers: 1, turns: 6 },
      { speakers: 2, turns: 0 },
    ];
    const previous: readonly (EpisodeSize | undefined)[] = [
      undefined,
      "trace",
      "moment",
      "conversation",
    ];
    for (const context of contexts)
      for (const voicedMs of voiced)
        for (const elapsedMs of elapsed)
          for (const diarization of diarizations)
            for (const prev of previous)
              for (const episodeOpen of [false, true]) {
                const base = { context, voicedMs, elapsedMs, diarization, episodeOpen };
                const decision = decideSize(
                  prev === undefined ? base : { ...base, previous: prev },
                );
                expect(["trace", "moment", "conversation"]).toContain(decision.size);
              }
  });
});

describe("provisional state", () => {
  it("is provisional while the episode is open", () => {
    const decision = decideSize(input({ episodeOpen: true }));
    expect(decision).toMatchObject({ provisional: true, provisionalReasons: ["episode-open"] });
  });

  it("marks the middle case as awaiting diarization", () => {
    const decision = decideSize(input({ voicedMs: 30_000, elapsedMs: 4 * MIN, diarization: null }));
    expect(decision).toMatchObject({
      size: "moment",
      provisional: true,
      provisionalReasons: ["awaiting-diarization"],
    });
  });

  it("is final before diarization when diarization cannot change the size", () => {
    expect(decideSize(input({ elapsedMs: 2 * MIN, diarization: null })).provisional).toBe(false);
    expect(
      decideSize(input({ voicedMs: 90_000, elapsedMs: 4 * MIN, diarization: null })).provisional,
    ).toBe(false);
    expect(
      decideSize(input({ voicedMs: 1_000, elapsedMs: 4 * MIN, diarization: null })).provisional,
    ).toBe(false);
  });

  it("lists both reasons when they apply", () => {
    const decision = decideSize(
      input({ episodeOpen: true, elapsedMs: 4 * MIN, diarization: null }),
    );
    expect(decision.provisionalReasons).toEqual(["episode-open", "awaiting-diarization"]);
  });
});

describe("hysteresis", () => {
  const t = SIZE_TABLE_V1;

  it("keeps a conversation until voiced drops below 54 s", () => {
    const held = decideSize(input({ voicedMs: 54_000, previous: "conversation" }));
    expect(held).toMatchObject({ size: "conversation", rule: "voiced", heldByHysteresis: true });
    const dropped = decideSize(input({ voicedMs: 53_999, previous: "conversation" }));
    expect(dropped).toMatchObject({ size: "moment", heldByHysteresis: false });
  });

  it("keeps a moment until voiced reaches 66 s", () => {
    const held = decideSize(input({ voicedMs: 65_999, previous: "moment" }));
    expect(held).toMatchObject({ size: "moment", heldByHysteresis: true });
    expect(decideSize(input({ voicedMs: 66_000, previous: "moment" })).size).toBe("conversation");
  });

  it("keeps a trace until voiced reaches 1.8 s, and a moment until it drops below 1.2 s", () => {
    expect(decideSize(input({ voicedMs: 1_799, previous: "trace" }))).toMatchObject({
      size: "trace",
      heldByHysteresis: true,
    });
    expect(decideSize(input({ voicedMs: 1_800, previous: "trace" })).size).toBe("moment");
    expect(decideSize(input({ voicedMs: 1_200, previous: "moment" }))).toMatchObject({
      size: "moment",
      heldByHysteresis: true,
    });
    expect(decideSize(input({ voicedMs: 1_199, previous: "moment" })).size).toBe("trace");
    expect(
      decideSize(input({ voicedMs: 1_199, previous: "conversation", context: "call" })).size,
    ).toBe("trace");
  });

  it("applies margins to elapsed time and turns", () => {
    const diarized = { speakers: 2, turns: 10 };
    expect(
      decideSize(
        input({
          elapsedMs: t.conversationElapsedMs - t.conversationElapsedMarginMs,
          diarization: diarized,
          previous: "conversation",
        }),
      ).size,
    ).toBe("conversation");
    expect(
      decideSize(
        input({
          elapsedMs: t.conversationElapsedMs - t.conversationElapsedMarginMs - 1,
          diarization: diarized,
          previous: "conversation",
        }),
      ).size,
    ).toBe("moment");
    expect(
      decideSize(input({ elapsedMs: 3 * MIN + 14_999, diarization: diarized, previous: "moment" }))
        .size,
    ).toBe("moment");
    expect(
      decideSize(input({ elapsedMs: 3 * MIN + 15_000, diarization: diarized, previous: "moment" }))
        .size,
    ).toBe("conversation");
    expect(
      decideSize(
        input({ elapsedMs: 4 * MIN, diarization: oneSpeaker(5), previous: "conversation" }),
      ).size,
    ).toBe("conversation");
    expect(
      decideSize(input({ elapsedMs: 4 * MIN, diarization: oneSpeaker(6), previous: "moment" }))
        .size,
    ).toBe("moment");
    expect(
      decideSize(input({ elapsedMs: 4 * MIN, diarization: oneSpeaker(7), previous: "moment" }))
        .size,
    ).toBe("conversation");
  });

  it("has no margin on the call row or on speaker count", () => {
    expect(
      decideSize(input({ context: "in_person", voicedMs: 20_000, previous: "conversation" })).size,
    ).toBe("moment");
    expect(
      decideSize(
        input({ elapsedMs: 4 * MIN, diarization: { speakers: 2, turns: 0 }, previous: "moment" }),
      ).size,
    ).toBe("conversation");
  });

  it("records the thresholds it used", () => {
    expect(decideSize(input()).inputs.thresholds).toEqual({
      traceVoicedMs: 1_500,
      conversationVoicedMs: 60_000,
      conversationElapsedMs: 180_000,
      conversationSpeakers: 2,
      conversationTurns: 6,
    });
    expect(decideSize(input({ previous: "conversation" })).inputs.thresholds).toEqual({
      traceVoicedMs: 1_200,
      conversationVoicedMs: 54_000,
      conversationElapsedMs: 165_000,
      conversationSpeakers: 2,
      conversationTurns: 5,
    });
  });
});

describe("assertions", () => {
  it("lets a manual override win over the table, even while open", () => {
    const decision = decideSize(
      input({
        voicedMs: 500,
        episodeOpen: true,
        constraints: [{ size: "conversation", origin: "manual", seq: 3 }],
      }),
    );
    expect(decision).toMatchObject({
      size: "conversation",
      rule: "manual-override",
      provisional: false,
    });
  });

  it("lets manual beat auto whatever the order, and the latest of each win", () => {
    const decision = decideSize(
      input({
        constraints: [
          { size: "trace", origin: "manual", seq: 1 },
          { size: "conversation", origin: "auto", seq: 9 },
          { size: "moment", origin: "manual", seq: 2 },
        ],
      }),
    );
    expect(decision).toMatchObject({ size: "moment", rule: "manual-override" });
    expect(decision.inputs.constraint).toEqual({ size: "moment", origin: "manual", seq: 2 });
  });

  it("applies an automatic override and keeps it provisional while open", () => {
    const decision = decideSize(
      input({ episodeOpen: true, constraints: [{ size: "conversation", origin: "auto", seq: 1 }] }),
    );
    expect(decision).toMatchObject({
      size: "conversation",
      rule: "auto-override",
      provisional: true,
      provisionalReasons: ["episode-open"],
    });
  });
});

describe("kind_inputs", () => {
  it("returns every input as JSON-safe data", () => {
    const decision = decideSize(
      input({
        context: "call",
        voicedMs: 5_000,
        elapsedMs: 9_000,
        diarization: null,
        previous: "moment",
      }),
    );
    expect(decision.inputs).toEqual({
      version: "size/1",
      context: "call",
      voicedMs: 5_000,
      elapsedMs: 9_000,
      episodeOpen: false,
      speakers: null,
      turns: null,
      previous: "moment",
      constraint: null,
      thresholds: {
        traceVoicedMs: 1_200,
        conversationVoicedMs: 66_000,
        conversationElapsedMs: 195_000,
        conversationSpeakers: 2,
        conversationTurns: 7,
      },
    });
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });

  it("rejects invalid numbers", () => {
    expect(() => decideSize(input({ voicedMs: -1 }))).toThrow(RangeError);
    expect(() => decideSize(input({ elapsedMs: Number.POSITIVE_INFINITY }))).toThrow(RangeError);
    expect(() => decideSize(input({ diarization: { speakers: 1.5, turns: 2 } }))).toThrow(
      RangeError,
    );
  });
});

describe("from a grouped episode", () => {
  it("reads context, voiced and elapsed time from grouping", () => {
    const { episodes } = groupEpisodes({
      regions: [
        {
          id: "r1",
          trackKey: "input:mic",
          trackKind: "input",
          startNs: s(0),
          endNs: s(40),
          voicedMs: 35_000,
          appContext: { isCallApp: false, callActive: false },
        },
        {
          id: "r2",
          trackKey: "input:mic",
          trackKind: "input",
          startNs: s(60),
          endNs: s(100),
          voicedMs: 30_000,
          appContext: { isCallApp: false, callActive: false },
        },
      ],
      untilNs: s(200),
    });
    const episode = episodes[0];
    if (episode === undefined) throw new Error("expected one episode");
    const base = sizeInputOf(episode);
    expect(base).toEqual({
      context: "in_person",
      voicedMs: 65_000,
      elapsedMs: 100_000,
      episodeOpen: false,
    });
    expect(decideSize({ ...base, diarization: null })).toMatchObject({
      size: "conversation",
      rule: "voiced",
    });
  });
});
