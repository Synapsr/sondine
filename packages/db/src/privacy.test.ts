import { DAY_MS, webPageOf } from "@sondine/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordSpoolCommit, recordSpoolFile, upsertApp } from "./capture-import";
import {
  archivedAudioBytes,
  audioExpiryDue,
  commitAudioExpiry,
  dropRecordingsKeepingNothing,
  episodePrivacy,
  episodesWithoutText,
  recordingsToDelete,
  recordingsToSilence,
  takeAudioAfterText,
} from "./privacy-policy";
import {
  ZoneNotFound,
  ZoneRefused,
  addZone,
  durationsSince,
  episodeAudioKept,
  keepEpisodeAudio,
  listZones,
  migrateSiteRules,
  recordSituation,
  releaseEpisodeAudio,
  removeZone,
  setDuration,
  setMediaSiteKept,
  syncZoneSpans,
  updateZone,
} from "./privacy-zones";
import { chunks } from "./schema";
import { count, rate, seedEpisode, t0, tempDatabase, type TempDatabase } from "./test-helpers";
import { endWebPlay, setSiteKept, startWebPlay } from "./web-plays";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const setting = (key: string): unknown => {
  const row = temp.db.statement("SELECT value FROM settings WHERE key = ?").get(key);
  return row === undefined ? undefined : JSON.parse(String(row["value"]));
};

/** 2 s spool blocks over the first `seconds` of the run. */
function spool(trackRunId: number, seconds: number, relPath = "spool/system/r/0000.pcm"): void {
  const { spoolFileId } = recordSpoolFile(temp.db, {
    trackRunId,
    seq: 0,
    relPath,
    sampleStart: 0,
    createdWallMs: t0,
  });
  const block = 2 * rate;
  for (let index = 0; index * 2 < seconds; index++) {
    recordSpoolCommit(temp.db, {
      spoolFileId,
      byteOffset: index * block * 2,
      byteLength: block * 2,
      sampleStart: index * block,
      wallMs: t0 + index * 2000,
      crc32: index,
    });
  }
}

/** Every block archived at its own offset of `archive/<run>/0000.pcm`. */
function archiveAll(): void {
  temp.db
    .statement(
      `UPDATE chunks SET audio_state = 'archived', archive_rel_path = 'archive/r/0000.pcm',
         archive_byte_offset = byte_offset WHERE audio_state = 'present'`,
    )
    .run();
}

const blockStates = () =>
  temp.db.orm
    .select({ state: chunks.audioState })
    .from(chunks)
    .all()
    .map((row) => ({ present: ".", archived: "a", expired: "e", deleted: "x" })[row.state])
    .join("");

const page = (url: string) => {
  const parsed = webPageOf(url);
  if (parsed === null) throw new Error(`not a page: ${url}`);
  return parsed;
};

