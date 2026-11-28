// The flow lab's `sondine-audio read-voice` (ADR 034, ADR 049): no
// microphone. It writes 16 kHz PCM16 of a tone read in 2 s sentences with
// short pauses, enough for core to cut voiced pieces, and reports its levels
// every 100 ms like the real recorder, until stdin closes or its limit.
//
//   fake-recorder.mjs read-voice --out <file.pcm> --max-seconds <n>
import { closeSync, openSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (args[0] !== "read-voice" || value("--out") === undefined) {
  console.error("usage: read-voice --out <file.pcm> --max-seconds <n>");
  process.exit(2);
}
const RATE = 16_000;
const STEP = RATE / 10;
const maxSamples = Number(value("--max-seconds") ?? "60") * RATE;
const file = openSync(value("--out"), "w");
let written = 0;
const say = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

const stop = () => {
  clearInterval(timer);
  closeSync(file);
  say({ event: "stopped", ms: Math.round((written / RATE) * 1000) });
  process.exit(0);
};

say({ event: "started" });
const timer = setInterval(() => {
  const chunk = new Int16Array(STEP);
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < STEP; index++) {
    const at = written + index;
    const pause = at % 32_000 > 28_000;
    // A voice-like wobble: two tones whose loudness breathes.
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * at) / 9_000);
    const sample = pause
      ? 0
      : swell *
        (Math.sin((2 * Math.PI * 180 * at) / RATE) +
          0.5 * Math.sin((2 * Math.PI * 410 * at) / RATE));
    chunk[index] = Math.round(6_000 * sample);
    const level = Math.abs(chunk[index]) / 32_768;
    sum += level * level;
    peak = Math.max(peak, level);
  }
  writeSync(file, Buffer.from(chunk.buffer));
  written += STEP;
  say({
    event: "level",
    ms: Math.round((written / RATE) * 1000),
    rms: Math.min(1, Math.sqrt(sum / STEP) * 3),
    peak: Math.min(1, peak * 2),
  });
  if (written >= maxSamples) stop();
}, 100);
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();
