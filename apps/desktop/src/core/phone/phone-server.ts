import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { PHONE_PROCEDURES, type PhoneProcedure } from "@sondine/api";
import {
  listPhoneUploads,
  phoneArrival,
  phoneDevice,
  phoneDeviceByCredential,
  phoneInboxBytes,
  phoneOperationDone,
  phoneRecordingEpisode,
  phoneRecordingOwner,
  phoneRecordingReadings,
  phoneUpload,
  putPhoneUpload,
  recordPhoneOperation,
  removePhoneUpload,
  renamePhoneRecording,
  revokePhoneDevice,
  tombstoneStoredPhoneRecording,
  tombstoneUnreceivedPhoneRecording,
  setPhoneSyncVersion,
  touchPhoneDevice,
  durableTransaction,
  type Database,
  type PhoneDevice,
  type PhoneUpload,
} from "@sondine/db";
import {
  MAX_PHONE_FILE_BYTES,
  MAX_PHONE_JSON_BYTES,
  MAX_PHONE_MEMORY_BYTES,
  PHONE_CREDENTIAL_PATTERN,
  PHONE_OFFSET_HEADER,
  PHONE_AUDIO_TYPE,
  PHONE_ALL_ROUTES,
  PHONE_MEMORY_ROUTES,
  PHONE_ROUTES,
  PHONE_SYNC_OLDEST,
  PHONE_SYNC_VERSION,
  PhoneRelayHello,
  Uuid,
  type GetAnswer,
  type HelloAnswer,
  type PhoneErrorCode,
  type PhoneMemoryRoute,
  type UploadStatus,
} from "@sondine/protocol";
import type * as z from "zod";
import { parseRangeHeader } from "../../shared/byte-range";
import type { MediaReadRequest } from "../../shared/core-messages";
import type { MediaReadReply } from "../audio/episode-media";
import type { PhoneExpectation, PhoneReceipt } from "../imports/imports-layer";
import { log } from "../log";
import type { PairingClock, PairingDesk } from "./pairing";
import type { PhoneMemoryReads } from "./phone-memory";

// Core's HTTP/1.1 server for paired phones (ADR 008), on `run/phone.sock`.
// `sondine-lan` holds the TCP port and TLS; it relays each accepted
// connection here after one JSON line saying how the peer came
// (`PhoneRelayHello`). Every route but pairing carries the phone's
// credential, checked from the headers before a byte of body is read; the
// device is the one its credential names, never one a request does. The
// routes are `PHONE_PROCEDURES`, and nothing else reaches a phone.
//
// An upload goes to `phone-inbox/<id>.part`, resumed at the byte the Mac
// holds; with its last byte the Mac checks the SHA-256 the phone announced
// and hands the file to the import, whose last transaction is durable:
// `stored` is answered after it. A recording's result (`get`), its name and
// a note (M5.3) go through the Mac's own reads and writes; its playback is
// the episode's WAV, read by slices as the window's player reads it, and
// streamed, never kept. The reads of the Mac's memory (M5.4) run the
// procedures agents' tools run (`phone-memory.ts`), each counted as a read.
// Logs say what happened, never a phone's or a recording's id, nor words.

export interface PhoneLimits {
  /** A connection's relay line, then each request's headers, must arrive within this. */
  readonly headersMs: number;
  /** Header bytes of one request. */
  readonly maxHeaderBytes: number;
  /** A body with no byte for this long is dropped. */
  readonly bodyIdleMs: number;
  /**
   * A pairing request's whole body, from its headers: it comes before any
   * credential, so a byte now and then cannot hold a slot of the relay.
   */
  readonly pairBodyMs: number;
  /** An idle connection between requests closes after this. */
  readonly keepAliveMs: number;
  readonly maxJsonBytes: number;
  readonly maxFileBytes: number;
  /** What the inbox may hold in all (announced lengths). */
  readonly inboxBytes: number;
  /** Room kept free on the disk beyond an upload. */
  readonly diskMarginBytes: number;
  /** Connections at once; a new one evicts the oldest that has not authenticated. */
  readonly maxConnections: number;
  /** Wrong credentials before a peer address is refused, and for how long. */
  readonly wrongCredentials: number;
  readonly blockMs: number;
  /** While an answer is held (pairing, an import), `102 Processing` this often, so the relay sees bytes. */
  readonly keepaliveMs: number;
  /** A part untouched this long is removed. */
  readonly partKeptMs: number;
}

export const PHONE_LIMITS: PhoneLimits = {
  headersMs: 10_000,
  maxHeaderBytes: 8 * 1024,
  bodyIdleMs: 30_000,
  pairBodyMs: 10_000,
  keepAliveMs: 15_000,
  maxJsonBytes: MAX_PHONE_JSON_BYTES,
  maxFileBytes: MAX_PHONE_FILE_BYTES,
  inboxBytes: 2 * 1024 ** 3,
  diskMarginBytes: 512 * 1024 ** 2,
  maxConnections: 16,
  wrongCredentials: 5,
  blockMs: 60_000,
  keepaliveMs: 20_000,
  partKeptMs: 7 * 24 * 3_600_000,
};

/** Longest relay line accepted. */
const MAX_RELAY_LINE = 512;