describe("zones", () => {
  it("lists the built-in zones first, with films, series and music on", () => {
    const zones = listZones(temp.db);
    expect(zones.map((zone) => [zone.id, zone.on, zone.outcome])).toEqual([
      ["media-sites", true, "nothing"],
      ["calls", false, "nothing"],
      ["screen", false, "nothing"],
      ["night", false, "nothing"],
    ]);
    const media = zones[0]?.situation;
    expect(media?.kind === "media_sites" ? media.sites : []).toContain("netflix.com");
  });

  it("adds, changes and removes the user's zones, once per app, site or network", () => {
    const zoom = addZone(temp.db, { kind: "app", bundleId: "us.zoom.xos", name: "Zoom" }, t0);
    expect(zoom).toMatchObject({ on: true, outcome: "nothing" });
    expect(() =>
      addZone(temp.db, { kind: "app", bundleId: "us.zoom.xos", name: "Zoom" }, t0),
    ).toThrow(ZoneRefused);
    expect(updateZone(temp.db, zoom.id, { outcome: "text_only" }, t0 + 1).outcome).toBe(
      "text_only",
    );
    expect(() => removeZone(temp.db, "night", t0)).toThrow(ZoneNotFound);
    removeZone(temp.db, zoom.id, t0 + 2);
    expect(listZones(temp.db)).toHaveLength(4);
  });

  it("keeps when each zone was on, with its outcome as it was", () => {
    const zoom = addZone(temp.db, { kind: "app", bundleId: "us.zoom.xos", name: "Zoom" }, t0);
    updateZone(temp.db, zoom.id, { outcome: "text_only" }, t0 + 10);
    updateZone(temp.db, zoom.id, { on: false }, t0 + 20);
    syncZoneSpans(temp.db, t0 + 30);
    const spans = temp.db
      .statement(
        "SELECT outcome, started_wall_ms, ended_wall_ms FROM privacy_zone_spans WHERE zone_id = ? ORDER BY id",
      )
      .all(zoom.id);
    expect(spans).toEqual([
      { outcome: "nothing", started_wall_ms: t0, ended_wall_ms: t0 + 10 },
      { outcome: "text_only", started_wall_ms: t0 + 10, ended_wall_ms: t0 + 20 },
    ]);
  });

  it("moves the site rules once, without changing what is kept", () => {
    setSiteKept(temp.db, "spotify.example", false, t0);
    setSiteKept(temp.db, "deezer.com", true, t0);
    temp.db
      .statement("UPDATE settings SET value = json_set(value, '$.\"kept.example\"', json('true'))")
      .run();
    migrateSiteRules(temp.db, t0);
    migrateSiteRules(temp.db, t0 + 1);
    const zones = listZones(temp.db);
    expect(zones.filter((zone) => zone.situation.kind === "site")).toEqual([
      expect.objectContaining({
        on: true,
        outcome: "nothing",
        situation: { kind: "site", site: "spotify.example" },
      }),
    ]);
    const media = zones[0]?.situation;
    expect(media?.kind === "media_sites" ? media.sites : []).not.toContain("deezer.com");
    expect(setting("browser.sites")).toEqual({ "deezer.com": true });
    expect(setting("capture.paused")).toBeUndefined();
  });
});

describe("which recordings a zone touches", () => {
  it("takes the zones on while it was recorded, not those switched on after", () => {
    const yab = upsertApp(temp.db, {
      bundleId: "dev.serafim.fast",
      name: "Yab",
      seenAtMs: t0,
    }).appId;
    const before = seedEpisode(temp.db, [[10, 20]]);
    temp.db.statement("UPDATE track_runs SET app_id = ? WHERE id = ?").run(yab, before.trackRunId);
    temp.db.statement("UPDATE episodes SET context = 'media' WHERE id = ?").run(before.episodeId);
    const zone = addZone(
      temp.db,
      { kind: "app", bundleId: "dev.serafim.fast", name: "Yab" },
      t0 + 30_000,
    );
    updateZone(temp.db, zone.id, { outcome: "audio_only" }, t0 + 30_000);
    const after = seedEpisode(temp.db, [[40, 50]], before.trackRunId);
    temp.db.statement("UPDATE episodes SET context = 'media' WHERE id = ?").run(after.episodeId);
    expect([
      ...episodesWithoutText(temp.db, [before.episodeId, after.episodeId], t0 + 60_000),
    ]).toEqual([after.episodeId]);
  });

  it("does not take a recording that only meets the zone at its edge", () => {
    const screen = seedEpisode(temp.db, [[10, 20]]);
    updateZone(temp.db, "screen", { on: true, outcome: "text_only" }, t0);
    // The screen locked as the conversation ended (a hold would have stopped capture there).
    recordSituation(temp.db, { screenAway: true, networks: [] }, t0 + 19_950);
    const longer = seedEpisode(temp.db, [[30, 40]]);
    recordSituation(temp.db, { screenAway: false, networks: [] }, t0 + 60_000);
    const privacy = episodePrivacy(temp.db, [screen.episodeId, longer.episodeId], t0 + 70_000);
    expect(privacy.get(screen.episodeId)?.keeping.audio).toBe(true);
    expect(privacy.get(longer.episodeId)?.keeping.audio).toBe(false);
  });

  it("matches a network and hours, and adds zones up", () => {
    const office = addZone(
      temp.db,
      { kind: "network", hashes: ["aa".repeat(16), "bb".repeat(16)], name: "Bureau" },
      t0,
    );
    updateZone(temp.db, office.id, { outcome: "text_only" }, t0);
    // t0 is 09:00 UTC; hours over the whole day, every day, keep the audio alone.
    const day = addZone(
      temp.db,
      {
        kind: "hours",
        name: "Jour",
        windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }],
      },
      t0,
    );
    updateZone(temp.db, day.id, { outcome: "audio_only" }, t0);
    recordSituation(temp.db, { screenAway: false, networks: ["aa".repeat(16)] }, t0);
    const talk = seedEpisode(temp.db, [[10, 20]]);
    const privacy = episodePrivacy(temp.db, [talk.episodeId], t0 + 30_000).get(talk.episodeId);
    expect(privacy?.zones.map((zone) => zone.zoneId).toSorted()).toEqual(
      [office.id, day.id].toSorted(),
    );
    expect(privacy?.keeping).toEqual({ text: false, audio: false, deleteAfterMs: null });
  });
});

