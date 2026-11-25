import { parseArgs } from "node:util";
import { startFakeHelper } from "./fake-helper";

// `fake-helper serve --socket <path> --data <dir>`, the same command line as
// `sondine-audio serve`. Like the real helper it exits when its stdin closes
// (main's lifetime pipe), on SIGTERM, or after acknowledging `shutdown`.

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { socket: { type: "string" }, data: { type: "string" } },
});
if (positionals[0] !== "serve" || values.socket === undefined || values.data === undefined) {
  console.error("usage: fake-helper serve --socket <path> --data <dir>");
  process.exit(64);
}

let exiting = false;
const exit = (reason: string) => {
  if (exiting) return;
  exiting = true;
  console.log(`[fake-helper] exit ${reason}`);
  void helper.close().finally(() => process.exit(0));
};

const helper = await startFakeHelper({
  socketPath: values.socket,
  autoplay: { commitEveryMs: 2_000, healthEveryMs: 10_000 },
  onShutdown: () => setTimeout(() => exit("shutdown"), 50),
});
console.log(
  `[fake-helper] serving ${values.socket} session ${helper.sessionId} pid ${process.pid}`,
);

process.stdin.on("end", () => exit("stdin closed"));
process.stdin.on("error", () => exit("stdin error"));
process.stdin.resume();
process.once("SIGTERM", () => exit("SIGTERM"));
process.once("SIGINT", () => exit("SIGINT"));
