import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRecording } from "./audio-import";
import { deleteEpisode } from "./delete-episode";
import {
  listPhoneDevices,
  pairedPhoneCount,
  pairPhoneDevice,
  phoneDeviceByCredential,
  phoneInboxBytes,
  phoneOperationDone,
  phoneRecordingEpisode,
  phoneRecordingOwner,
  phoneRecordingReadings,
  phoneSyncSettings,
  putPhoneUpload,
  recordPhoneOperation,
  revokeAllPhoneDevices,
  revokePhoneDevice,
  setPhoneSyncSettings,
  tombstoneUnreceivedPhoneRecording,
  touchPhoneDevice,
} from "./phone-devices";
import { loadEpisodeSummaries } from "./episodes-store";
import {
  phoneArrival,
  PhoneRecordingRefused,
  renamePhoneRecording,
  storedPhoneRecording,
} from "./phone-recordings";
import { tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const PHONE = "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b";
const OTHER = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
const hash = (text: string) => createHash("sha256").update(text).digest();

/** A phone recording as the import publishes it, by `deviceId`. */
function received(recordingId: string, deviceId = PHONE) {
  return importRecording(temp.db, {
    uid: `run-${recordingId}`,
    fileName: "a.m4a",
    sampleRate: 16_000,
    sampleCount: 32_000,
    startedWallMs: 1_000,
    archiveRelPath: `archive/imports/${recordingId}/0001.pcm`,
    spoolRelPath: `spool/imports/${recordingId}/0001.pcm`,
    chunks: [{ sampleStart: 0, sampleCount: 32_000, byteOffset: 0, crc32: 7 }],
    nowMs: 2_000,
    phone: { recordingId, deviceId, sha256: "a".repeat(64), timeUncertain: false },
  });
}

describe("paired phones", () => {
  it("keeps a credential's hash, replaces a device id that pairs again, and revokes", () => {
    pairPhoneDevice(temp.db, {
      deviceId: PHONE,
      name: "iPhone de Téo",
      credentialHash: hash("one"),
      nowMs: 10,
    });
    expect(phoneDeviceByCredential(temp.db, hash("one"))?.lastVia).toBeNull();
    touchPhoneDevice(temp.db, PHONE, 20, "uploads", "tailnet");
    touchPhoneDevice(temp.db, PHONE, 15, "reads");
    expect(phoneDeviceByCredential(temp.db, hash("one"))).toMatchObject({
      deviceId: PHONE,
      lastContactAtMs: 20,
      lastVia: "tailnet",
      uploads: 1,
      reads: 1,
      deletions: 0,
    });
    touchPhoneDevice(temp.db, PHONE, 25, undefined, "lan");
    expect(phoneDeviceByCredential(temp.db, hash("one"))?.lastVia).toBe("lan");
    // The answer was lost on the way: the phone pairs again with a new QR.
    pairPhoneDevice(temp.db, {
      deviceId: PHONE,
      name: "iPhone",
      credentialHash: hash("two"),
      nowMs: 30,
    });
    expect(phoneDeviceByCredential(temp.db, hash("one"))).toBeNull();
    expect(phoneDeviceByCredential(temp.db, hash("two"))).toMatchObject({
      name: "iPhone",
      pairedAtMs: 30,
      lastContactAtMs: null,
      lastVia: null,
      uploads: 0,
    });
    pairPhoneDevice(temp.db, {
      deviceId: OTHER,
      name: "iPad",
      credentialHash: hash("three"),
      nowMs: 40,
    });
    expect(pairedPhoneCount(temp.db)).toBe(2);
    expect(revokePhoneDevice(temp.db, PHONE, 50)).toBe(true);
    expect(revokePhoneDevice(temp.db, PHONE, 60)).toBe(false);
    expect(phoneDeviceByCredential(temp.db, hash("two"))?.revokedAtMs).toBe(50);
    expect(listPhoneDevices(temp.db).map((device) => device.deviceId)).toEqual([OTHER, PHONE]);
    expect(revokeAllPhoneDevices(temp.db, 70)).toEqual([OTHER]);
    expect(pairedPhoneCount(temp.db)).toBe(0);
  });

  it("remembers an operation once per phone", () => {
    pairPhoneDevice(temp.db, { deviceId: PHONE, name: "a", credentialHash: hash("a"), nowMs: 1 });
    const op = {
      deviceId: PHONE,
      operationId: "op-1",
      kind: "delete" as const,
      recordingId: "r",
      nowMs: 2,
    };
    expect(phoneOperationDone(temp.db, PHONE, "op-1")).toBe(false);
    expect(recordPhoneOperation(temp.db, op)).toBe(true);
    expect(recordPhoneOperation(temp.db, op)).toBe(false);
    expect(phoneOperationDone(temp.db, PHONE, "op-1")).toBe(true);
    expect(phoneOperationDone(temp.db, OTHER, "op-1")).toBe(false);
  });

  it("keeps its settings, off by default", () => {
    expect(phoneSyncSettings(temp.db)).toEqual({
      enabled: false,
      tailnet: false,
      port: null,
      serviceName: null,
      macId: null,
    });
    setPhoneSyncSettings(temp.db, { enabled: true, port: 49_321, serviceName: "Sondine K7Q2" }, 1);
    setPhoneSyncSettings(temp.db, { tailnet: true }, 2);
    expect(phoneSyncSettings(temp.db)).toMatchObject({
      enabled: true,
      tailnet: true,
      port: 49_321,
      serviceName: "Sondine K7Q2",
    });
  });
});

describe("a phone's recordings", () => {
  it("belong to the device their header names, received by AirDrop before pairing too", () => {
    received("rec-1");
    expect(phoneRecordingOwner(temp.db, "rec-1")).toBe(PHONE);
    putPhoneUpload(temp.db, {
      recordingId: "rec-2",
      deviceId: OTHER,
      bytes: 10,
      sha256: "b".repeat(64),
      announcedAtMs: 1,
    });
    expect(phoneRecordingOwner(temp.db, "rec-2")).toBe(OTHER);
    expect(phoneRecordingOwner(temp.db, "rec-3")).toBeNull();
    expect(phoneInboxBytes(temp.db, "rec-9")).toBe(10);
    expect(phoneInboxBytes(temp.db, "rec-2")).toBe(0);
  });

  it("leave a tombstone when deleted before they arrived, so a copy sent later is refused", () => {
    expect(
      tombstoneUnreceivedPhoneRecording(temp.db, {
        recordingId: "rec-1",
        deviceId: PHONE,
        nowMs: 5,
      }),
    ).toBe(true);
    expect(
      tombstoneUnreceivedPhoneRecording(temp.db, {
        recordingId: "rec-1",
        deviceId: PHONE,
        nowMs: 6,
      }),
    ).toBe(false);
    expect(phoneArrival(temp.db, { recordingId: "rec-1", sha256: "a".repeat(64) })).toEqual({
      kind: "deleted",
    });
    expect(() => received("rec-1")).toThrow(PhoneRecordingRefused);
  });

  it("read their state from the database; another phone's read unknown", () => {
    const stored = received("rec-1");
    received("rec-2");
    putPhoneUpload(temp.db, {
      recordingId: "rec-3",
      deviceId: PHONE,
      bytes: 10,
      sha256: "b".repeat(64),
      announcedAtMs: 1,
    });
    received("rec-4", OTHER);
    const ids = ["rec-1", "rec-2", "rec-3", "rec-4", "rec-5"];
    const read = () => phoneRecordingReadings(temp.db, PHONE, ids);
    expect(read()).toEqual(["waiting", "waiting", "receiving", "unknown", "unknown"]);
    const episode = phoneRecordingEpisode(temp.db, "rec-1");
    expect(episode).toBe(stored.episodeId);
    temp.db.statement("UPDATE episodes SET analysis_state = 'running' WHERE id = ?").run(episode);
    const second = phoneRecordingEpisode(temp.db, "rec-2");
    temp.db.statement("UPDATE episodes SET analysis_state = 'complete' WHERE id = ?").run(second);
    expect(read().slice(0, 2)).toEqual(["transcribing", "ready"]);
    // « Supprimer » on the Mac: the phone reads deleted.
    expect(deleteEpisode(temp.db, stored.episodeId, { origin: "app" }).deleted).toBe(true);
    expect(read()[0]).toBe("deleted");
    expect(phoneRecordingEpisode(temp.db, "rec-1")).toBeNull();
  });

  it("take the later name typed, show it on the Mac, and lose it with their text", () => {
    const { episodeId } = received("rec-1");
    const rename = (name: string | null, typedAtMs: number) =>
      renamePhoneRecording(temp.db, { recordingId: "rec-1", name, typedAtMs });
    expect(rename("Budget", 100)).toBe("named");
    // Typed before, arrived after: dropped.
    expect(rename("Brouillon", 50)).toBe("superseded");
    expect(storedPhoneRecording(temp.db, "rec-1")).toEqual({
      deviceId: PHONE,
      name: "Budget",
      timeUncertain: false,
    });
    expect(loadEpisodeSummaries(temp.db, [episodeId]).get(episodeId)?.phone).toEqual({
      timeUncertain: false,
      name: "Budget",
    });
    // Blanks are no name: back to the hour.
    expect(rename("   ", 150)).toBe("named");
    expect(storedPhoneRecording(temp.db, "rec-1")?.name).toBeNull();
    expect(rename(" Réunion ", 150)).toBe("named");
    expect(storedPhoneRecording(temp.db, "rec-1")?.name).toBe("Réunion");
    expect(renamePhoneRecording(temp.db, { recordingId: "rec-9", name: "x", typedAtMs: 1 })).toBe(
      "not-stored",
    );
    expect(deleteEpisode(temp.db, episodeId, { origin: "app" }).deleted).toBe(true);
    expect(rename("Après", 200)).toBe("deleted");
    expect(
      temp.db
        .statement("SELECT name, name_typed_at_ms FROM phone_recordings WHERE recording_id = ?")
        .get("rec-1"),
    ).toEqual({ name: null, name_typed_at_ms: null });
  });
});
