// A stand-in for `llama-server` with scripted behaviours, run by Node:
//
//   node fake-llama-server.ts --scenario NAME [--log FILE] --model M --host S.sock …
//
// It answers `/health` with 503 while "loading", then 200, and streams
// `/v1/chat/completions` as server-sent events, one token per chunk, the
// last chunk carrying `timings`. Each other scenario breaks one rule.
import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  strict: false,
  options: {
    scenario: { type: "string", default: "normal" },
    log: { type: "string" },
    model: { type: "string" },
    host: { type: "string" },
    "load-ms": { type: "string", default: "100" },
  },
});
const scenario = String(values.scenario);
const logFile = typeof values.log === "string" ? values.log : undefined;
const log = (entry: object) => {
  if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
log({ event: "start", argv: process.argv.slice(2) });

if (typeof values.model !== "string" || !existsSync(values.model)) process.exit(1);
if (scenario === "exit-at-start") process.exit(3);
const socket = typeof values.host === "string" ? values.host : "";
const loadedAt = Date.now() + Number(values["load-ms"]);

const answer = JSON.stringify({
  journal: [{ text: "On a parlé du budget.", cite: [1] }],
  commitments: [],
});

const server = createServer((req, res) => {
  if (req.url === "/health") {
    const ready = scenario !== "never-ready" && Date.now() >= loadedAt;
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify(ready ? { status: "ok" } : { error: { code: 503, message: "Loading model" } }),
    );
    return;
  }
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });
  req.on("end", () => {
    log({ event: "request", body: JSON.parse(body) as unknown });
    if (scenario === "refuse") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { type: "exceed_context_size_error", message: "too long" } }),
      );
      return;
    }
    if (scenario === "crash-in-request") process.exit(9);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tokens =
      scenario === "length" ? answer.slice(0, 20).split("") : (answer.match(/.{1,8}/g) ?? []);
    let index = 0;
    let finished = false;
    // The client closing before the answer's end is a cancel.
    res.on("close", () => {
      if (!finished) log({ event: "client-gone", sent: index });
    });
    const timer = setInterval(
      () => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        if (index < tokens.length) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: tokens[index] }, finish_reason: null }] })}\n\n`,
          );
          index += 1;
          return;
        }
        clearInterval(timer);
        finished = true;
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: scenario === "length" ? "length" : "stop" }],
            timings: { prompt_n: 42, prompt_ms: 21, predicted_n: tokens.length, predicted_ms: 30 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      },
      scenario === "slow" ? 200 : 1,
    );
  });
});
server.listen(socket);
const stop = () => {
  log({ event: "sigterm" });
  if (scenario === "ignore-sigterm") return;
  server.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