export interface PhoneServerOptions {
  readonly db: Database;
  /** `<data>/phone-inbox`, private. */
  readonly inboxDir: string;
  readonly clock: PairingClock;
  readonly pairing: PairingDesk;
  /** The import of a complete, checked file (`Imports.receive`). */
  readonly receive: (path: string, expected: PhoneExpectation) => Promise<PhoneReceipt>;
  /** The Mac's deletion of an episode, as « Supprimer » runs it. */
  readonly deleteEpisode: (episodeId: number) => Promise<void>;
  /** A recording's result for its phone (`phone-results.ts`). */
  readonly result: (input: {
    readonly deviceId: string;
    readonly recordingId: string;
    readonly revision: string | null;
    /** The sync version the phone speaks: tags and « Moi ? » from 2 (ADR 039). */
    readonly version: number;
  }) => Promise<GetAnswer>;
  /**
   * Adds a note as `context.add` does; `claim` runs first in its durable
   * transaction, and nothing is written when it returns false. False when
   * nothing was added (an empty text, or claimed already).
   */
  readonly addNote: (episodeId: number, text: string, claim: () => boolean) => Promise<boolean>;
  /**
   * Puts a tag on an episode or takes it off (ADR 039); `claim` runs first in
   * the same durable transaction. False when nothing was done (claimed already).
   */
  readonly setTag: (
    episodeId: number,
    tag: { readonly name: string; readonly on: boolean },
    claim: () => boolean,
  ) => Promise<boolean>;
  /** « C'est moi » on the phone: names voice `ordinal` of the episode's transcript as the user. */
  readonly confirmSelf: (
    episodeId: number,
    voice: { readonly ordinal: number; readonly sentenceId: number },
    claim: () => boolean,
  ) => Promise<boolean>;
  /** The Mac's tags, the latest used first, for the phone (50 at most). */
  readonly tags: () => readonly string[];
  /** The reads of the Mac's memory (`phone-memory.ts`). */
  readonly memory: PhoneMemoryReads;
  /** Slices of an episode's WAV, as the window's player reads them (`EpisodeMedia`). */
  readonly media: {
    readonly read: (request: MediaReadRequest) => Promise<MediaReadReply>;
    readonly cancel: (requestId: number) => void;
  };
  /** What `hello` tells a phone of the Mac. */
  readonly hello: () => Pick<HelloAnswer, "macId" | "addrs" | "port">;
  /**
   * « Autoriser par Tailscale »: a connection the relay says came through
   * Tailscale is closed while it is off, whatever the relay let through.
   */
  readonly tailnet: () => boolean;
  /** Free bytes on the data volume. */
  readonly freeBytes?: () => number;
  /** A phone forgot this Mac: the relay may stop. */
  readonly changed?: () => void;
  /** A revoked phone was answered `revoked`: it erases its credential now. */
  readonly revokedHeard?: (deviceId: string) => void;
  readonly limits?: Partial<PhoneLimits>;
}

export interface PhoneServer {
  /** A connection the relay opened on `phone.sock`. */
  accept(socket: Socket): void;
  /** Closes a revoked phone's connections at once and drops what it was sending. */
  disconnect(deviceId: string): void;
  /** Removes parts untouched for 7 days, and parts no upload names. */
  sweep(): void;
  /** Closes every connection (sync turned off, core stopping). */
  closeAll(): void;
  /** Closes the connections that came through Tailscale (« Autoriser par Tailscale » turned off). */
  closeTailnet(): void;
  /** A phone's request is being answered, or what it sent imported, the phone gone or not. */
  answering(): boolean;
  /** Open connections, for tests. */
  connectionCount(): number;
}

interface Connection {
  readonly socket: Socket;
  hello: PhoneRelayHello | null;
  /** The phone this connection authenticated as; null until then. */
  deviceId: string | null;
  /** Armed while a request's headers are awaited. */
  headerTimer: NodeJS.Timeout | null;
  /** A phone waits for the user's answer on it: never evicted for a newcomer. */
  pairing: boolean;
  /** A request is being answered on it. */
  answering: boolean;
  /** Closes once its answer is out. */
  closing: boolean;
}

interface Upload {
  readonly recordingId: string;
  /** The bytes are whole and the import has them: a deletion lets it finish, and the tombstone refuses it. */
  importing: boolean;
  /** Stops writing (a deletion, a revocation): the request ends. */
  readonly abort: () => void;
}

type Route =
  | { readonly kind: "procedure"; readonly name: PhoneProcedure }
  | { readonly kind: "audio"; readonly recordingId: string }
  | { readonly kind: "play"; readonly recordingId: string; readonly generation: number };

const AUDIO_PATH = /^\/v1\/recordings\/([^/]+)\/audio$/;

function routeOf(method: string | undefined, url: string | undefined): Route | null {
  const [path = "", query = ""] = (url ?? "").split("?");
  if (method === "POST") {
    const name = PHONE_PROCEDURES.find((procedure) => PHONE_ALL_ROUTES[procedure].path === path);
    return name === undefined ? null : { kind: "procedure", name };
  }
  const id = AUDIO_PATH.exec(path)?.[1];
  if (id === undefined || !Uuid.safeParse(id).success) return null;
  if (method === "PUT") return { kind: "audio", recordingId: id };
  if (method === "GET") {
    const generation = /^g=([1-9]\d{0,15})$/.exec(query)?.[1];
    return generation === undefined
      ? null
      : { kind: "play", recordingId: id, generation: Number(generation) };
  }
  return null;
}

/** Whether this Mac speaks a phone's sync version (ADR 039: from the oldest it still answers). */
const spoken = (version: number) => version >= PHONE_SYNC_OLDEST && version <= PHONE_SYNC_VERSION;

/** Statuses of refusals; the body says which. */
const STATUS: Record<PhoneErrorCode, number> = {
  unauthorized: 401,
  revoked: 401,
  version: 400,
  "not-yours": 403,
  "bad-request": 400,
  busy: 429,
  gone: 410,
  stale: 409,
  range: 416,
  "pairing-closed": 410,
  "pairing-refused": 403,
  "pairing-used": 409,
  "pairing-tailnet": 403,
};

const hashCredential = (credential: string): Buffer =>
  createHash("sha256").update(credential, "utf8").digest();

class BodyError extends Error {
  override readonly name = "BodyError";
}

// Responses

function reply(res: ServerResponse, code: number, body: unknown, close = false): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  if (close) drainThenClose(res);
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** A refusal's unread body is read for 1 MiB or 2 s at most, so the client hears the answer. */
const DRAIN_BYTES = 1024 ** 2;
const DRAIN_MS = 2_000;

