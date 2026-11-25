import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordListenActive, recordSpanEnded } from "./calls";
import {
  dictationApps,
  dictationText,
  listeningApps,
  setDictationApp,
  setDictationText,
} from "./dictation-apps";
import { t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const at = (sec: number) => ({ wallMs: t0 + sec * 1000, continuousUs: sec * 1_000_000 });

function heard(uid: string, bundleId: string, fromSec: number, toSec: number): void {
  recordListenActive(temp.db, {
    uid,
    sessionId: "s",
    bundleId,
    via: "app",
    at: at(fromSec),
    nowMs: t0,
  });
  recordSpanEnded(temp.db, "listens", { uid, at: at(toSec), nowMs: t0 });
}

describe("a dictation app's own text", () => {
  it("is taken from Hex unless the user said no, and never from an app Sondine cannot read", () => {
    expect(dictationText(temp.db, "anomaly.hex")).toBe(true);
    setDictationText(temp.db, "anomaly.hex", false, t0);
    expect(dictationText(temp.db, "anomaly.hex")).toBe(false);
    setDictationText(temp.db, "anomaly.hex", true, t0);
    expect(dictationText(temp.db, "anomaly.hex")).toBe(true);
    expect(dictationText(temp.db, "com.example.recorder")).toBeNull();
    // Apart from which apps count as dictation.
    expect(dictationApps(temp.db).has("anomaly.hex")).toBe(true);
  });
});

describe("dictation apps", () => {
  it("keeps an app the user added listed, named, before and after it is switched off", () => {
    setDictationApp(temp.db, "com.example.whisper", true, t0, "Whisper Pro");
    const added = () =>
      listeningApps(temp.db, new Set()).find((app) => app.bundleId === "com.example.whisper");
    expect(added()).toEqual({
      bundleId: "com.example.whisper",
      name: "Whisper Pro",
      via: "app",
      lastListenedAtMs: null,
      dictation: true,
      text: null,
    });
    expect(dictationApps(temp.db).has("com.example.whisper")).toBe(true);
    setDictationApp(temp.db, "com.example.whisper", false, t0 + 1);
    expect(added()).toMatchObject({ name: "Whisper Pro", dictation: false });
  });

  it("counts the known dictation apps by default, then follows the user's rules", () => {
    expect([...dictationApps(temp.db)]).toEqual(
      expect.arrayContaining([
        "anomaly.hex",
        "app.synapsr.parler",
        "com.prakashjoshipax.VoiceInk",
        "com.electron.wispr-flow",
      ]),
    );
    setDictationApp(temp.db, "app.synapsr.parler", false, t0);
    setDictationApp(temp.db, "com.example.recorder", true, t0);
    expect(dictationApps(temp.db).has("app.synapsr.parler")).toBe(false);
    expect(dictationApps(temp.db).has("com.example.recorder")).toBe(true);
  });

  it("lists the apps heard, latest first, then the known ones installed that have not listened", () => {
    heard("a", "com.example.recorder", 10, 20);
    heard("b", "anomaly.hex", 30, 40);
    const installed = new Set(["anomaly.hex", "app.synapsr.parler"]);
    expect(listeningApps(temp.db, installed)).toEqual([
      {
        bundleId: "anomaly.hex",
        name: null,
        via: "app",
        lastListenedAtMs: t0 + 40_000,
        dictation: true,
        text: true,
      },
      {
        bundleId: "com.example.recorder",
        name: null,
        via: "app",
        lastListenedAtMs: t0 + 20_000,
        dictation: false,
        text: null,
      },
      {
        bundleId: "app.synapsr.parler",
        name: "Parler",
        via: "app",
        lastListenedAtMs: null,
        dictation: true,
        text: true,
      },
    ]);
  });
});
