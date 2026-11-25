import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSpeechRegion, recordSpoolCommit, recordSpoolFile } from "./capture-import";
import { transaction } from "./database";
import { publishAnalysis } from "./publish";
import {
  at,
  rate,
  seedEpisode,
  seedTrackRun,
  segment,
  startRun,
  t0,
  tempDatabase,
  type TempDatabase,
} from "./test-helpers";

// Opt-in: SONDINE_BENCH=1 pnpm --filter @sondine/db bench
const enabled = process.env["SONDINE_BENCH"] === "1";

interface Cost {
  readonly wallMs: number;
  readonly cpuMs: number;
}

function measure(fn: () => void): Cost {
  const wall = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  fn();
  const used = process.cpuUsage(cpu);
  return {
    wallMs: Number(process.hrtime.bigint() - wall) / 1e6,
    cpuMs: (used.user + used.system) / 1000,
  };
}

const per = (cost: Cost, n: number) => ({
  wallUs: Math.round((cost.wallMs * 1000) / n),
  cpuUs: Math.round((cost.cpuMs * 1000) / n),
});

describe.runIf(enabled)("import transaction cost (SONDINE_BENCH=1)", () => {
  let temp: TempDatabase;
  let spoolFileId: number;
  let trackRunId: number;
  let block = 0;
  const blockBytes = 2 * rate * 2;

  beforeAll(() => {
    temp = tempDatabase();
    trackRunId = seedTrackRun(temp.db);
    spoolFileId = recordSpoolFile(temp.db, {
      trackRunId,
      seq: 0,
      relPath: "bench.pcm",
      sampleStart: 0,
      createdWallMs: t0,
    }).spoolFileId;
  });
  afterAll(() => temp.cleanup());

  const commit = () => {
    recordSpoolCommit(temp.db, {
      spoolFileId,
      byteOffset: block * blockBytes,
      byteLength: blockBytes,
      sampleStart: block * 2 * rate,
      continuousUs: block * 2_000_000,
      wallMs: t0 + block * 2000,
      crc32: block,
    });
    block += 1;
  };

  it("one transaction per 2 s commit (the always-on cadence)", () => {
    const n = 2000;
    const cost = measure(() => {
      for (let index = 0; index < n; index++) commit();
    });
    console.info("commit, own transaction", per(cost, n));
    expect(cost.wallMs / n).toBeLessThan(5);
  });

  it("five commits batched in one transaction (one 10 s import tick)", () => {
    const batches = 400;
    const cost = measure(() => {
      for (let batch = 0; batch < batches; batch++) {
        transaction(temp.db, () => {
          for (let index = 0; index < 5; index++) commit();
        });
      }
    });
    console.info("commit, batched x5", per(cost, batches * 5));
    expect(cost.wallMs / (batches * 5)).toBeLessThan(5);
  });

  it("replaying already-imported commits", () => {
    const replayed = block;
    block = 0;
    const cost = measure(() => {
      transaction(temp.db, () => {
        for (let index = 0; index < replayed; index++) commit();
      });
    });
    console.info("commit replay (duplicate)", per(cost, replayed));
  });

  it("region open per event", () => {
    const n = 1000;
    const cost = measure(() => {
      for (let index = 0; index < n; index++) {
        openSpeechRegion(temp.db, {
          trackRunId,
          sampleStart: at(index * 3),
          wallStartMs: t0 + index * 3000,
          vadVersion: "v",
        });
      }
    });
    console.info("region open", per(cost, n));
  });

  it("publishing a 3 h conversation (2,700 segments) in one transaction", () => {
    const { episodeId, trackRunId: run } = seedEpisode(temp.db, [[0, 10_800]]);
    const runId = startRun(temp.db, episodeId, "asr");
    const vocabulary =
      "bonjour alors donc réunion projet demain semaine budget écoute voilà exactement problème".split(
        " ",
      );
    const segments = Array.from({ length: 2700 }, (_, index) => {
      const text = Array.from(
        { length: 10 },
        (_word, k) => vocabulary[(index * 7 + k * 3) % vocabulary.length],
      ).join(" ");
      return {
        ...segment(run, index * 4, index * 4 + 4, text),
        words: Array.from({ length: 10 }, (_word, k) => ({
          charStart: k * 8,
          charEnd: k * 8 + 7,
          startMs: k * 400,
          endMs: k * 400 + 350,
        })),
      };
    });
    const publish = (id: number) =>
      measure(() => {
        const result = publishAnalysis(temp.db, {
          episodeId,
          stage: "asr",
          runId: id,
          inputGeneration: 1,
          segments,
          turns: [],
        });
        expect(result.published).toBe(true);
      });
    const first = publish(runId);
    console.info("publish 3 h", {
      wallMs: Math.round(first.wallMs),
      cpuMs: Math.round(first.cpuMs),
    });
    // Replacing a run deletes its index rows under FTS5 secure-delete.
    const again = publish(startRun(temp.db, episodeId, "asr"));
    console.info("republish 3 h (supersede)", {
      wallMs: Math.round(again.wallMs),
      cpuMs: Math.round(again.cpuMs),
    });
  });
});