/**
 * Closes the connection once the answer is out and the request's body read
 * (or 1 MiB, or 2 s). Started before answering: Node cuts a connection whose
 * body nobody reads as soon as the answer is written, under a client still
 * sending, which then never reads the answer.
 */
function drainThenClose(res: ServerResponse): void {
  const socket = res.socket;
  if (socket === null) return;
  const req = res.req;
  let answered = false;
  let read = req.complete || req.destroyed;
  const settle = () => {
    if (answered && read) socket.destroy();
  };
  res.once("finish", () => {
    answered = true;
    settle();
  });
  if (read) return;
  let drained = 0;
  const timer = setTimeout(() => socket.destroy(), DRAIN_MS);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
  req.on("data", (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > DRAIN_BYTES) socket.destroy();
  });
  req.once("end", () => {
    read = true;
    settle();
  });
  req.resume();
}

/** A refusal (`PhoneError`); the connection closes unless told otherwise. */
function refuse(res: ServerResponse, error: PhoneErrorCode, close = true): void {
  reply(
    res,
    STATUS[error],
    error === "version" ? { error, macVersion: PHONE_SYNC_VERSION } : { error },
    close,
  );
}

/** Where an upload stands (`UploadStatus`), always 200. */
function status(res: ServerResponse, answer: UploadStatus, close = false): void {
  reply(res, 200, answer, close);
}