describe("dropping at close what keeps nothing", () => {
  it("deletes a closed episode of a site left out, and the audio heard while it played", () => {
    syncZoneSpans(temp.db, t0);
    const yab = upsertApp(temp.db, {
      bundleId: "dev.serafim.fast",
      name: "Yab",
      seenAtMs: t0,
    }).appId;
    const film = seedEpisode(temp.db, [[10, 20]]);
    const other = seedEpisode(temp.db, [[30, 32]], film.trackRunId);
    temp.db
      .statement(
        "UPDATE episodes SET page_key = 'netflix.com/watch/81', context = 'media' WHERE id = ?",
      )
      .run(film.episodeId);
    const id = startWebPlay(temp.db, {
      appId: yab,
      page: page("https://www.netflix.com/watch/81"),
      url: "https://www.netflix.com/watch/81",
      title: "Film",
      atMs: t0 + 4000,
      nowMs: t0 + 4000,
    });
    endWebPlay(temp.db, id, t0 + 40_000, t0 + 40_000);
    spool(film.trackRunId, 50);

    const dropped = dropRecordingsKeepingNothing(
      temp.db,
      [film.episodeId, other.episodeId],
      t0 + 60_000,
    );
    expect(dropped.episodeIds).toEqual([film.episodeId]);
    expect(count(temp.db, "episodes", `id = ${other.episodeId}`)).toBe(1);
    // The play's whole blocks go, not those the other episode's speech needs.
    expect(blockStates()).toBe("..xxxxxxxxxxxx...xxx.....");
    expect(count(temp.db, "web_plays")).toBe(0);
  });

  it("leaves a built-in site the user keeps, and recordings no zone touches", () => {
    setMediaSiteKept(temp.db, "netflix.com", true, t0);
    const kept = seedEpisode(temp.db, [[10, 20]]);
    temp.db
      .statement(
        "UPDATE episodes SET page_key = 'netflix.com/watch/81', context = 'media' WHERE id = ?",
      )
      .run(kept.episodeId);
    const none = seedEpisode(temp.db, [[60, 70]]);
    expect(
      dropRecordingsKeepingNothing(temp.db, [kept.episodeId, none.episodeId], t0 + 100_000),
    ).toEqual({
      episodeIds: [],
      chunks: [],
    });
  });
});

