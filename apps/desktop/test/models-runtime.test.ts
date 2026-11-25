import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ServiceFailure, type ModelPhase } from "@sondine/api";
import type { CatalogArtifact } from "@sondine/engines";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { FilePicker } from "../src/core/file-picker";
import { makeCoreRuntime, type CoreRuntime } from "../src/core/runtime";
import { CoreState } from "../src/core/status/core-state";
import { captureOptions, recordingMain, tempDataDir, waitUntil } from "./support";

// The models API through the real core runtime: the open panel round trip
// through main, the watch stream, and the analysis status listing what is
// installed. A local server on 127.0.0.1 stands for Hugging Face.

const content = randomBytes(1024 * 1024 + 3);
const sha256 = createHash("sha256").update(content).digest("hex");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    const t = Date.now();
    await cleanup();
    console.log("cleanup", Date.now() - t, cleanup.toString().slice(0, 60));
  }
});

async function serve(): Promise<string> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": content.byteLength }).end(content);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const testArtifact = (artifactId: string, url: string): CatalogArtifact => ({
  artifactId,
  version: "abc1234",
  label: "Test model",
  fileName: "model.gguf",
  url,
  sizeBytes: content.byteLength,
  sha256,
  license: { id: "MIT", text: "MIT License\n", sha256: "", url: "https://example.invalid/LICENSE" },
  notices: "Copyright (c) Test\n",
  distribution: "user-download",
  minimumMemoryBytes: 0,
  knownLocations: [],
  role: "final",
});

async function setup() {
  const data = tempDataDir();
  cleanups.push(() => data.cleanup());
  const origin = await serve();
  const main = recordingMain();
  const runtime = makeCoreRuntime(data.config(), main, {
    ...captureOptions(data),
    spans: { flushEvery: "1 seconds" },
    models: {
      homeDir: data.dir,
      catalog: [
        testArtifact("picked-model", `${origin}/picked.gguf`),
        testArtifact("downloaded-model", `${origin}/downloaded.gguf`),
      ],
      policy: {
        protocols: ["http:"],
        hosts: { "127.0.0.1": [{ host: "127.0.0.1" }] },
        maxRedirects: 1,
      },
      freeBytes: () => 1e15,
    },
  });
  cleanups.push(() => runtime.dispose());
  return { data, main, runtime, api: await runtime.runPromise(Api) };
}

const status = (runtime: CoreRuntime) =>
  runtime.runPromise(Effect.flatMap(CoreState, (state) => SubscriptionRef.get(state.status)));

describe("models through core", () => {
  it("asks main for an open panel and imports the file the user picked", async () => {
    const { data, main, runtime, api } = await setup();
    // "verifying" while the launch check looks at the models folder.
    await waitUntil(async () =>
      (await api.models.status()).artifacts.every((artifact) => artifact.phase === "missing"),
    );
    const path = join(data.dir, "chosen.gguf");
    writeFileSync(path, content);

    const picking = api.models.pick({ artifactId: "picked-model" });
    const request = await waitUntil(() =>
      main.posted.find((message) => message.type === "pick-file"),
    );
    expect(request).toMatchObject({ purpose: "model", label: "Test model", extensions: ["gguf"] });
    if (request.type !== "pick-file") throw new Error("not a pick request");
    const picker = await runtime.runPromise(FilePicker);
    picker.receive(request.requestId, path);
    expect((await picking).outcome).toBe("importing");

    await waitUntil(async () => (await api.models.status()).artifacts[0]?.phase === "ready", {
      label: "imported",
    });
    // The analysis status lists it: the queue looked again at once.
    await waitUntil(async () => (await status(runtime)).analysis.models.length === 1, {
      label: "analysis models",
    });
    expect((await status(runtime)).analysis.models).toEqual([
      { artifactId: "picked-model", version: "abc1234", verified: true },
    ]);
  });

  it("streams a download's phases until it is ready", async () => {
    const { api } = await setup();
    const controller = new AbortController();
    const phases: ModelPhase[] = [];
    await api.models.download({ artifactId: "downloaded-model" });
    for await (const next of api.models.watch(controller.signal)) {
      const phase = next.artifacts[1]?.phase;
      if (phase !== undefined && phases.at(-1) !== phase) phases.push(phase);
      if (phase === "ready") controller.abort();
    }
    expect(phases.at(-1)).toBe("ready");
    expect(phases.every((phase) => ["downloading", "verifying", "ready"].includes(phase))).toBe(
      true,
    );
  });

  it("answers an unknown artifact with not-found", async () => {
    const { api } = await setup();
    await expect(api.models.download({ artifactId: "whisper" })).rejects.toBeInstanceOf(
      ServiceFailure,
    );
    await expect(api.models.import({ artifactId: "picked-model" })).rejects.toMatchObject({
      code: "not-found",
    });
  });
});
