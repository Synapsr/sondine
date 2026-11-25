import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { episodeKindOverride, setEpisodeKind } from "./episode-kind";
import { getEpisodeDetail, updateEpisodeSize } from "./episodes-store";
import { nameSpeaker, resolveSpeakers } from "./people";
import { publishAnalysis, type SegmentInput, type TurnInput } from "./publish";
import {
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";
import { editSegment } from "./transcript-edits";
import { refuseSuggestion } from "./voices";

// M2 exit (plan.md): "Reanalysis preserves every assertion". One episode gets
// each kind the user can make: a correction, a name, a « Non », a type and
// « ne pas identifier »; a new transcript of the same audio, cut and labelled
// differently, keeps all of them.

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const s = (seconds: number) => t0 + seconds * 1000;

function publish(
  episodeId: number,
  segments: readonly SegmentInput[],
  turns: readonly TurnInput[],
) {
  const runId = startRun(temp.db, episodeId, "asr");
  expect(
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments,
      turns,
    }).published,
  ).toBe(true);
  return runId;
}

describe("a reanalysis", () => {
  it("keeps every assertion the user made", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    temp.db.client
      .prepare("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
      .run(episodeId);
    const first = publish(
      episodeId,
      [
        segment(trackRunId, 10, 20, "le budjet est prêt", "A"),
        segment(trackRunId, 25, 40, "très bien", "B"),
      ],
      [turn(trackRunId, 10, 20, "A"), turn(trackRunId, 25, 40, "B")],
    );
    const [budget] = getEpisodeDetail(temp.db, episodeId)?.segments ?? [];
    expect(
      editSegment(temp.db, {
        episodeId,
        runId: first,
        segmentId: budget?.id ?? 0,
        nowMs: s(50),
        text: "le budget est prêt",
      }),
    ).toBe("ok");
    const marie = nameSpeaker(temp.db, {
      episodeId,
      runId: first,
      label: "A",
      person: { kind: "new", name: "Marie" },
      nowMs: s(51),
    });
    if (!marie.ok) throw new Error(marie.reason);
    expect(
      refuseSuggestion(temp.db, {
        episodeId,
        runId: first,
        label: "B",
        personId: marie.value.id,
        nowMs: s(52),
      }),
    ).toBe("ok");
    expect(setEpisodeKind(temp.db, { episodeId, kind: "moment", nowMs: s(53) })).toBe(true);
    temp.db.client
      .prepare(
        "INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms) VALUES ('episode', ?, 1, 0, 0)",
      )
      .run(episodeId);
    const assertions = () =>
      temp.db.client
        .prepare(
          "SELECT id, kind, sample_start, sample_end, payload, person_id, revoked_at_ms FROM user_assertions ORDER BY id",
        )
        .all();
    const before = assertions();

    // The engine again: other labels, the first sentence cut in two.
    const second = publish(
      episodeId,
      [
        segment(trackRunId, 10, 15, "le budjet", "spk_1"),
        segment(trackRunId, 15, 20, "est prêt", "spk_1"),
        segment(trackRunId, 25, 40, "très bien", "spk_0"),
      ],
      [turn(trackRunId, 10, 20, "spk_1"), turn(trackRunId, 25, 40, "spk_0")],
    );
    // Sondine decides the size again after a transcript.
    updateEpisodeSize(
      temp.db,
      episodeId,
      {
        size: "conversation",
        sizeState: "final",
        kindInputs: { rule: "voiced" },
        classifierVersion: "size/1",
      },
      s(60),
    );

    expect(assertions()).toEqual(before);
    expect(getEpisodeDetail(temp.db, episodeId)?.segments.map((x) => x.text)).toEqual([
      "le budget est prêt",
      "très bien",
    ]);
    const names = resolveSpeakers(temp.db, second);
    expect(names.get("spk_1")?.name).toBe("Marie");
    expect(names.has("spk_0")).toBe(false);
    expect(episodeKindOverride(temp.db, episodeId)).toBe("moment");
    expect(temp.db.client.prepare("SELECT size FROM episodes WHERE id = ?").get(episodeId)).toEqual(
      {
        size: "moment",
      },
    );
    expect(
      temp.db.client
        .prepare("SELECT recognize FROM identity_rules WHERE episode_id = ?")
        .get(episodeId),
    ).toEqual({ recognize: 1 });
  });
});
