import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEMOTRON_ARTIFACT } from "./models/catalog.ts";
import { createNemotronEngine } from "./nemotron.ts";

// The real Nemotron worker on a clip from macOS `say`. Opt in with
// SONDINE_REAL_ENGINE=1: it loads about 17 GB, so never run two at once.
// Defaults to the spike's speech.cpp and weights; SONDINE_SPEECH_BINARY and
// SONDINE_NEMOTRON_WEIGHTS point elsewhere (e.g. the packaged app and the
// model store). The measurements go to SONDINE_REAL_ENGINE_REPORT, default
// $TMPDIR/sondine-real-engine.json: Vitest hides a passing test's logs.

const spike = join(
  homedir(),
  "Library/Application Support/com.sondine.desktop.next/models/nemotron-3.5-transcribe/0.9.3-iq4nl",
);
const speechBinary = process.env.SONDINE_SPEECH_BINARY ?? join(spike, "bin/speech");
const weights = process.env.SONDINE_NEMOTRON_WEIGHTS ?? join(spike, "external/model.gguf");
const reportPath =
  process.env.SONDINE_REAL_ENGINE_REPORT ?? join(tmpdir(), "sondine-real-engine.json");

/** Mono 16 kHz PCM16 of `text` said by `voice`. */
function say(dir: string, voice: string, text: string): Int16Array {
  const aiff = join(dir, `${voice}.aiff`);
  const wav = join(dir, `${voice}.wav`);
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const bytes = readFileSync(wav);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") {
      const data = bytes.subarray(offset + 8, offset + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${wav}`);
}

const rssBytes = (pid: number) => {
  try {
    return (
      Number(execFileSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" })) *
      1024
    );
  } catch {
    return 0;
  }
};

describe.skipIf(process.env.SONDINE_REAL_ENGINE !== "1")("Nemotron 3.5 Transcribe (real)", () => {
  it("transcribes French speech with speakers and word times", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sondine-real-"));
    const engine = createNemotronEngine({
      speechBinary,
      artifact: {
        artifactId: NEMOTRON_ARTIFACT.artifactId,
        version: NEMOTRON_ARTIFACT.version,
        dir: spike,
        path: weights,
        sizeBytes: NEMOTRON_ARTIFACT.sizeBytes,
        sha256: NEMOTRON_ARTIFACT.sha256,
        licenseId: NEMOTRON_ARTIFACT.license.id,
      },
    });
    let peakRss = 0;
    const sampler = setInterval(() => {
      const pid = engine.pid();
      if (pid !== undefined) peakRss = Math.max(peakRss, rssBytes(pid));
    }, 250);
    try {
      const first = say(
        dir,
        "Thomas",
        "Bonjour, je m'appelle Thomas. Nous testons la transcription locale de Sondine sur ce Mac.",
      );
      const silence = new Int16Array(16_000);
      const second = say(
        dir,
        "Amélie",
        "Très bien. Et moi, je réponds depuis Montréal, sans aucun accès au réseau.",
      );
      const samples = new Int16Array(first.length + silence.length + second.length);
      samples.set(first, 0);
      samples.set(second, first.length + silence.length);
      const durationSec = samples.length / 16_000;

      const { loadMs } = await engine.load();
      const result = await engine.transcribe({
        id: "real-1",
        samples,
        sampleRate: 16_000,
        language: "fr",
        speakers: true,
        timestamps: true,
      });
      const unloadStarted = performance.now();
      await engine.unload();
      const unloadMs = Math.round(performance.now() - unloadStarted);

      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            audioSec: durationSec,
            loadMs,
            computeMs: result.metrics.computeMs,
            realTimeFactor: result.metrics.computeMs / 1000 / durationSec,
            unloadMs,
            peakRssBytes: peakRss,
            text: result.text,
            segments: result.segments.map((segment) => ({
              start: segment.startSec,
              end: segment.endSec,
              speaker: segment.speaker,
              tokens: segment.tokens.length,
              text: segment.text,
            })),
          },
          null,
          2,
        ),
      );
      expect(result.stop).toBe("complete");
      expect(result.text.toLowerCase()).toContain("bonjour");
      expect(result.text).toMatch(/transcription/i);
      expect(result.segments.length).toBeGreaterThan(0);
      for (const segment of result.segments) {
        expect(segment.tokens.length).toBeGreaterThan(0);
        expect(segment.speaker).not.toBeNull();
        expect(segment.endSec).toBeLessThanOrEqual(durationSec);
      }
      expect(engine.state()).toBe("absent");
    } finally {
      clearInterval(sampler);
      await engine.unload();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
