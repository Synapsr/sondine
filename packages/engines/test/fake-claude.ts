// A stand-in for `claude -p` in stream-json mode, for the Claude adapter's
// tests. Its behaviour comes from FAKE_CLAUDE_MODE:
//
//   normal      answers each message with one Sondine tool call, then text
//   rogue       lists a built-in tool in its init (the tripwire must fire)
//   odd-block   answers with a content block the adapter does not know
//   stubborn    ignores interrupts
//   signed-out  initialize reports no account; a message fails to authenticate
//   old         reports an old version
//
// With --json-schema (the journal's text engine), a message gets one
// structured answer: the schema's first property, holding the message's
// length; `rogue` also offers Bash, `server` lists an MCP server, `odd-block`
// answers with an unknown block, `signed-out` fails, `stubborn` never answers.
//
// FAKE_CLAUDE_RECORD names a file that gets its arguments and whether it
// received SONDINE_TOKEN.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env["FAKE_CLAUDE_MODE"] ?? "normal";
const args = process.argv.slice(2);
const record = process.env["FAKE_CLAUDE_RECORD"];
if (record !== undefined) {
  writeFileSync(
    record,
    JSON.stringify({ args, token: process.env["SONDINE_TOKEN"] ?? null, cwd: process.cwd() }),
  );
}
const valueOf = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
};
const allowed = (valueOf("--allowedTools") ?? "").split(",").filter((name) => name !== "");
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

let turn = 0;
let interrupted = false;
let timers: NodeJS.Timeout[] = [];
const later = (ms: number, step: () => void) => timers.push(setTimeout(step, ms));

/** The journal's one-shot request: an answer through the schema's tool. */
function structured(text: string) {
  const schema = JSON.parse(valueOf("--json-schema") ?? "{}") as {
    properties?: Record<string, unknown>;
  };
  send({
    type: "system",
    subtype: "init",
    tools: mode === "rogue" ? ["StructuredOutput", "Bash"] : ["StructuredOutput"],
    mcp_servers: mode === "server" ? [{ name: "elsewhere", status: "connected" }] : [],
    model: "claude-haiku-test",
  });
  // The real CLI works on after its input closes; this one never answers.
  if (mode === "stubborn") {
    setInterval(() => undefined, 1_000);
    return;
  }
  if (mode === "signed-out") {
    send({ type: "result", subtype: "success", is_error: true, result: "Not logged in" });
    return;
  }
  const output = { [Object.keys(schema.properties ?? {})[0] ?? "value"]: text.length };
  send({
    type: "assistant",
    message: {
      content:
        mode === "odd-block"
          ? [{ type: "web_fetch_tool_result" }]
          : [{ type: "tool_use", name: "StructuredOutput", input: output }],
    },
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "tool_use",
    duration_ms: 1_200,
    duration_api_ms: 1_100,
    usage: { input_tokens: 2, cache_creation_input_tokens: 40, output_tokens: 7 },
    modelUsage: { "claude-haiku-test": {} },
    result: JSON.stringify(output),
    structured_output: output,
  });
}

function answer(text: string) {
  if (valueOf("--json-schema") !== null) {
    structured(text);
    return;
  }
  turn += 1;
  interrupted = false;
  const id = `msg_${turn}`;
  send({
    type: "system",
    subtype: "init",
    tools: mode === "rogue" ? [...allowed, "Bash"] : allowed,
    mcp_servers: allowed.length === 0 ? [] : [{ name: "sondine", status: "connected" }],
  });
  if (mode === "signed-out") {
    send({
      type: "assistant",
      message: { id, content: [{ type: "text", text: "Not logged in" }] },
      error: "authentication_failed",
    });
    send({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate" });
    return;
  }
  if (mode === "odd-block") {
    send({ type: "assistant", message: { id, content: [{ type: "web_fetch_tool_result" }] } });
    return;
  }
  send({ type: "stream_event", event: { type: "message_start", message: { id } } });
  if (allowed.length > 0) {
    send({
      type: "assistant",
      message: {
        id,
        content: [
          {
            type: "tool_use",
            id: `toolu_${turn}`,
            name: allowed[0],
            input: { text: text.slice(0, 20) },
          },
        ],
      },
    });
    send({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `toolu_${turn}`,
            content: [{ type: "text", text: "{}" }],
          },
        ],
      },
    });
  }
  const id2 = `msg_${turn}b`;
  send({ type: "stream_event", event: { type: "message_start", message: { id: id2 } } });
  for (const word of ["Vous ", "devez ", "rappeler ", "jeudi."]) {
    later(mode === "stubborn" ? 300 : 5, () => {
      if (interrupted) return;
      send({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: word } },
      });
    });
  }
  later(mode === "stubborn" ? 10_000 : 40, () => {
    if (interrupted) return;
    send({
      type: "assistant",
      message: { id: id2, content: [{ type: "text", text: "Vous devez rappeler jeudi." }] },
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Vous devez rappeler jeudi.",
    });
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as {
    type: string;
    request_id?: string;
    request?: { subtype: string };
    message?: { content: string };
  };
  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          claude_code_version: mode === "old" ? "2.0.1" : "2.1.400",
          account:
            mode === "signed-out"
              ? {}
              : {
                  email: "teo@example.com",
                  subscriptionType: "Claude Max",
                  apiProvider: "firstParty",
                },
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus",
              displayName: "Default (recommended)",
              description: "Opus",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high"],
            },
            {
              value: "opus",
              resolvedModel: "claude-opus",
              displayName: "Opus",
              description: "Opus",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high"],
            },
            {
              value: "haiku",
              resolvedModel: "claude-haiku",
              displayName: "Haiku",
              description: "Fast",
              supportsEffort: false,
            },
          ],
        },
      },
    });
    return;
  }
  if (message.type === "control_request" && message.request?.subtype === "interrupt") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id },
    });
    if (mode === "stubborn") return;
    interrupted = true;
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    send({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });
    return;
  }
  if (message.type === "user") answer(message.message?.content ?? "");
});
