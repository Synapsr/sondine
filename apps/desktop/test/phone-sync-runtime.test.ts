import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, phoneDevice, type Database as Db } from "@sondine/db";
import {
  parsePairingUrl,
  phoneAudioPath,
  PHONE_OFFSET_HEADER,
  PAIRING_ANSWER_MS,
} from "@sondine/protocol";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";
import type { PhoneExpectation, PhoneReceipt } from "../src/core/imports/imports-layer";
import { CoreState } from "../src/core/status/core-state";
import { DATA_LAYOUT } from "../src/shared/data-layout";
import {
  announce,
  api,
  cleanups,
  database,
  openPairing,
  pairPhone,
  phoneFile,
  put,
  remove,
  send,
  setup,
  sha,
  states,
  sync,
  upload,
  type Phone,
  type Setup,
} from "./phone-support";
import { waitUntil } from "./support";

// Phone sync through the real core (ADR 008, plan § M5.2), with the fake
// relay and the phone of `phone-support.ts`.

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const phoneRows = (db: Db) =>
  db
    .statement(
      "SELECT recording_id, device_id, state, sha256 FROM phone_recordings ORDER BY recording_id",
    )
    .all();

const episodesOf = (db: Db) =>
  Number(db.statement("SELECT count(*) AS n FROM episodes").get()?.["n"]);

const StatesBody = z.object({
  states: z.array(z.object({ recordingId: z.string(), state: z.string() })),
});
const stateOf = async (s: Setup, phone: Phone, recordingId: string) =>
  StatesBody.parse((await states(s, phone, [recordingId])).body).states[0]?.state;