/** SHA-256 of a file, hex. */
function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export function makePhoneServer(options: PhoneServerOptions): PhoneServer {
  const { db, inboxDir, clock, pairing } = options;
  const limits: PhoneLimits = { ...PHONE_LIMITS, ...options.limits };
  const freeBytes =
    options.freeBytes ??
    (() => {
      const volume = statfsSync(inboxDir);
      return volume.bavail * volume.bsize;
    });
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });

  const connections = new Map<Socket, Connection>();
  /** One upload (or its import) at a time per phone. */
  const uploads = new Map<string, Upload>();
  /** Wrong credentials per peer address, and until when it is refused. */
  const wrong = new Map<string, { count: number; blockedUntilMs: number }>();

  const partPath = (recordingId: string) => join(inboxDir, `${recordingId}.part`);
  const partSize = (recordingId: string): number | null =>
    statSync(partPath(recordingId), { throwIfNoEntry: false })?.size ?? null;
  const discardPart = (recordingId: string) => {
    removePhoneUpload(db, recordingId);
    rmSync(partPath(recordingId), { force: true });
  };

  const blocked = (peer: string): boolean => (wrong.get(peer)?.blockedUntilMs ?? 0) > clock.now();
  const wrongCredential = (peer: string) => {
    const entry = wrong.get(peer) ?? { count: 0, blockedUntilMs: 0 };
    entry.count += 1;
    if (entry.count >= limits.wrongCredentials) {
      entry.count = 0;
      entry.blockedUntilMs = clock.now() + limits.blockMs;
      log.warn("phone.peer-blocked", { ms: limits.blockMs });
    }
    wrong.set(peer, entry);
  };

  /** Sends `102 Processing` while `work` runs, so the relay sees bytes during a long wait. */
  const holding = async <A>(res: ServerResponse, work: Promise<A>): Promise<A> => {
    const timer = setInterval(() => {
      if (!res.headersSent && !res.destroyed) res.writeProcessing();
    }, limits.keepaliveMs);
    try {
      return await work;
    } finally {
      clearInterval(timer);
    }
  };

  /**
   * Reads a JSON body of at most 1 MiB, a byte at least every 30 s, and all
   * of it within `deadlineMs` when given.
   */
  const readJson = <S extends z.ZodType>(
    req: IncomingMessage,
    schema: S,
    deadlineMs?: number,
  ): Promise<z.output<S>> =>
    new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"] ?? Number.NaN);
      if (Number.isFinite(declared) && declared > limits.maxJsonBytes) {
        reject(new BodyError("too large"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let idle: NodeJS.Timeout | null = null;
      const arm = () => {
        if (idle !== null) clearTimeout(idle);
        idle = setTimeout(() => {
          done();
          req.destroy();
          reject(new BodyError("idle"));
        }, limits.bodyIdleMs);
      };
      const deadline =
        deadlineMs === undefined
          ? null
          : setTimeout(() => {
              done();
              req.destroy();
              reject(new BodyError("idle"));
            }, deadlineMs);
      const done = () => {
        if (idle !== null) clearTimeout(idle);
        if (deadline !== null) clearTimeout(deadline);
      };
      arm();
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.maxJsonBytes) {
          done();
          reject(new BodyError("too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
        arm();
      });
      req.on("end", () => {
        done();
        try {
          const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (parsed.success) resolve(parsed.data);
          else reject(new BodyError("invalid"));
        } catch {
          reject(new BodyError("not json"));
        }
      });
      req.on("aborted", () => {
        done();
        reject(new BodyError("aborted"));
      });
      req.on("error", () => {
        done();
        reject(new BodyError("error"));
      });
    });

  // Credentials

  type Caller =
    | { readonly kind: "ok"; readonly device: PhoneDevice }
    | { readonly kind: "unauthorized" }
    | { readonly kind: "revoked"; readonly deviceId: string };

  const authenticate = (req: IncomingMessage): Caller => {
    const header = req.headers.authorization ?? "";
    const credential = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!PHONE_CREDENTIAL_PATTERN.test(credential)) return { kind: "unauthorized" };
    const device = phoneDeviceByCredential(db, hashCredential(credential));
    if (device === null) return { kind: "unauthorized" };
    if (device.revokedAtMs !== null) return { kind: "revoked", deviceId: device.deviceId };
    return { kind: "ok", device };
  };

  // Routes

  const pair = async (req: IncomingMessage, res: ServerResponse, connection: Connection) => {
    if (connection.hello?.via === "tailnet") {
      refuse(res, "pairing-tailnet");
      return;
    }
    const body = await readJson(req, PHONE_ROUTES.pair.request, limits.pairBodyMs);
    if (!spoken(body.v)) {
      refuse(res, "version");
      return;
    }
    connection.pairing = true;
    const outcome = await holding(
      res,
      pairing.present(
        { token: body.token, deviceId: body.deviceId, deviceName: body.deviceName },
        connection,
      ),
    ).finally(() => {
      connection.pairing = false;
    });
    if (outcome.kind === "paired") {
      log.info("phone.paired", {});
      reply(res, 200, outcome.answer);
    } else {
      log.info("phone.pairing-refused", { error: outcome.error });
      refuse(res, outcome.error);
    }
  };

  const hello = async (
    req: IncomingMessage,
    res: ServerResponse,
    connection: Connection,
    device: PhoneDevice,
  ) => {
    const body = await readJson(req, PHONE_ROUTES.hello.request);
    if (!spoken(body.v)) {
      refuse(res, "version");
      return;
    }
    // The Mac speaks the phone's version from now on (ADR 039).
    if (body.v !== device.syncVersion) setPhoneSyncVersion(db, device.deviceId, body.v);
    const mac = options.hello();
    const answer: HelloAnswer = {
      v: body.v,
      clockMs: clock.now(),
      macId: mac.macId,
      addrs: mac.addrs.slice(0, 16),
      port: mac.port,
      maxFileBytes: limits.maxFileBytes,
      // At home the key is left out: a phone built before M5.5 reads no other.
      ...(connection.hello?.via === "tailnet" ? { via: "tailnet" as const } : {}),
    };
    reply(res, 200, answer);
  };

  /** Whose a recording id is: null when nobody's yet. */
  const ownerOf = (recordingId: string): string | null => phoneRecordingOwner(db, recordingId);

  const announce = async (req: IncomingMessage, res: ServerResponse, device: PhoneDevice) => {
    const body = await readJson(req, PHONE_ROUTES.announce.request);
    const { recordingId, bytes, sha256 } = body;
    const owner = ownerOf(recordingId);
    if (owner !== null && owner !== device.deviceId) {
      refuse(res, "not-yours", false);
      return;
    }
    if (bytes > limits.maxFileBytes) {
      status(res, { status: "refused", reason: "too-large" });
      return;
    }
    const arrival = phoneArrival(db, { recordingId, sha256 });
    if (arrival.kind !== "new") {
      // Held, deleted, or another file under this id: nothing to receive.
      if (
        phoneUpload(db, recordingId) !== null &&
        uploads.get(device.deviceId)?.recordingId !== recordingId
      ) {
        discardPart(recordingId);
      }
      status(res, arrival.kind === "duplicate" ? { status: "stored" } : { status: arrival.kind });
      return;
    }
    const running = uploads.get(device.deviceId);
    const known = phoneUpload(db, recordingId);
    if (known !== null && (known.bytes !== bytes || known.sha256 !== sha256)) {
      if (running?.recordingId === recordingId) {
        status(res, { status: "refused", reason: "busy" });
        return;
      }
      // Another file than the part's: the part goes.
      discardPart(recordingId);
    } else if (known !== null) {
      const held = partSize(recordingId);
      if (held !== null && held <= known.bytes) {
        status(res, { status: "send", offset: held });
        return;
      }
      if (running?.recordingId === recordingId) {
        status(res, { status: "refused", reason: "busy" });
        return;
      }
      discardPart(recordingId);
    }
    if (
      phoneInboxBytes(db, recordingId) + bytes > limits.inboxBytes ||
      freeBytes() < bytes + limits.diskMarginBytes
    ) {
      status(res, { status: "refused", reason: "no-room" });
      return;
    }
    const upload: PhoneUpload = {
      recordingId,
      deviceId: device.deviceId,
      bytes,
      sha256,
      announcedAtMs: clock.now(),
    };
    putPhoneUpload(db, upload);
    closeSync(openSync(partPath(recordingId), "w", 0o600));
    status(res, { status: "send", offset: 0 });
  };

  /** The part is whole: checked, imported, answered. */
  let finishing = 0;
  const finish = (upload: PhoneUpload, device: PhoneDevice): Promise<UploadStatus> => {
    finishing += 1;
    return checkAndImport(upload, device).finally(() => {
      finishing -= 1;
    });
  };
  const checkAndImport = async (
    upload: PhoneUpload,
    device: PhoneDevice,
  ): Promise<UploadStatus> => {
    const path = partPath(upload.recordingId);
    if ((await sha256Of(path)) !== upload.sha256) {
      discardPart(upload.recordingId);
      log.info("phone.upload-refused", { reason: "hash" });
      return { status: "refused", reason: "hash" };
    }
    const receipt = await options.receive(path, {
      recordingId: upload.recordingId,
      deviceId: device.deviceId,
      sha256: upload.sha256,
      confirm: () => {
        // Inside the publishing transaction: revoked or deleted meanwhile, nothing is written.
        if (phoneDevice(db, device.deviceId)?.revokedAtMs !== null) {
          throw new Error("the phone was revoked");
        }
      },
    });
    log.info("phone.upload-done", {
      outcome: receipt.outcome === "refused" ? receipt.reason : receipt.outcome,
    });
    // Without room the part stays for the next try; anything else settles it.
    if (receipt.outcome !== "refused" || receipt.reason !== "no-room") {
      discardPart(upload.recordingId);
    }
    if (receipt.outcome === "stored") {
      touchPhoneDevice(db, device.deviceId, clock.now(), "uploads");
      return { status: "stored" };
    }
    return receipt.outcome === "refused"
      ? { status: "refused", reason: receipt.reason }
      : { status: receipt.outcome };
  };

  const receiveAudio = async (
    req: IncomingMessage,
    res: ServerResponse,
    device: PhoneDevice,
    recordingId: string,
  ) => {
    const owner = ownerOf(recordingId);
    if (owner !== null && owner !== device.deviceId) {
      refuse(res, "not-yours");
      return;
    }
    const known = phoneUpload(db, recordingId);
    const offsetText = req.headers[PHONE_OFFSET_HEADER];
    const lengthText = req.headers["content-length"];
    if (
      typeof offsetText !== "string" ||
      !/^\d{1,12}$/.test(offsetText) ||
      typeof lengthText !== "string" ||
      !/^\d{1,12}$/.test(lengthText)
    ) {
      refuse(res, "bad-request");
      return;
    }
    const offset = Number(offsetText);
    const length = Number(lengthText);
    if (known === null) {
      // Announce first: it says where to start, or that nothing is needed.
      status(res, { status: "refused", reason: "offset" }, true);
      return;
    }
    if (uploads.has(device.deviceId)) {
      status(res, { status: "refused", reason: "busy" }, true);
      return;
    }
    const held = partSize(recordingId) ?? 0;
    if (offset !== held) {
      status(res, { status: "refused", reason: "offset" }, true);
      return;
    }
    if (offset + length > known.bytes) {
      refuse(res, "bad-request");
      return;
    }
    let aborted = false;
    const slot: Upload = {
      recordingId,
      importing: false,
      abort: () => {
        aborted = true;
        req.destroy();
      },
    };
    uploads.set(device.deviceId, slot);
    try {
      if (length > 0) {
        await new Promise<void>((resolve, reject) => {
          const out = createWriteStream(partPath(recordingId), { flags: "r+", start: offset });
          let idle: NodeJS.Timeout | null = null;
          const arm = () => {
            if (idle !== null) clearTimeout(idle);
            idle = setTimeout(() => req.destroy(), limits.bodyIdleMs);
          };
          let settled = false;
          const settle = (error: Error | null) => {
            if (settled) return;
            settled = true;
            if (idle !== null) clearTimeout(idle);
            // What arrived stays: the next announce resumes from it.
            out.end(() => (error === null ? resolve() : reject(error)));
          };
          arm();
          req.on("data", (chunk: Buffer) => {
            arm();
            if (!out.write(chunk)) {
              req.pause();
              out.once("drain", () => req.resume());
            }
          });
          req.on("end", () => settle(null));
          req.on("aborted", () => settle(new BodyError("aborted")));
          req.on("close", () => settle(req.complete ? null : new BodyError("closed")));
          out.on("error", (error) => {
            req.destroy();
            settle(error);
          });
        });
      }
      if (aborted) return;
      const size = partSize(recordingId) ?? 0;
      if (size < known.bytes) {
        status(res, { status: "send", offset: size });
        return;
      }
      slot.importing = true;
      status(res, await holding(res, finish(known, device)));
    } catch (error) {
      if (!(error instanceof BodyError)) throw error;
      log.info("phone.upload-cut", {});
      res.destroy();
    } finally {
      if (uploads.get(device.deviceId) === slot) uploads.delete(device.deviceId);
    }
  };

  const states = async (req: IncomingMessage, res: ServerResponse, device: PhoneDevice) => {
    const body = await readJson(req, PHONE_ROUTES.states.request);
    const readings = phoneRecordingReadings(db, device.deviceId, body.recordingIds);
    touchPhoneDevice(db, device.deviceId, clock.now(), "reads");
    reply(res, 200, {
      states: body.recordingIds.map((recordingId, index) => ({
        recordingId,
        state: readings[index] ?? "unknown",
      })),
    });
  };

  const remove = async (req: IncomingMessage, res: ServerResponse, device: PhoneDevice) => {
    const { operationId, recordingId } = await readJson(req, PHONE_ROUTES.delete.request);
    if (phoneOperationDone(db, device.deviceId, operationId)) {
      reply(res, 200, { status: "deleted" });
      return;
    }
    const owner = ownerOf(recordingId);
    if (owner !== null && owner !== device.deviceId) {
      refuse(res, "not-yours", false);
      return;
    }
    // A part on its way stops; its import, if one runs, finds the tombstone and publishes nothing.
    const running = uploads.get(device.deviceId);
    const importing = running?.recordingId === recordingId && running.importing;
    if (running?.recordingId === recordingId && !importing) running.abort();
    const episodeId = phoneRecordingEpisode(db, recordingId);
    if (episodeId !== null) await options.deleteEpisode(episodeId);
    const nowMs = clock.now();
    // Durable: the phone drops the operation on this answer, and the commit
    // also syncs the episode's deletion before it in the log.
    durableTransaction(db, () => {
      // No episode holds it (none should): its row turns into a tombstone all the same.
      tombstoneStoredPhoneRecording(db, recordingId, nowMs);
      // Never received: its id is remembered, so a copy sent later is refused.
      tombstoneUnreceivedPhoneRecording(db, { recordingId, deviceId: device.deviceId, nowMs });
      removePhoneUpload(db, recordingId);
      recordPhoneOperation(db, {
        deviceId: device.deviceId,
        operationId,
        kind: "delete",
        recordingId,
        nowMs,
      });
      touchPhoneDevice(db, device.deviceId, nowMs, "deletions");
    });
    // An import under way reads the part still: it removes it once refused.
    if (!importing) rmSync(partPath(recordingId), { force: true });
    log.info("phone.deleted", { held: episodeId !== null });
    reply(res, 200, { status: "deleted" });
  };

  /** A recording named by a phone that is another phone's: refused. */
  const othersOf = (recordingId: string, device: PhoneDevice): boolean => {
    const owner = ownerOf(recordingId);
    return owner !== null && owner !== device.deviceId;
  };

  const get = async (req: IncomingMessage, res: ServerResponse, device: PhoneDevice) => {
    const { recordingId, revision } = await readJson(req, PHONE_ROUTES.get.request);
    if (othersOf(recordingId, device)) {
      refuse(res, "not-yours", false);
      return;
    }
    const answer = await options.result({
      deviceId: device.deviceId,
      recordingId,
      revision,
      version: device.syncVersion,
    });
    touchPhoneDevice(db, device.deviceId, clock.now(), "reads");
    if (answer.status === "withheld") log.info("phone.result-withheld", {});
    reply(res, 200, answer);
  };

  const rename = async (req: IncomingMessage, res: ServerResponse, device: PhoneDevice) => {
    const body = await readJson(req, PHONE_ROUTES.rename.request);
    if (phoneOperationDone(db, device.deviceId, body.operationId)) {
      reply(res, 200, { status: "done" });
      return;
    }
    if (othersOf(body.recordingId, device)) {
      refuse(res, "not-yours", false);
      return;
    }
    const nowMs = clock.now();
    const outcome = durableTransaction(db, () => {
      const named = renamePhoneRecording(db, body);
      if (named === "named" || named === "superseded") {
        recordPhoneOperation(db, {
          deviceId: device.deviceId,
          operationId: body.operationId,
          kind: "rename",
          recordingId: body.recordingId,
          nowMs,
        });
      }
      return named;
    });
    log.info("phone.renamed", { outcome });
    reply(res, 200, {
      status: outcome === "not-stored" ? "later" : outcome === "deleted" ? "deleted" : "done",
    });
  };

  const note = async (req: IncomingMessage, res: ServerResponse, device: PhoneDevice) => {
    const body = await readJson(req, PHONE_ROUTES.note.request);
    const episodeId = episodeForOperation(res, device, body.operationId, body.recordingId);
    if (episodeId === null) return;
    // The operation is claimed in the note's transaction, before it is written:
    // sent twice, even at once, it is one note.
    const added = await options.addNote(episodeId, body.text, () =>
      recordPhoneOperation(db, {
        deviceId: device.deviceId,
        operationId: body.operationId,
        kind: "note",
        recordingId: body.recordingId,
        nowMs: clock.now(),
      }),
    );
    log.info("phone.note", { added });
    reply(res, 200, { status: "done" });
  };

  /**
   * Where an outbox operation's recording stands: its episode, or the answer
   * when it has none (not here yet, the phone keeps the operation; deleted,
   * it drops it), or null when another phone's.
   */
  const episodeForOperation = (
    res: ServerResponse,
    device: PhoneDevice,
    operationId: string,
    recordingId: string,
  ): number | null => {
    if (phoneOperationDone(db, device.deviceId, operationId)) {
      reply(res, 200, { status: "done" });
      return null;
    }
    if (othersOf(recordingId, device)) {
      refuse(res, "not-yours", false);
      return null;
    }
    const episodeId = phoneRecordingEpisode(db, recordingId);
    if (episodeId === null) {
      const [reading] = phoneRecordingReadings(db, device.deviceId, [recordingId]);
      reply(res, 200, { status: reading === "deleted" ? "deleted" : "later" });
    }
    return episodeId;
  };

  /** A tag put on or taken off on the phone (ADR 039); one the Mac refuses is dropped. */
  const tag = async (req: IncomingMessage, res: ServerResponse, device: PhoneDevice) => {
    const body = await readJson(req, PHONE_ROUTES.tag.request);
    const episodeId = episodeForOperation(res, device, body.operationId, body.recordingId);
    if (episodeId === null) return;
    const done = await options.setTag(episodeId, { name: body.name, on: body.on }, () =>
      recordPhoneOperation(db, {
        deviceId: device.deviceId,
        operationId: body.operationId,
        kind: "tag",
        recordingId: body.recordingId,
        nowMs: clock.now(),
      }),
    );
    log.info("phone.tag", { done, on: body.on });
    reply(res, 200, { status: "done" });
  };

  /** « C'est moi » on the phone: the voice is the user (ADR 039). */
  const voice = async (req: IncomingMessage, res: ServerResponse, device: PhoneDevice) => {
    const body = await readJson(req, PHONE_ROUTES.voice.request);
    const episodeId = episodeForOperation(res, device, body.operationId, body.recordingId);
    if (episodeId === null) return;
    const seen = { ordinal: body.ordinal, sentenceId: body.sentenceId };
    const done = await options.confirmSelf(episodeId, seen, () =>
      recordPhoneOperation(db, {
        deviceId: device.deviceId,
        operationId: body.operationId,
        kind: "voice",
        recordingId: body.recordingId,
        nowMs: clock.now(),
      }),
    );
    log.info("phone.voice", { done });
    reply(res, 200, { status: "done" });
  };

  /** A read of the Mac's memory, its request read: answered, counted as one read, timed in the log. */
  const memoryRead = async (
    res: ServerResponse,
    device: PhoneDevice,
    route: PhoneMemoryRoute,
    answer: () => Promise<{ readonly status: string }>,
  ) => {
    const started = performance.now();
    const answered = await answer();
    touchPhoneDevice(db, device.deviceId, clock.now(), "reads");
    const bytes = Buffer.byteLength(JSON.stringify(answered));
    log.info("phone.read", {
      route,
      status: answered.status,
      ms: Math.round(performance.now() - started),
      bytes,
    });
    // The phone refuses a larger answer: it never leaves (each read keeps under it).
    if (bytes > MAX_PHONE_MEMORY_BYTES) {
      log.warn("phone.read-too-large", { route, bytes });
      refuse(res, "busy", false);
      return;
    }
    reply(res, 200, answered);
  };

  /** Media reads of playback, numbered apart from the window's. */
  let playRequests = 0;

  /**
   * `GET …/audio?g=`: the episode's WAV, the range asked (or all of it),
   * read slice by slice with each slice's checks (deletion, generation) and
   * written as it comes; a slice that fails ends the answer.
   */
  const play = async (
    req: IncomingMessage,
    res: ServerResponse,
    device: PhoneDevice,
    route: Extract<Route, { kind: "play" }>,
  ) => {
    if (othersOf(route.recordingId, device)) {
      refuse(res, "not-yours", false);
      return;
    }
    const episodeId = phoneRecordingEpisode(db, route.recordingId);
    if (ownerOf(route.recordingId) !== device.deviceId || episodeId === null) {
      refuse(res, "gone", false);
      return;
    }
    const header = req.headers.range;
    const asked = parseRangeHeader(typeof header === "string" ? header : null);
    let current: number | null = null;
    res.once("close", () => {
      if (current !== null) options.media.cancel(current);
    });
    const slice = (range: MediaReadRequest["range"]) => {
      playRequests += 1;
      current = -playRequests;
      return options.media.read({
        type: "media-read",
        requestId: current,
        episodeId,
        generation: route.generation,
        range,
      });
    };
    const first = await slice(asked ?? { kind: "range", start: 0, end: null });
    if (!first.ok) {
      if (first.reason === "cancelled") return;
      const error =
        first.reason === "not-found"
          ? "gone"
          : first.reason === "stale"
            ? "stale"
            : first.reason === "unsatisfiable"
              ? "range"
              : "busy";
      refuse(res, error, false);
      return;
    }
    // One read per playback, not per range: counted when it starts from the top.
    if (first.start === 0) touchPhoneDevice(db, device.deviceId, clock.now(), "reads");
    res.writeHead(asked === null ? 200 : 206, {
      "content-type": PHONE_AUDIO_TYPE,
      "content-length": first.end - first.start + 1,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      ...(asked === null
        ? {}
        : { "content-range": `bytes ${first.start}-${first.end}/${first.total}` }),
    });
    let next = first.start + first.bytes.length;
    let read: MediaReadReply = first;
    for (;;) {
      if (!read.ok) {
        // Deleted or changed while it streamed: the answer stops short.
        res.destroy();
        return;
      }
      const writable = res.write(read.bytes);
      if (next > first.end) break;
      if (!writable) {
        await new Promise<void>((resolve) => {
          res.once("drain", resolve);
          res.once("close", resolve);
        });
      }
      if (res.destroyed) return;
      read = await slice({ kind: "range", start: next, end: first.end });
      if (read.ok) next += read.bytes.length;
    }
    res.end();
  };

  const forget = async (
    req: IncomingMessage,
    res: ServerResponse,
    device: PhoneDevice,
    connection: Connection,
  ) => {
    await readJson(req, PHONE_ROUTES.forget.request);
    revokePhoneDevice(db, device.deviceId, clock.now());
    log.info("phone.forgotten", {});
    reply(res, 200, { status: "forgotten" }, true);
    disconnect(device.deviceId, connection);
    options.changed?.();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const connection = connections.get(req.socket);
    const peer = connection?.hello?.peer;
    if (connection === undefined || peer === undefined) {
      req.socket.destroy();
      return;
    }
    if (blocked(peer)) {
      refuse(res, "busy");
      return;
    }
    const route = routeOf(req.method, req.url);
    if (route === null) {
      refuse(res, "bad-request");
      return;
    }
    if (route.kind === "procedure" && route.name === "pair") {
      await pair(req, res, connection);
      return;
    }
    const caller = authenticate(req);
    if (caller.kind !== "ok") {
      if (caller.kind === "unauthorized") wrongCredential(peer);
      refuse(res, caller.kind);
      if (caller.kind === "revoked") options.revokedHeard?.(caller.deviceId);
      return;
    }
    const device = caller.device;
    connection.deviceId = device.deviceId;
    touchPhoneDevice(db, device.deviceId, clock.now(), undefined, connection.hello?.via);
    if (route.kind === "audio") {
      await receiveAudio(req, res, device, route.recordingId);
      return;
    }
    if (route.kind === "play") {
      await play(req, res, device, route);
      return;
    }
    switch (route.name) {
      case "hello":
        return hello(req, res, connection, device);
      case "announce":
        return announce(req, res, device);
      case "states":
        return states(req, res, device);
      case "delete":
        return remove(req, res, device);
      case "get":
        return get(req, res, device);
      case "rename":
        return rename(req, res, device);
      case "note":
        return note(req, res, device);
      case "tag":
        return tag(req, res, device);
      case "voice":
        return voice(req, res, device);
      case "tags":
        await readJson(req, PHONE_ROUTES.tags.request);
        touchPhoneDevice(db, device.deviceId, clock.now(), "reads");
        reply(res, 200, { tags: options.tags().slice(0, 50) });
        return;
      case "forget":
        return forget(req, res, device, connection);
      case "search": {
        const input = await readJson(req, PHONE_MEMORY_ROUTES.search.request);
        return memoryRead(res, device, "search", () =>
          options.memory.search(input, device.deviceId),
        );
      }
      case "day": {
        const input = await readJson(req, PHONE_MEMORY_ROUTES.day.request);
        return memoryRead(res, device, "day", () => options.memory.day(input, device.deviceId));
      }
      case "journal": {
        const input = await readJson(req, PHONE_MEMORY_ROUTES.journal.request);
        return memoryRead(res, device, "journal", () =>
          options.memory.journal(input, device.deviceId),
        );
      }
      case "commitments": {
        const input = await readJson(req, PHONE_MEMORY_ROUTES.commitments.request);
        return memoryRead(res, device, "commitments", () =>
          options.memory.commitments(input, device.deviceId),
        );
      }
      case "conversation": {
        const input = await readJson(req, PHONE_MEMORY_ROUTES.conversation.request);
        return memoryRead(res, device, "conversation", () =>
          options.memory.conversation(input, device.deviceId),
        );
      }
    }
  };

  // Connections

  /** Requests being handled, their phone gone or not: an import goes on without it. */
  let handling = 0;
  const http = createServer({
    maxHeaderSize: limits.maxHeaderBytes,
    requestTimeout: 0,
    keepAliveTimeout: limits.keepAliveMs,
    requireHostHeader: false,
  });
  http.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const connection = connections.get(req.socket);
    if (connection?.headerTimer != null) clearTimeout(connection.headerTimer);
    if (connection !== undefined) {
      connection.headerTimer = null;
      connection.answering = true;
    }
    res.once("close", () => {
      if (connection === undefined) return;
      connection.answering = false;
      if (connection.closing) connection.socket.destroy();
      // The next request's headers have their own 10 s.
      else if (!connection.socket.destroyed) armHeaders(connection);
    });
    handling += 1;
    handle(req, res)
      .finally(() => {
        handling -= 1;
      })
      .catch((error: unknown) => {
        if (error instanceof BodyError) {
          // A body read whole leaves `req` destroyed: the socket says whether the phone is still there.
          if (!res.headersSent && !req.socket.destroyed) refuse(res, "bad-request");
          else res.destroy();
          return;
        }
        log.warn("phone.request-failed", {
          error: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message.slice(0, 200) : "",
        });
        if (!res.headersSent && !res.destroyed) refuse(res, "busy");
        else res.destroy();
      });
  });
  http.on("clientError", (error: NodeJS.ErrnoException, socket: Socket) => {
    const code =
      error.code === "HPE_HEADER_OVERFLOW"
        ? "431 Request Header Fields Too Large"
        : "400 Bad Request";
    if (socket.writable)
      socket.end(`HTTP/1.1 ${code}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  });

  const armHeaders = (connection: Connection) => {
    if (connection.headerTimer !== null) clearTimeout(connection.headerTimer);
    connection.headerTimer = setTimeout(() => connection.socket.destroy(), limits.headersMs);
  };

  const accept = (socket: Socket) => {
    if (connections.size >= limits.maxConnections) {
      // Unauthenticated connections cannot keep a paired phone out.
      const stranger = [...connections.values()].find(
        (entry) => entry.deviceId === null && !entry.pairing,
      );
      if (stranger === undefined) {
        log.warn("phone.connection-refused", { open: connections.size });
        socket.destroy();
        return;
      }
      stranger.socket.destroy();
      connections.delete(stranger.socket);
    }
    const connection: Connection = {
      socket,
      hello: null,
      deviceId: null,
      headerTimer: null,
      pairing: false,
      answering: false,
      closing: false,
    };
    connections.set(socket, connection);
    armHeaders(connection);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (connection.headerTimer !== null) clearTimeout(connection.headerTimer);
      connections.delete(socket);
      pairing.connectionClosed(connection);
    });
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end < 0) {
        if (buffered.length > MAX_RELAY_LINE) socket.destroy();
        return;
      }
      socket.off("data", onData);
      socket.pause();
      let relayLine: PhoneRelayHello | null = null;
      try {
        const parsed = PhoneRelayHello.safeParse(
          JSON.parse(buffered.subarray(0, end).toString("utf8")),
        );
        relayLine = parsed.success ? parsed.data : null;
      } catch {
        relayLine = null;
      }
      if (relayLine === null || end > MAX_RELAY_LINE) {
        log.warn("phone.relay-line-refused", {});
        socket.destroy();
        return;
      }
      // The relay refuses Tailscale's ranges while the switch is off; core checks again.
      if (relayLine.via === "tailnet" && !options.tailnet()) {
        log.warn("phone.tailnet-refused", {});
        socket.destroy();
        return;
      }
      connection.hello = relayLine;
      const rest = buffered.subarray(end + 1);
      if (rest.length > 0) socket.unshift(rest);
      http.emit("connection", socket);
      socket.resume();
    };
    socket.on("data", onData);
  };

  /** Its connections close, its upload stops, and its parts go (it keeps its own copies). */
  const disconnect = (deviceId: string, except?: Connection) => {
    uploads.get(deviceId)?.abort();
    for (const connection of connections.values()) {
      if (connection.deviceId === deviceId && connection !== except) connection.socket.destroy();
    }
    for (const upload of listPhoneUploads(db)) {
      if (upload.deviceId === deviceId) discardPart(upload.recordingId);
    }
  };

  return {
    accept,
    disconnect: (deviceId) => disconnect(deviceId),
    sweep() {
      const nowMs = clock.now();
      const running = new Set([...uploads.values()].map((upload) => upload.recordingId));
      const named = new Set<string>();
      for (const upload of listPhoneUploads(db)) {
        named.add(upload.recordingId);
        if (running.has(upload.recordingId)) continue;
        const touched =
          statSync(partPath(upload.recordingId), { throwIfNoEntry: false })?.mtimeMs ??
          upload.announcedAtMs;
        if (nowMs - Math.max(touched, upload.announcedAtMs) > limits.partKeptMs) {
          discardPart(upload.recordingId);
          log.info("phone.part-expired", {});
        }
      }
      for (const name of readdirSync(inboxDir)) {
        const id = name.endsWith(".part") ? name.slice(0, -".part".length) : null;
        if (id === null || !named.has(id))
          rmSync(join(inboxDir, name), { force: true, recursive: true });
      }
    },
    closeAll() {
      for (const upload of uploads.values()) upload.abort();
      // An answer under way (a refused pairing, say) goes out first.
      for (const connection of connections.values()) {
        if (connection.answering) connection.closing = true;
        else connection.socket.destroy();
      }
    },
    closeTailnet() {
      // As a cut line: an upload on one of them stops, and resumes from its part later.
      for (const connection of connections.values()) {
        if (connection.hello?.via === "tailnet") connection.socket.destroy();
      }
    },
    answering: () => handling > 0 || finishing > 0,
    connectionCount: () => connections.size,
  };
}
