import { computeSettings, setComputeSettings } from "@sondine/db";
import { NEMOTRON_ARTIFACT, NEMOTRON_MANIFEST } from "@sondine/engines";
import { formatServerLink, generateKeyPair, respond, PROLOGUE } from "@sondine/engines/remote";
import type { Fetch, OpenReply } from "@sondine/engines/remote";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDb, type TempDb } from "../../../test/capture-fixture";
import { Database } from "../database";
import { Compute, computeLayer, type ComputeOptions, type ComputeService } from "./compute-layer";

let temp: TempDb;
beforeEach(() => {
  temp = tempDb();
});
afterEach(() => temp.cleanup());

const key = generateKeyPair();
const serverKey = key.publicKey.toString("base64url");
const token = Buffer.alloc(32, 9).toString("base64url");
const endpoint = "http://10.0.0.1:8443";

/** A server that answers every first message with `reply`; counts what it got. */
function answering(reply: OpenReply | null) {
  const asked: unknown[] = [];
  const answer: Fetch = async (_url, init) => {
    if (reply === null) throw new TypeError("down");
    const received = respond(key, init.body as Uint8Array, PROLOGUE);
    asked.push(JSON.parse(received.payload.toString()));
    const { message } = received.answer(Buffer.from(JSON.stringify(reply)));
    return new Response(new Uint8Array(message));
  };
  return { asked, fetch: answer };
}

const hello: OpenReply = {
  kind: "hello",
  modelSha256: NEMOTRON_ARTIFACT.sha256,
  engineVersion: NEMOTRON_MANIFEST.version,
  name: "atelier",
};

const compute = (options: ComputeOptions): Promise<ComputeService> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* Compute;
    }).pipe(
      Effect.provide(computeLayer(options).pipe(Layer.provide(Layer.succeed(Database, temp.db)))),
    ),
  );

describe("where transcription runs", () => {
  it("is this Mac, and asks nobody anything", async () => {
    const server = answering(hello);
    const service = await compute({ beta: { endpoint, serverKey }, fetch: server.fetch });
    expect(service.status()).toEqual({
      destination: "device",
      own: null,
      beta: { available: true, joined: false },
    });
    expect(service.engine()).toBeNull();
    expect(service.choose("own")).toBe(false);
    expect(service.choose("beta")).toBe(false);
    expect(server.asked).toEqual([]);
  });

  it("moves to the user's machine once it answered, and back, and forgets it", async () => {
    const server = answering(hello);
    const service = await compute({ beta: null, fetch: server.fetch });
    let changes = 0;
    service.onChanged(() => (changes += 1));
    const link = formatServerLink({ endpoint, serverKey, token });
    expect(await service.connect(link)).toBe("connected");
    expect(service.status()).toMatchObject({
      destination: "own",
      own: { name: "atelier", host: "10.0.0.1:8443" },
    });
    expect(JSON.stringify(service.status())).not.toContain(token);
    const engine = service.engine();
    expect(engine?.capabilities.locality).toBe("remote");
    expect(service.engine()).toBe(engine);
    service.choose("device");
    expect(service.engine()).toBeNull();
    service.choose("own");
    service.disconnect();
    expect(service.status()).toMatchObject({ destination: "device", own: null });
    expect(changes).toBe(4);
  });

  it.each([
    ["nonsense", answering(hello), "bad-link"],
    [null, answering(null), "offline"],
    [null, answering({ kind: "refused", code: "unauthorized" }), "refused"],
    [null, answering({ kind: "refused", code: "mismatch" }), "mismatch"],
    [null, answering({ ...hello, modelSha256: "0" }), "mismatch"],
    [null, answering({ ...hello, engineVersion: "1" }), "mismatch"],
  ] as const)("changes nothing when it does not connect (%#)", async (text, server, outcome) => {
    const service = await compute({ beta: null, fetch: server.fetch });
    expect(await service.connect(text ?? formatServerLink({ endpoint, serverKey, token }))).toBe(
      outcome,
    );
    expect(service.status().destination).toBe("device");
  });

  it("lets a choice made meanwhile win over a server's late answer", async () => {
    const late = (reply: OpenReply) => {
      const server = answering(reply);
      let release = () => undefined as void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const held: Fetch = async (url, init) => {
        const response = await server.fetch(url, init);
        await gate;
        return response;
      };
      return { ...server, fetch: held, release };
    };
    const machine = late(hello);
    const service = await compute({ beta: null, fetch: machine.fetch });
    const connecting = service.connect(formatServerLink({ endpoint, serverKey, token }));
    service.choose("device");
    machine.release();
    expect(await connecting).toBe("cancelled");
    expect(service.status()).toMatchObject({ destination: "device", own: null });

    const place = late({ kind: "claimed", token });
    const beta = await compute({ beta: { endpoint, serverKey }, fetch: place.fetch });
    const joining = beta.joinBeta();
    beta.choose("device");
    place.release();
    expect(await joining).toBe("cancelled");
    expect(beta.status().beta.joined).toBe(false);
    // The place nobody wants any more is given back.
    expect(place.asked).toMatchObject([{ kind: "claim" }, { kind: "leave" }]);
  });

  it("takes a beta place in one call, keeps it, and gives it back", async () => {
    const claimed = answering({ kind: "claimed", token });
    const service = await compute({ beta: { endpoint, serverKey }, fetch: claimed.fetch });
    expect(await service.joinBeta()).toBe("joined");
    expect(service.status()).toMatchObject({ destination: "beta", beta: { joined: true } });
    service.choose("device");
    // The place is still this Mac's: no second one is asked for.
    expect(await service.joinBeta()).toBe("joined");
    expect(claimed.asked).toHaveLength(1);
    await service.leaveBeta();
    expect(service.status()).toMatchObject({ destination: "device", beta: { joined: false } });
    expect(claimed.asked).toHaveLength(2);
  });

  it("says the beta is full, closed or away, and stays on this Mac", async () => {
    for (const [server, outcome] of [
      [answering({ kind: "refused", code: "full" }), "full"],
      [answering({ kind: "refused", code: "closed" }), "closed"],
      [answering(null), "offline"],
    ] as const) {
      const service = await compute({ beta: { endpoint, serverKey }, fetch: server.fetch });
      expect(await service.joinBeta()).toBe(outcome);
      expect(service.status().destination).toBe("device");
    }
    const none = await compute({ beta: null });
    expect(await none.joinBeta()).toBe("closed");
  });

  it("reads anything unclear as this Mac", () => {
    const stored = { endpoint, serverKey, token, name: "a" };
    setComputeSettings(temp.db, { destination: "own", own: stored, beta: null }, 1);
    expect(computeSettings(temp.db).destination).toBe("own");
    for (const value of ['{"destination":"own","own":null}', '{"destination":"moon"}', "[]"]) {
      temp.db.statement("UPDATE settings SET value = ? WHERE key = 'compute'").run(value);
      expect(computeSettings(temp.db).destination).toBe("device");
    }
  });
});