describe("audio", () => {
  it("takes the audio once the text exists when a zone keeps the text alone", () => {
    const talk = seedEpisode(temp.db, [[10, 14]]);
    spool(talk.trackRunId, 30);
    const night = updateZone(
      temp.db,
      "night",
      {
        on: true,
        outcome: "text_only",
        windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }],
      },
      t0,
    );
    expect(night.on).toBe(true);
    const chunksTaken = takeAudioAfterText(temp.db, talk.episodeId, t0 + 30_000);
    // Region 10-14 s with 1.5 s before and 0.8 s after: blocks 8-16 s.
    expect(blockStates()).toBe("....xxxx.......");
    expect(chunksTaken).toHaveLength(4);
    expect(
      temp.db.statement("SELECT audio_gone_at_ms FROM episodes WHERE id = ?").get(talk.episodeId),
    ).toEqual({
      audio_gone_at_ms: t0 + 30_000,
    });
  });

  it("leaves kept audio alone, until the user lets it go", () => {
    const talk = seedEpisode(temp.db, [[10, 14]]);
    spool(talk.trackRunId, 30);
    updateZone(
      temp.db,
      "night",
      {
        on: true,
        outcome: "text_only",
        windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }],
      },
      t0,
    );
    expect(keepEpisodeAudio(temp.db, talk.episodeId, t0)).toBe(true);
    expect(episodeAudioKept(temp.db, talk.episodeId)).toBe(true);
    expect(takeAudioAfterText(temp.db, talk.episodeId, t0 + 30_000)).toEqual([]);
    releaseEpisodeAudio(temp.db, talk.episodeId, t0 + 40_000);
    expect(episodeAudioKept(temp.db, talk.episodeId)).toBe(false);
    expect(recordingsToSilence(temp.db, t0 + 8 * DAY_MS).ids).toEqual([talk.episodeId]);
  });

  it("expires archived audio by type, counted from the update, and keeps what a neighbour needs", () => {
    durationsSince(temp.db, t0);
    // A moment (30 days) next to a conversation (90 days) on one run.
    const moment = seedEpisode(temp.db, [[10, 14]]);
    const talk = seedEpisode(temp.db, [[15, 25]], moment.trackRunId);
    temp.db.statement("UPDATE episodes SET size = 'moment' WHERE id = ?").run(moment.episodeId);
    temp.db.statement("UPDATE episodes SET size = 'conversation' WHERE id = ?").run(talk.episodeId);
    spool(moment.trackRunId, 40);
    archiveAll();
    const cap = 1024 ** 4;
    expect(audioExpiryDue(temp.db, { nowMs: t0 + 20 * DAY_MS, capBytes: cap }).episodeIds).toEqual(
      [],
    );
    const due = audioExpiryDue(temp.db, { nowMs: t0 + 40 * DAY_MS, capBytes: cap });
    expect(due.episodeIds).toEqual([moment.episodeId]);
    // The conversation's roll (13.5 s on) reaches the moment's last blocks: only 8-12 s goes.
    expect(due.chunks.map((chunk) => chunk.chunkId)).toHaveLength(2);
    commitAudioExpiry(temp.db, due, t0 + 40 * DAY_MS);
    expect(blockStates()).toBe("aaaaeeaaaaaaaaaaaaaa");
    const later = audioExpiryDue(temp.db, { nowMs: t0 + 100 * DAY_MS, capBytes: cap });
    expect(later.episodeIds).toEqual([talk.episodeId]);
    commitAudioExpiry(temp.db, later, t0 + 100 * DAY_MS);
    expect(blockStates()).toBe("aaaaeeeeeeeeeaaaaaaa");
  });

  it("over the cap, takes the oldest audio first, never kept audio", () => {
    durationsSince(temp.db, t0);
    const first = seedEpisode(temp.db, [[10, 14]]);
    const second = seedEpisode(temp.db, [[30, 34]], first.trackRunId);
    spool(first.trackRunId, 40);
    archiveAll();
    keepEpisodeAudio(temp.db, first.episodeId, t0);
    const due = audioExpiryDue(temp.db, {
      nowMs: t0 + DAY_MS,
      capBytes: archivedAudioBytes(temp.db) - 1,
    });
    expect(due.episodeIds).toEqual([second.episodeId]);
    expect(due.forCap).toBe(1);
  });

  it("deletes recordings whose type's time is up", () => {
    durationsSince(temp.db, t0);
    const trace = seedEpisode(temp.db, [[10, 11]]);
    temp.db.statement("UPDATE episodes SET size = 'trace' WHERE id = ?").run(trace.episodeId);
    setDuration(temp.db, "traces", { deleteDays: 7 }, t0);
    expect(recordingsToDelete(temp.db, t0 + 6 * DAY_MS).ids).toEqual([]);
    expect(recordingsToDelete(temp.db, t0 + 8 * DAY_MS).ids).toEqual([trace.episodeId]);
  });

  it("deletes recordings a zone keeps for a day", () => {
    const zone = addZone(temp.db, { kind: "site", site: "example.com" }, t0);
    updateZone(temp.db, zone.id, { outcome: "delete_day" }, t0);
    const media = seedEpisode(temp.db, [[10, 20]]);
    temp.db
      .statement("UPDATE episodes SET page_key = 'example.com/a', context = 'media' WHERE id = ?")
      .run(media.episodeId);
    expect(recordingsToDelete(temp.db, t0 + 2 * DAY_MS).ids).toEqual([media.episodeId]);
  });

  it("gives audio recorded before the update at least 30 days from it", () => {
    const old = seedEpisode(temp.db, [[10, 11]]);
    temp.db.statement("UPDATE episodes SET size = 'trace' WHERE id = ?").run(old.episodeId);
    spool(old.trackRunId, 20);
    archiveAll();
    const update = t0 + 100 * DAY_MS;
    durationsSince(temp.db, update);
    const cap = 1024 ** 4;
    expect(
      audioExpiryDue(temp.db, { nowMs: update + 20 * DAY_MS, capBytes: cap }).episodeIds,
    ).toEqual([]);
    // Untranscribed, it also waits the 7 days of grace for its first transcript.
    expect(
      audioExpiryDue(temp.db, { nowMs: update + 36 * DAY_MS, capBytes: cap }).episodeIds,
    ).toEqual([]);
    expect(
      audioExpiryDue(temp.db, { nowMs: update + 38 * DAY_MS, capBytes: cap }).episodeIds,
    ).toEqual([old.episodeId]);
  });

  it("lets go of one recording without letting go of a neighbour the user keeps", () => {
    const first = seedEpisode(temp.db, [[110, 114]]);
    const second = seedEpisode(temp.db, [[115, 120]], first.trackRunId);
    keepEpisodeAudio(temp.db, first.episodeId, t0);
    keepEpisodeAudio(temp.db, second.episodeId, t0);
    releaseEpisodeAudio(temp.db, first.episodeId, t0 + 1);
    expect(episodeAudioKept(temp.db, first.episodeId)).toBe(false);
    expect(episodeAudioKept(temp.db, second.episodeId)).toBe(true);
  });
});

describe("a zone changed while a recording lasted", () => {
  it("takes every outcome it had: audio only, then text only, keeps nothing", () => {
    const yab = upsertApp(temp.db, {
      bundleId: "dev.serafim.fast",
      name: "Yab",
      seenAtMs: t0,
    }).appId;
    const zone = addZone(temp.db, { kind: "app", bundleId: "dev.serafim.fast", name: "Yab" }, t0);
    updateZone(temp.db, zone.id, { outcome: "audio_only" }, t0);
    updateZone(temp.db, zone.id, { outcome: "text_only" }, t0 + 15_000);
    const media = seedEpisode(temp.db, [[10, 20]]);
    temp.db.statement("UPDATE track_runs SET app_id = ? WHERE id = ?").run(yab, media.trackRunId);
    temp.db.statement("UPDATE episodes SET context = 'media' WHERE id = ?").run(media.episodeId);
    const privacy = episodePrivacy(temp.db, [media.episodeId], t0 + 30_000).get(media.episodeId);
    expect(privacy?.keeping).toEqual({ text: false, audio: false, deleteAfterMs: null });
    expect(privacy?.zones.map((touching) => touching.outcome)).toEqual(["text_only"]);
  });
});
