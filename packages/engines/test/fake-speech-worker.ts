// A stand-in for `speech worker MODEL` (speech.cpp protocol 3) with scripted
// behaviours, run by Node directly:
//
//   node fake-speech-worker.ts --scenario NAME [--log FILE] worker MODEL --device gpu --threads 4
//
// `normal` answers each request with one segment per 10 s chunk, speakers
// alternating, one token per word. The other scenarios break one rule each.
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    scenario: { type: "string", default: "normal" },
    log: { type: "string" },
    "ready-delay-ms": { type: "string", default: "0" },
  },
});
const scenario = String(values.scenario);
const logFile = typeof values.log === "string" ? values.log : undefined;
const log = (entry: object) => {
  if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
const workerArgs = process.argv.slice(process.argv.indexOf("worker"));
log({
  event: "start",
  argv: workerArgs,
  noUpdateCheck: process.env.SPEECH_NO_UPDATE_CHECK ?? null,
});

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const SAMPLE_RATE = 16_000;
const MAX_CHUNK_BYTES = 10 * SAMPLE_RATE * 2;

if (positionals[0] !== "worker" || workerArgs[1] === undefined || !existsSync(workerArgs[1])) {
  send({ type: "fatal", error: { code: "model_file", option: null, message: "no model file" } });
  process.exit(1);
}

interface Pending {
  chunks: number[];
  answered: boolean;
}
const requests = new Map<string, Pending>();

function ready() {
  process.stderr.write("fake worker: model loaded\n");
  switch (scenario) {
    case "never-ready":
      return;
    case "fatal":
      send({ type: "fatal", error: { code: "model_file", option: null, message: "bad model" } });
      process.exit(1);
      return;
    case "bad-protocol":
      send({ type: "ready", protocol: 2, version: "0.9.3", defaults: {}, model: {} });
      return;
    case "bad-version":
      send({ type: "ready", protocol: 3, version: "0.9.2", defaults: {}, model: {} });
      return;
    case "crash-idle":
      send({ type: "ready", protocol: 3, version: "0.9.3", defaults: {}, model: {} });
      setTimeout(() => process.exit(4), 50);
      return;
    default:
      send({ type: "ready", protocol: 3, version: "0.9.3", defaults: {}, model: {} });
  }
}
setTimeout(ready, Number(values["ready-delay-ms"]));

function normalEnd(id: string, chunks: readonly number[]) {
  const segments: { start: number; end: number; text: string; speaker: number }[] = [];
  const tokens: { start: number; end: number; text: string }[] = [];
  let offset = 0;
  for (const [seq, samples] of chunks.entries()) {
    const start = offset / SAMPLE_RATE;
    const end = (offset + samples) / SAMPLE_RATE;
    const words = ["chunk", String(seq), `${samples}`, "samples."];
    const step = (end - start) / words.length;
    words.forEach((word, index) =>
      tokens.push({
        start: start + index * step,
        end: start + (index + 1) * step,
        text: ` ${word}`,
      }),
    );
    segments.push({ start, end, text: words.join(" "), speaker: seq % 2 });
    offset += samples;
  }
  return {
    type: "end",
    id,
    text: segments.map((segment) => segment.text).join(" "),
    stop: "complete",
    segments,
    tokens,
  };
}

function answer(id: string, request: Pending) {
  request.answered = true;
  const durationSec = request.chunks.reduce((sum, samples) => sum + samples, 0) / SAMPLE_RATE;
  switch (scenario) {
    case "error":
      send({
        type: "error",
        id,
        error: { code: "invalid_argument", option: "language", message: "no" },
      });
      return;
    case "crash":
      process.stderr.write("fake worker: about to crash\n");
      process.exit(3);
      return;
    case "hang":
    case "hang-cancellable":
      request.answered = false;
      return;
    case "garbage":
      process.stdout.write("this is not json\n");
      return;
    case "refuse-line":
      send({
        type: "error",
        error: { code: "invalid_argument", option: "type", message: "bad line" },
      });
      return;
    case "progress":
      for (const done of [0.25, 0.5, 0.75, 1]) send({ type: "progress", id, done });
      send(normalEnd(id, request.chunks));
      return;
    case "wrong-id":
      send({ type: "progress", id: "someone-else", done: 0.5 });
      send({
        type: "end",
        id: "someone-else",
        text: "",
        stop: "complete",
        segments: [],
        tokens: [],
      });
      send({ type: "cancelled", id: "someone-else" });
      send(normalEnd(id, request.chunks));
      return;
    case "past-the-audio":
      send({
        type: "end",
        id,
        text: "late",
        stop: "complete",
        segments: [{ start: 0, end: durationSec + 2, text: "late", speaker: 0 }],
        tokens: [{ start: 0, end: durationSec + 2, text: " late" }],
      });
      return;
    case "mismatched-text":
      send({
        type: "end",
        id,
        text: "one two",
        stop: "complete",
        segments: [{ start: 0, end: 1, text: "three", speaker: 0 }],
        tokens: [{ start: 0, end: 1, text: " three" }],
      });
      return;
    case "infinite-time":
      process.stdout.write(
        `{"type":"end","id":${JSON.stringify(id)},"text":"a","stop":"complete","segments":[{"start":0,"end":1e400,"text":"a","speaker":0}],"tokens":[]}\n`,
      );
      return;
    case "untimed":
      send({ type: "end", id, text: "hello", stop: "complete", untimed: "no timestamp head" });
      return;
    default:
      send(normalEnd(id, request.chunks));
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  const id = String(message.id);
  switch (message.type) {
    case "chunk": {
      const bytes = Buffer.from(String(message.pcm), "base64").byteLength;
      const request = requests.get(id) ?? { chunks: [], answered: false };
      if (message.seq !== request.chunks.length || bytes > MAX_CHUNK_BYTES || bytes % 2 !== 0) {
        send({
          type: "error",
          id,
          error: { code: "invalid_argument", option: "seq", message: "bad chunk" },
        });
        requests.delete(id);
        return;
      }
      request.chunks.push(bytes / 2);
      requests.set(id, request);
      log({ event: "chunk", id, seq: message.seq, samples: bytes / 2 });
      return;
    }
    case "transcribe": {
      log({ event: "transcribe", id, message: { ...message } });
      const request = requests.get(id) ?? { chunks: [], answered: false };
      requests.set(id, request);
      answer(id, request);
      return;
    }
    case "cancel": {
      log({ event: "cancel", id });
      const request = requests.get(id);
      if (request === undefined || scenario === "hang") return;
      requests.delete(id);
      send({ type: "cancelled", id });
      return;
    }
  }
});
input.on("close", () => {
  log({ event: "eof" });
  if (scenario === "hang" || scenario === "slow-exit") {
    setInterval(() => undefined, 1000);
    return;
  }
  for (const [id, request] of requests) {
    if (!request.answered)
      send({
        type: "error",
        id,
        error: { code: "cancelled", option: null, message: "stdin closed" },
      });
  }
  process.exit(0);
});