describe("phone sync in core", () => {
  it("listens only while a pairing is open or a phone is paired, and the switch is on", async () => {
    const s = setup();
    const services = await api(s);
    expect((await services.phone.status()).relay.phase).toBe("off");
    await services.phone.setEnabled({ enabled: true });
    expect(existsSync(s.socketPath)).toBe(false);
    expect(s.relay.runs).toHaveLength(0);

    // A pairing left unanswered for 2 minutes closes, and the port with it.
    const invite = await openPairing(s);
    expect(s.relay.running()).toBe(1);
    expect(s.relay.runs[0]?.args).toEqual(
      expect.arrayContaining(["serve", "--socket", s.socketPath, "--allow-loopback"]),
    );
    expect(statSync(s.socketPath).mode & 0o777).toBe(0o600);
    const lan = join(s.data.dir, DATA_LAYOUT.lanDir);
    expect(statSync(lan).mode & 0o777).toBe(0o700);
    const held = send(s.socketPath, {
      path: "/v1/pair",
      body: { v: 1, token: invite.token, deviceId: randomUUID(), deviceName: "iPhone" },
    });
    await waitUntil(async () => (await services.phone.status()).pairing?.phase === "asked");
    s.clock.advance(PAIRING_ANSWER_MS);
    expect((await held).body).toEqual({ error: "pairing-closed" });
    await waitUntil(() => s.relay.running() === 0 && !existsSync(s.socketPath), {
      label: "nothing listens",
    });

    // A phone paired keeps it listening, until sync is turned off.
    await pairPhone(s);
    expect(s.relay.running()).toBe(1);
    expect(s.relay.runs.at(-1)?.args.join(" ")).toContain("--port 49321");
    await services.phone.setEnabled({ enabled: false });
    await waitUntil(() => s.relay.running() === 0, { label: "the relay stops" });
    expect(existsSync(s.socketPath)).toBe(false);
  });

  it("refuses a used, an expired, a second phone's or a Tailscale pairing", async () => {
    const s = setup();
    const services = await api(s);
    await services.phone.setTailnet({ enabled: true });
    const invite = await openPairing(s);
    const tailnet = await send(s.socketPath, {
      path: "/v1/pair",
      via: "tailnet",
      body: { v: 1, token: invite.token, deviceId: randomUUID(), deviceName: "iPhone" },
    });
    expect([tailnet.status, tailnet.body]).toEqual([403, { error: "pairing-tailnet" }]);
    const version = await send(s.socketPath, {
      path: "/v1/pair",
      body: { v: 3, token: invite.token, deviceId: randomUUID(), deviceName: "iPhone" },
    });
    expect(version.body).toEqual({ error: "version", macVersion: 2 });

    // Two phones scan one QR: one pairs.
    const first = send(s.socketPath, {
      path: "/v1/pair",
      body: { v: 1, token: invite.token, deviceId: randomUUID(), deviceName: "Premier" },
    });
    await waitUntil(async () => (await services.phone.status()).pairing?.phase === "asked");
    const second = await send(s.socketPath, {
      path: "/v1/pair",
      body: { v: 1, token: invite.token, deviceId: randomUUID(), deviceName: "Second" },
    });
    expect([second.status, second.body]).toEqual([409, { error: "pairing-used" }]);
    await services.phone.answer({ accept: true });
    expect((await first).status).toBe(200);
    const again = await send(s.socketPath, {
      path: "/v1/pair",
      body: { v: 1, token: invite.token, deviceId: randomUUID(), deviceName: "Encore" },
    });
    expect(again.body).toEqual({ error: "pairing-used" });
    expect((await services.phone.status()).phones.map((phone) => phone.name)).toEqual(["Premier"]);

    const late = await openPairing(s);
    s.clock.advance(5 * 60_000);
    const expired = await send(s.socketPath, {
      path: "/v1/pair",
      body: { v: 1, token: late.token, deviceId: randomUUID(), deviceName: "Tard" },
    });
    expect(expired.body).toEqual({ error: "pairing-closed" });

    // « Annuler » on the Mac.
    const refused = await openPairing(s);
    const asking = send(s.socketPath, {
      path: "/v1/pair",
      body: { v: 1, token: refused.token, deviceId: randomUUID(), deviceName: "Non" },
    });
    await waitUntil(async () => (await services.phone.status()).pairing?.phase === "asked");
    await services.phone.answer({ accept: false });
    expect((await asking).body).toEqual({ error: "pairing-refused" });
  });

  it("resumes a cut transfer, keeps one recording for one sent twice, and refuses other bytes under its id", async () => {
    const s = setup();
    const phone = await pairPhone(s);
    const db = await database(s);
    const recordingId = randomUUID();
    const file = phoneFile(phone, recordingId);
    expect(upload(await announce(s, phone, recordingId, file))).toEqual({
      status: "send",
      offset: 0,
    });

    // Cut at half: the connection drops in the middle of the body.
    const half = Math.floor(file.length / 2);
    await new Promise<void>((resolve) => {
      const socket = connect(s.socketPath);
      socket.write(`${JSON.stringify({ v: 1, via: "lan", peer: "192.168.1.20" })}\n`);
      socket.write(
        `PUT ${phoneAudioPath(recordingId)} HTTP/1.1\r\nhost: mac\r\nauthorization: Bearer ${phone.credential}\r\n${PHONE_OFFSET_HEADER}: 0\r\ncontent-length: ${file.length}\r\n\r\n`,
      );
      socket.write(file.subarray(0, half), () => {
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 50);
      });
    });
    const resumed = await waitUntil(
      async () => {
        const answer = upload(await announce(s, phone, recordingId, file));
        return answer.status === "send" && answer.offset === half ? answer : null;
      },
      { label: "the half is held" },
    );
    expect(await stateOf(s, phone, recordingId)).toBe("receiving");
    // A byte that does not continue the part is refused.
    expect(upload(await put(s, phone, recordingId, file.subarray(10), 10))).toEqual({
      status: "refused",
      reason: "offset",
    });
    expect(
      upload(await put(s, phone, recordingId, file.subarray(resumed.offset), resumed.offset)),
    ).toEqual({ status: "stored" });
    expect(phoneRows(db)).toEqual([
      { recording_id: recordingId, device_id: phone.deviceId, state: "stored", sha256: sha(file) },
    ]);
    expect(episodesOf(db)).toBe(1);
    expect(readdirSync(join(s.data.dir, DATA_LAYOUT.phoneInboxDir))).toEqual([]);
    expect(await stateOf(s, phone, recordingId)).toBe("waiting");

    // Sent twice: one recording.
    expect(upload(await announce(s, phone, recordingId, file))).toEqual({ status: "stored" });
    expect(episodesOf(db)).toBe(1);
    // The same id with other bytes: a conflict, the phone keeps its file.
    const other = phoneFile(phone, recordingId, 3, 20);
    expect(upload(await announce(s, phone, recordingId, other))).toEqual({ status: "conflict" });
    expect(episodesOf(db)).toBe(1);
    expect(phoneDevice(db, phone.deviceId)).toMatchObject({ uploads: 1 });
  });

  it("answers stored only once the recording survives a kill", async () => {
    const s = setup();
    const phone = await pairPhone(s);
    const recordingId = randomUUID();
    expect(await sync(s, phone, recordingId, phoneFile(phone, recordingId))).toEqual({
      status: "stored",
    });
    // What a kill leaves: the database and its WAL as they are on disk now.
    const crash = mkdtempSync(join(tmpdir(), "sondine-crash-"));
    cleanups.push(() => rmSync(crash, { recursive: true, force: true }));
    for (const suffix of ["", "-wal"]) {
      const source = join(s.data.dir, `${DATA_LAYOUT.database}${suffix}`);
      if (existsSync(source)) copyFileSync(source, join(crash, `sondine.db${suffix}`));
    }
    const reopened = openDatabase(join(crash, "sondine.db"), {
      migrationsFolder: s.data.config().migrationsDir,
    });
    cleanups.push(() => reopened.close());
    expect(phoneRows(reopened)).toMatchObject([{ recording_id: recordingId, state: "stored" }]);
    const archived = reopened
      .statement("SELECT archive_rel_path FROM chunks WHERE audio_state = 'archived' LIMIT 1")
      .get();
    expect(existsSync(join(s.data.dir, String(archived?.["archive_rel_path"])))).toBe(true);
  });

  it("refuses a wrong hash, a header naming another recording, a file too large or no room", async () => {
    const s = setup({ limits: { inboxBytes: 1_000_000 } });
    const phone = await pairPhone(s);
    const db = await database(s);
    const recordingId = randomUUID();
    const file = phoneFile(phone, recordingId);
    const wrong = Buffer.from(file);
    wrong[wrong.length - 1] = (wrong.at(-1) ?? 0) ^ 0xff;
    await announce(s, phone, recordingId, file);
    expect(upload(await put(s, phone, recordingId, wrong, 0))).toEqual({
      status: "refused",
      reason: "hash",
    });
    // The part was discarded: it starts again from zero.
    expect(upload(await announce(s, phone, recordingId, file))).toEqual({
      status: "send",
      offset: 0,
    });

    const elsewhere = randomUUID();
    const misnamed = phoneFile(phone, recordingId);
    expect(await sync(s, phone, elsewhere, misnamed)).toEqual({
      status: "refused",
      reason: "header",
    });
    expect(
      upload(
        await send(s.socketPath, {
          path: "/v1/recordings/announce",
          credential: phone.credential,
          body: { recordingId: randomUUID(), bytes: 2 ** 30 + 1, sha256: "a".repeat(64) },
        }),
      ),
    ).toEqual({ status: "refused", reason: "too-large" });
    expect(
      upload(
        await send(s.socketPath, {
          path: "/v1/recordings/announce",
          credential: phone.credential,
          body: { recordingId: randomUUID(), bytes: 999_000, sha256: "a".repeat(64) },
        }),
      ),
    ).toEqual({ status: "refused", reason: "no-room" });
    expect(phoneRows(db)).toEqual([]);
  });

  it("runs the Mac's deletion for a phone's, once per operation, and leaves a tombstone for what never came", async () => {
    const s = setup();
    const phone = await pairPhone(s);
    const db = await database(s);
    const state = await s.runtime.runPromise(CoreState);
    const deletionsBefore = (await Effect.runPromise(SubscriptionRef.get(state.status))).deletions;
    const recordingId = randomUUID();
    await sync(s, phone, recordingId, phoneFile(phone, recordingId));
    expect(episodesOf(db)).toBe(1);
    const operationId = randomUUID();
    expect((await remove(s, phone, recordingId, operationId)).body).toEqual({ status: "deleted" });
    expect(episodesOf(db)).toBe(0);
    expect(phoneRows(db)).toMatchObject([
      { recording_id: recordingId, state: "deleted", sha256: null },
    ]);
    // The window heard of it as of « Supprimer ».
    expect((await Effect.runPromise(SubscriptionRef.get(state.status))).deletions).toBe(
      deletionsBefore + 1,
    );
    // The outbox sends it again: nothing more happens.
    expect((await remove(s, phone, recordingId, operationId)).body).toEqual({ status: "deleted" });
    expect(phoneDevice(db, phone.deviceId)).toMatchObject({ deletions: 1 });
    expect(await stateOf(s, phone, recordingId)).toBe("deleted");
    expect(upload(await announce(s, phone, recordingId, phoneFile(phone, recordingId)))).toEqual({
      status: "deleted",
    });

    // Deleted on the phone before it was sent: refused when it comes later.
    const never = randomUUID();
    expect((await remove(s, phone, never)).body).toEqual({ status: "deleted" });
    expect(await sync(s, phone, never, phoneFile(phone, never))).toEqual({ status: "deleted" });

    // Deleted on the Mac: the phone reads deleted.
    const kept = randomUUID();
    await sync(s, phone, kept, phoneFile(phone, kept));
    const episodeId = Number(db.statement("SELECT id FROM episodes LIMIT 1").get()?.["id"]);
    await (await api(s)).episodes.delete({ episodeId });
    expect(await stateOf(s, phone, kept)).toBe("deleted");
  });

  it("never keeps a recording deleted while its upload is imported, in either order", async () => {
    let around:
      | ((
          path: string,
          expected: PhoneExpectation,
          imported: (path: string, expected: PhoneExpectation) => Promise<PhoneReceipt>,
        ) => Promise<PhoneReceipt>)
      | null = null;
    const s = setup({
      receive: (path, expected, imported) =>
        around === null ? imported(path, expected) : around(path, expected, imported),
    });
    const phone = await pairPhone(s);
    const db = await database(s);

    // The deletion lands first, while the file is on its way to the import.
    const first = randomUUID();
    around = async (path, expected, imported) => {
      expect((await remove(s, phone, first)).body).toEqual({ status: "deleted" });
      return imported(path, expected);
    };
    expect(await sync(s, phone, first, phoneFile(phone, first))).toEqual({ status: "deleted" });
    expect(episodesOf(db)).toBe(0);

    // The import publishes first, then the deletion.
    const second = randomUUID();
    around = async (path, expected, imported) => {
      const receipt = await imported(path, expected);
      expect((await remove(s, phone, second)).body).toEqual({ status: "deleted" });
      return receipt;
    };
    expect(await sync(s, phone, second, phoneFile(phone, second))).toEqual({ status: "stored" });
    expect(episodesOf(db)).toBe(0);
    expect(phoneRows(db).map((row) => row["state"])).toEqual(["deleted", "deleted"]);
    // No audio of either is left: the first never published, the second's chunks were deleted.
    expect(
      Number(
        db
          .statement(
            "SELECT count(*) AS n FROM chunks WHERE audio_state IN ('present', 'archived')",
          )
          .get()?.["n"],
      ),
    ).toBe(0);
  });

  it("keeps each phone to its own recordings", async () => {
    const s = setup();
    const mine = await pairPhone(s, randomUUID(), "Le mien");
    const theirs = await pairPhone(s, randomUUID(), "L'autre");
    const recordingId = randomUUID();
    const file = phoneFile(mine, recordingId);
    await sync(s, mine, recordingId, file);
    const refused = await announce(s, theirs, recordingId, file);
    expect([refused.status, refused.body]).toEqual([403, { error: "not-yours" }]);
    expect((await put(s, theirs, recordingId, file, 0)).body).toEqual({ error: "not-yours" });
    expect((await remove(s, theirs, recordingId)).body).toEqual({ error: "not-yours" });
    expect(await stateOf(s, theirs, recordingId)).toBe("unknown");
    expect(await stateOf(s, mine, recordingId)).toBe("waiting");
    // Its header names the other phone: refused, whoever sends it.
    const forged = randomUUID();
    expect(await sync(s, theirs, forged, phoneFile(mine, forged))).toEqual({
      status: "refused",
      reason: "header",
    });
  });

  it("closes a revoked phone's connections at once and answers revoked after", async () => {
    const s = setup();
    const phone = await pairPhone(s);
    // Another phone keeps the Mac listening.
    const other = await pairPhone(s);
    const services = await api(s);
    // An upload under way, held open by a body that never ends.
    const recordingId = randomUUID();
    const file = phoneFile(phone, recordingId);
    await announce(s, phone, recordingId, file);
    const closed = new Promise<void>((resolve) => {
      const socket = connect(s.socketPath);
      socket.write(`${JSON.stringify({ v: 1, via: "lan", peer: "192.168.1.20" })}\n`);
      socket.write(
        `PUT ${phoneAudioPath(recordingId)} HTTP/1.1\r\nhost: mac\r\nauthorization: Bearer ${phone.credential}\r\n${PHONE_OFFSET_HEADER}: 0\r\ncontent-length: ${file.length}\r\n\r\n`,
      );
      socket.write(file.subarray(0, 100));
      socket.on("close", () => resolve());
    });
    await waitUntil(async () => (await stateOf(s, phone, recordingId)) === "receiving");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await services.phone.revoke({ deviceId: phone.deviceId });
    await closed;
    const after = await states(s, phone, [recordingId]);
    expect([after.status, after.body]).toEqual([401, { error: "revoked" }]);
    const listed = (await services.phone.status()).phones;
    expect(listed.find((entry) => entry.deviceId === phone.deviceId)?.revokedAtMs).not.toBeNull();
    expect((await states(s, other, [])).status).toBe(200);
    // The last phone revoked: the Mac listens until it has heard `revoked`,
    // so it does not keep showing a Mac it can no longer reach.
    await services.phone.revoke({ deviceId: other.deviceId });
    expect(existsSync(s.socketPath)).toBe(true);
    expect(s.relay.running()).toBe(1);
    const told = await states(s, other, []);
    expect([told.status, told.body]).toEqual([401, { error: "revoked" }]);
    await waitUntil(() => !existsSync(s.socketPath) && s.relay.running() === 0, {
      label: "closed once told",
    });

    // One that never comes back: the Mac stops waiting after a day.
    const third = await pairPhone(s);
    await services.phone.revoke({ deviceId: third.deviceId });
    expect(existsSync(s.socketPath)).toBe(true);
    s.clock.advance(24 * 3_600_000);
    await services.phone.setEnabled({ enabled: true });
    await waitUntil(() => !existsSync(s.socketPath), { label: "closed after a day" });
  });

  it("forgets the Mac at a phone's request", async () => {
    const s = setup();
    const phone = await pairPhone(s);
    const other = await pairPhone(s);
    const forgotten = await send(s.socketPath, {
      path: "/v1/forget",
      credential: phone.credential,
      body: {},
    });
    expect(forgotten.body).toEqual({ status: "forgotten" });
    expect((await states(s, phone, [])).body).toEqual({ error: "revoked" });
    expect((await states(s, other, [])).status).toBe(200);
  });

  it("lets a paired phone sync while every slot is held by connections that never authenticate", async () => {
    const s = setup({ limits: { maxConnections: 4 } });
    const phone = await pairPhone(s);
    const strangers = Array.from({ length: 6 }, (_, index) => {
      const socket = connect(s.socketPath);
      // Some say the relay's line and stop, some say nothing.
      if (index % 2 === 0)
        socket.write(`${JSON.stringify({ v: 1, via: "lan", peer: "192.168.1.66" })}\n`);
      socket.on("error", () => undefined);
      return socket;
    });
    cleanups.push(() => strangers.forEach((socket) => socket.destroy()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    const answer = await states(s, phone, []);
    expect(answer.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(60_000);
  });

  it("closes a pairing request whose body trickles in, however often its bytes come", async () => {
    const s = setup({ limits: { pairBodyMs: 400, bodyIdleMs: 60_000 } });
    await (await api(s)).phone.pair();
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const socket = connect(s.socketPath);
      socket.on("error", () => undefined);
      socket.write(`${JSON.stringify({ v: 1, via: "lan", peer: "192.168.1.66" })}\n`);
      socket.write("POST /v1/pair HTTP/1.1\r\nhost: mac\r\ncontent-length: 200\r\n\r\n{");
      const drip = setInterval(() => socket.write(" "), 50);
      socket.on("close", () => {
        clearInterval(drip);
        resolve();
      });
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses a peer for a minute after five wrong credentials, and reads the credential before the body", async () => {
    const s = setup();
    const phone = await pairPhone(s);
    const wrong = `sdp_${"B".repeat(43)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const answer = await send(s.socketPath, {
        path: "/v1/recordings/states",
        credential: wrong,
        peer: "192.168.1.66",
        body: { recordingIds: [] },
      });
      expect([answer.status, answer.body]).toEqual([401, { error: "unauthorized" }]);
    }
    const blocked = await send(s.socketPath, {
      path: "/v1/recordings/states",
      credential: phone.credential,
      peer: "192.168.1.66",
      body: { recordingIds: [] },
    });
    expect([blocked.status, blocked.body]).toEqual([429, { error: "busy" }]);
    expect((await states(s, phone, [])).status).toBe(200);
    s.clock.advance(60_000);
    expect(
      (
        await send(s.socketPath, {
          path: "/v1/recordings/states",
          credential: phone.credential,
          peer: "192.168.1.66",
          body: { recordingIds: [] },
        })
      ).status,
    ).toBe(200);

    // A huge upload with no credential is refused from its headers alone.
    const refused = await new Promise<string>((resolve) => {
      const socket = connect(s.socketPath);
      let text = "";
      socket.write(`${JSON.stringify({ v: 1, via: "lan", peer: "192.168.1.77" })}\n`);
      socket.write(
        `PUT ${phoneAudioPath(randomUUID())} HTTP/1.1\r\nhost: mac\r\n${PHONE_OFFSET_HEADER}: 0\r\ncontent-length: 1000000000\r\n\r\n`,
      );
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(text));
    });
    expect(refused).toMatch(/^HTTP\/1\.1 401/);
    expect(refused).toContain('{"error":"unauthorized"}');
    // Headers over 8 KiB.
    const big = await send(s.socketPath, {
      path: "/v1/recordings/states",
      credential: phone.credential,
      headers: { "x-padding": "a".repeat(9_000) },
      body: { recordingIds: [] },
    }).catch(() => ({ status: 431, body: null, headers: {} }));
    expect(big.status).toBe(431);
    // A JSON body over 1 MiB.
    const huge = await send(s.socketPath, {
      path: "/v1/recordings/states",
      credential: phone.credential,
      bytes: Buffer.alloc(1_100_000, 0x20),
    }).catch(() => ({ status: 0, body: null, headers: {} }));
    expect(huge.status === 400 || huge.status === 0).toBe(true);
  });

  it("takes a phone through Tailscale only while the switch is on, and says which path it came by", async () => {
    const s = setup({ addresses: () => ["192.168.1.10", "100.88.10.20"] });
    const services = await api(s);
    const phone = await pairPhone(s);
    const tailnetPeer = { via: "tailnet" as const, peer: "100.101.102.103" };
    const hello = (via: { via: "lan" | "tailnet"; peer: string }, credential = phone.credential) =>
      send(s.socketPath, {
        path: "/v1/hello",
        credential,
        body: { v: 1, clockMs: Date.now(), recordingIds: [] },
        ...via,
      });
    const lastVia = async () => (await services.phone.status()).phones[0]?.lastVia;

    // At home: no `via` key (a phone built before M5.5 reads no other), and the path is kept.
    const home = await hello({ via: "lan", peer: "192.168.1.20" });
    expect(home.status).toBe(200);
    expect(home.body).not.toHaveProperty("via");
    expect(await lastVia()).toBe("lan");

    // Switch off (the default): core closes what the relay says came through Tailscale.
    expect((await services.phone.status()).tailnet).toBe(false);
    expect(s.relay.runs.at(-1)?.args).not.toContain("--tailnet");
    await expect(hello(tailnetPeer)).rejects.toThrow();
    expect(await lastVia()).toBe("lan");

    // On: the relay starts again with --tailnet, and a paired phone syncs and reads.
    await services.phone.setTailnet({ enabled: true });
    await waitUntil(() => s.relay.runs.at(-1)?.args.includes("--tailnet") === true, {
      label: "the relay with --tailnet",
    });
    const away = await hello(tailnetPeer);
    expect([away.status, away.body]).toEqual([
      200,
      expect.objectContaining({ via: "tailnet", addrs: ["192.168.1.10", "100.88.10.20"] }),
    ]);
    expect(await lastVia()).toBe("tailnet");
    const recordingId = randomUUID();
    const file = phoneFile(phone, recordingId);
    const announced = await send(s.socketPath, {
      path: "/v1/recordings/announce",
      credential: phone.credential,
      body: { recordingId, bytes: file.length, sha256: sha(file) },
      ...tailnetPeer,
    });
    expect(announced.body).toEqual({ status: "send", offset: 0 });
    const sent = await send(s.socketPath, {
      method: "PUT",
      path: phoneAudioPath(recordingId),
      credential: phone.credential,
      headers: { [PHONE_OFFSET_HEADER]: "0" },
      bytes: file,
      ...tailnetPeer,
    });
    expect(sent.body).toEqual({ status: "stored" });
    const read = await send(s.socketPath, {
      path: "/v1/recordings/states",
      credential: phone.credential,
      body: { recordingIds: [recordingId] },
      ...tailnetPeer,
    });
    expect(read.body).toEqual({
      states: [{ recordingId, state: expect.stringMatching(/^(waiting|transcribing|ready)$/) }],
    });
    // An unpaired phone is refused there as at home.
    const stranger = await hello(tailnetPeer, `sdp_${"B".repeat(43)}`);
    expect([stranger.status, stranger.body]).toEqual([401, { error: "unauthorized" }]);

    // Off again: a connection that came through Tailscale closes at once, and the next is refused.
    const held = connect(s.socketPath);
    const closed = new Promise<void>((resolve) => held.once("close", () => resolve()));
    held.on("error", () => held.destroy());
    held.write(`${JSON.stringify({ v: 1, ...tailnetPeer })}\n`);
    held.write("POST /v1/hello HTTP/1.1\r\nhost: mac\r\n");
    await waitUntil(() => s.relay.running() === 1, { label: "the relay" });
    await services.phone.setTailnet({ enabled: false });
    await closed;
    await expect(hello(tailnetPeer)).rejects.toThrow();
    expect((await hello({ via: "lan", peer: "192.168.1.20" })).status).toBe(200);
    expect(await lastVia()).toBe("lan");
  });

  it("answers hello with the Mac's id, port and limits; reset revokes every phone and makes a new key", async () => {
    const s = setup({ addresses: () => ["192.168.1.10"] });
    const phone = await pairPhone(s);
    const hello = await send(s.socketPath, {
      path: "/v1/hello",
      credential: phone.credential,
      body: { v: 1, clockMs: Date.now(), recordingIds: [] },
    });
    expect(hello.body).toMatchObject({
      v: 1,
      addrs: ["192.168.1.10"],
      port: 49_321,
      maxFileBytes: 2 ** 30,
    });
    // A version 2 phone is answered in version 2 from then on (ADR 039).
    const second = await send(s.socketPath, {
      path: "/v1/hello",
      credential: phone.credential,
      body: { v: 2, clockMs: Date.now(), recordingIds: [] },
    });
    expect(second.body).toMatchObject({ v: 2 });
    const tooNew = await send(s.socketPath, {
      path: "/v1/hello",
      credential: phone.credential,
      body: { v: 3, clockMs: Date.now(), recordingIds: [] },
    });
    expect(tooNew.body).toEqual({ error: "version", macVersion: 2 });
    const services = await api(s);
    const before = parsePairingUrl((await services.phone.pair()).pairing?.url ?? "")?.pin;
    await services.phone.reset();
    expect(
      (await services.phone.status()).phones.every((entry) => entry.revokedAtMs !== null),
    ).toBe(true);
    await waitUntil(() => !existsSync(s.socketPath), { label: "closed" });
    const after = parsePairingUrl((await services.phone.pair()).pairing?.url ?? "")?.pin;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect((await states(s, phone, [])).body).toEqual({ error: "revoked" });
  });
});
