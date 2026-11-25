import * as z from "zod";
import { WallMs, Uuid } from "./primitives";
import { named } from "./registry";

// What the iPhone app and the Mac say to each other (ADR 008, built at M5.2).
// The phone talks HTTP/1.1 inside pinned TLS to `sondine-lan`, which relays
// the bytes to core's `run/phone.sock` after one line saying how the peer
// came (`PhoneRelayHello`). Every route is `POST /v1/<name>` with a JSON body
// and a JSON answer, but the upload, `PUT /v1/recordings/<id>/audio`, whose
// body is the file's bytes, and playback (M5.3), `GET
// /v1/recordings/<id>/audio?g=<generation>` with a byte range, whose answer
// is the recording's WAV as the Mac plays it. Every request but pairing
// carries `Authorization: Bearer <credential>`. A refusal is any status
// other than 200 and 206 with a `PhoneError` body.

/**
 * The sync protocol's version this build speaks: pairing and `hello` say the
 * phone's, and the Mac answers in it (ADR 039). Version 2 adds tags and the
 * user's own voice confirmed on the phone; a version 1 phone keeps syncing
 * without them.
 */
export const PHONE_SYNC_VERSION = 2;
/** The oldest phone version the Mac still answers. */
export const PHONE_SYNC_OLDEST = 1;
/**
 * The version of what finds and links the Mac: the QR, the Bonjour record and
 * the relay's first line. Unchanged by version 2, so a phone built before it
 * still finds and pairs with the Mac.
 */
export const PHONE_LINK_VERSION = 1;
/** The Bonjour service type the relay advertises at home. */
export const PHONE_SERVICE_TYPE = "_sondine._tcp";
/** The header carrying the upload's first byte's offset in the file. */
export const PHONE_OFFSET_HEADER = "sondine-offset";
/** Largest file the Mac accepts from a phone. */
export const MAX_PHONE_FILE_BYTES = 1 << 30;
/** Largest JSON body either side sends. */
export const MAX_PHONE_JSON_BYTES = 1 << 20;
/** Largest answer of `get`: a recording's result (3 hours of speech is about 1 MiB). */
export const MAX_PHONE_RESULT_BYTES = 8 << 20;
/** How many recording ids one `hello` or `states` may name. */
export const MAX_PHONE_IDS = 2_000;
/** How long a pairing waits for the Mac's « Appairer », in ms. */
export const PAIRING_ANSWER_MS = 120_000;
/** How long a pairing token can be presented, in ms. */
export const PAIRING_TOKEN_MS = 5 * 60_000;

/** The phone keeps the results of its recordings made in the last 30 days (ADR 008). */
export const PHONE_RESULT_KEPT_MS = 30 * 24 * 3_600_000;

/** `sdp_` and 32 random bytes, base64url: the phone's credential (only its SHA-256 is kept on the Mac). */
export const PHONE_CREDENTIAL_PATTERN = /^sdp_[A-Za-z0-9_-]{43}$/;

const Base64Url32 = named(
  "Base64Url32",
  "32 random bytes, base64url without padding.",
  z.string().regex(/^[A-Za-z0-9_-]{43}$/),
);

export const KeyPin = named(
  "KeyPin",
  "SHA-256 of the Mac's TLS public key (SubjectPublicKeyInfo, DER), lowercase hex: the only thing the phone trusts.",
  z.string().regex(/^[0-9a-f]{64}$/),
);

export const Sha256Hex = named(
  "Sha256Hex",
  "SHA-256, lowercase hex.",
  z.string().regex(/^[0-9a-f]{64}$/),
);

export const PhoneCredential = named(
  "PhoneCredential",
  "The phone's credential: `sdp_` and 32 random bytes, base64url.",
  z.string().regex(PHONE_CREDENTIAL_PATTERN),
);

export const IpAddress = named(
  "IpAddress",
  "An IPv4 address in dotted form, or an IPv6 address (with its zone for a link-local one).",
  z
    .string()
    .regex(/^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-fA-F:.]{2,45}(?:%[A-Za-z0-9]{1,15})?)$/),
);

export const PhonePort = named("PhonePort", "A TCP port.", z.int().min(1).max(65_535));

export const DeviceName = named(
  "DeviceName",
  "The name the user gave a phone or the Mac's service, 1 to 64 characters, no control characters.",
  // oxlint-disable-next-line no-control-regex -- excluding control characters is the point
  z.string().regex(/^[^\u0000-\u001f\u007f]{1,64}$/),
);

export const RecordingName = named(
  "RecordingName",
  "The name the user typed for a recording on the phone: 1 to 200 characters (UTF-16 units), no control characters. The phone trims it; the Mac reads one of blanks only as no name.",
  // oxlint-disable-next-line no-control-regex -- excluding control characters is the point
  z.string().regex(/^[^\u0000-\u001f\u007f]{1,200}$/),
);

export const OperationId = named(
  "OperationId",
  "The id the phone gave one operation of its outbox, so a retry does nothing twice.",
  Uuid.clone(),
);

// The QR

/** What the Mac's pairing QR carries, as `sondine://pair?v=1&pin=…&token=…&name=…&port=…&addr=…,…`. */
export const PairingInvite = named(
  "PairingInvite",
  "The pairing QR: the Mac's key pin, a one-time token, the service's name, its port and addresses to try when Bonjour is blocked.",
  z.strictObject({
    v: z.literal(PHONE_LINK_VERSION),
    pin: KeyPin,
    token: Base64Url32,
    name: DeviceName,
    port: PhonePort,
    addrs: z.array(IpAddress).max(8),
  }),
);
export type PairingInvite = z.output<typeof PairingInvite>;

export const PAIRING_URL_PREFIX = "sondine://pair?";

export function formatPairingUrl(invite: PairingInvite): string {
  const query = new URLSearchParams({
    v: String(invite.v),
    pin: invite.pin,
    token: invite.token,
    name: invite.name,
    port: String(invite.port),
    addr: invite.addrs.join(","),
  });
  return PAIRING_URL_PREFIX + query.toString();
}

/** The invite in a scanned text, or null when it is not one this version reads. */
export function parsePairingUrl(text: string): PairingInvite | null {
  if (!text.startsWith(PAIRING_URL_PREFIX)) return null;
  const query = new URLSearchParams(text.slice(PAIRING_URL_PREFIX.length));
  const addr = query.get("addr") ?? "";
  const parsed = PairingInvite.safeParse({
    v: Number(query.get("v")),
    pin: query.get("pin"),
    token: query.get("token"),
    name: query.get("name"),
    port: Number(query.get("port")),
    addrs: addr === "" ? [] : addr.split(","),
  });
  return parsed.success ? parsed.data : null;
}

// The six digits both screens show (core and Swift, vectors in
// `fixtures/vectors/pairing-digits.jsonl`): SHA-256 of `token \n deviceId \n
// pin` (UTF-8), its first four bytes as a big-endian integer, modulo a
// million, with leading zeros. Not here: this package also runs in the
// browser extension, which has no `node:crypto`.

// The relay

/** The relay's first line to core on `phone.sock`, before the peer's bytes. */
export const PhoneRelayHello = named(
  "PhoneRelayHello",
  "The first line `sondine-lan` writes on core's phone socket: the path the peer took and its address.",
  z.strictObject({
    v: z.literal(PHONE_LINK_VERSION),
    via: z.enum(["lan", "tailnet", "loopback"]),
    peer: IpAddress,
  }),
);
export type PhoneRelayHello = z.output<typeof PhoneRelayHello>;

// Refusals

export const PhoneErrorCode = named(
  "PhoneErrorCode",
  "Why the Mac refused a request: no or unknown credential, revoked, another protocol version, a recording another phone made, a malformed request, too many at once or too many wrong credentials, a recording's audio no longer there (deleted, not ready, or taken by retention), a playback whose generation moved (fetch the result again), a byte range past the end, or a pairing that is closed, refused by the user, already used or expired.",
  z.enum([
    "unauthorized",
    "revoked",
    "version",
    "not-yours",
    "bad-request",
    "busy",
    "gone",
    "stale",
    "range",
    "pairing-closed",
    "pairing-refused",
    "pairing-used",
    "pairing-tailnet",
  ]),
);
export type PhoneErrorCode = z.output<typeof PhoneErrorCode>;

export const PhoneError = named(
  "PhoneError",
  "A refusal's body. `macVersion` comes with `version`, so each side says which app to update.",
  z.strictObject({
    error: PhoneErrorCode,
    macVersion: z.int().min(1).optional(),
  }),
);
export type PhoneError = z.output<typeof PhoneError>;

// Pairing: POST /v1/pair, no credential. The answer waits for the Mac's « Appairer ».

export const PairRequest = named(
  "PairRequest",
  "The phone's pairing request: the QR's token, the id it made for itself, its name, its version.",
  z.strictObject({
    v: z.int().min(1),
    token: Base64Url32,
    deviceId: Uuid,
    deviceName: DeviceName,
  }),
);
export type PairRequest = z.output<typeof PairRequest>;

export const PairAnswer = named(
  "PairAnswer",
  "The Mac's « Appairer »: the credential (kept in the Keychain) and the Mac's id.",
  z.strictObject({ credential: PhoneCredential, macId: Uuid }),
);
export type PairAnswer = z.output<typeof PairAnswer>;

// POST /v1/hello

export const HelloRequest = named(
  "HelloRequest",
  "The start of a sync: the phone's version, clock and the recording ids it holds.",
  z.strictObject({
    v: z.int().min(1),
    clockMs: WallMs,
    recordingIds: z.array(Uuid).max(MAX_PHONE_IDS),
  }),
);
export type HelloRequest = z.output<typeof HelloRequest>;

export const HelloAnswer = named(
  "HelloAnswer",
  "The Mac's clock, id, addresses and port (to find it again without Bonjour), its limits, and the path this phone came by (M5.5): `via` is `tailnet` through Tailscale, and absent at home, so a phone built before M5.5, which reads no other key, still syncs there. `v` is the phone's own version, which the Mac then speaks to it (ADR 039).",
  z.strictObject({
    v: z.int().min(PHONE_SYNC_OLDEST).max(PHONE_SYNC_VERSION),
    clockMs: WallMs,
    macId: Uuid,
    addrs: z.array(IpAddress).max(16),
    port: PhonePort,
    maxFileBytes: z.int().min(1),
    via: z.literal("tailnet").optional(),
  }),
);
export type HelloAnswer = z.output<typeof HelloAnswer>;

// Sending a recording: POST /v1/recordings/announce, then PUT …/audio

export const RecordingRefusal = named(
  "RecordingRefusal",
  "Why the Mac will not take a file now: larger than its limit, no room, its length unreadable, its header missing or naming another id or device, its hash wrong (the part is discarded), or an upload of this phone already running.",
  z.enum(["too-large", "no-room", "unreadable", "header", "hash", "offset", "busy"]),
);

/** Where a file stands on the Mac after an announcement or an upload. */
export const UploadStatus = named(
  "UploadStatus",
  "`send`: continue from `offset`. `stored`: held for good, the phone may erase its audio. `conflict`: another recording is here under this id, the phone keeps its file. `deleted`: deleted on the Mac, the phone erases its copy. `refused`: try again later, or never for `too-large` and `header`.",
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("send"), offset: z.int().min(0) }),
    z.strictObject({ status: z.literal("stored") }),
    z.strictObject({ status: z.literal("conflict") }),
    z.strictObject({ status: z.literal("deleted") }),
    z.strictObject({ status: z.literal("refused"), reason: RecordingRefusal }),
  ]),
);
export type UploadStatus = z.output<typeof UploadStatus>;

export const AnnounceRequest = named(
  "AnnounceRequest",
  "A file the phone wants to send: its id, length and SHA-256.",
  z.strictObject({
    recordingId: Uuid,
    bytes: z.int().min(1),
    sha256: Sha256Hex,
  }),
);
export type AnnounceRequest = z.output<typeof AnnounceRequest>;

// POST /v1/recordings/states

export const RecordingState = named(
  "RecordingState",
  "A recording's state on the Mac: `unknown` (never received), `receiving` (a part is in the inbox), `waiting` (stored, analysis not started), `transcribing`, `ready`, or `deleted`.",
  z.enum(["unknown", "receiving", "waiting", "transcribing", "ready", "deleted"]),
);
export type RecordingState = z.output<typeof RecordingState>;

export const StatesRequest = named(
  "StatesRequest",
  "The recording ids the phone holds and follows.",
  z.strictObject({ recordingIds: z.array(Uuid).max(MAX_PHONE_IDS) }),
);
export type StatesRequest = z.output<typeof StatesRequest>;

export const StatesAnswer = named(
  "StatesAnswer",
  "One state per id asked, in the same order. An id another phone made reads `unknown`.",
  z.strictObject({
    states: z.array(z.strictObject({ recordingId: Uuid, state: RecordingState })),
  }),
);
export type StatesAnswer = z.output<typeof StatesAnswer>;

// POST /v1/recordings/delete

export const DeleteRequest = named(
  "DeleteRequest",
  "A deletion from the phone's outbox: the Mac deletes the recording (or the part it receives) and keeps a tombstone either way.",
  z.strictObject({ operationId: OperationId, recordingId: Uuid }),
);
export type DeleteRequest = z.output<typeof DeleteRequest>;

export const DeleteAnswer = named(
  "DeleteAnswer",
  "The deletion is done (also when it was already): the operation leaves the outbox.",
  z.strictObject({ status: z.literal("deleted") }),
);
export type DeleteAnswer = z.output<typeof DeleteAnswer>;

// POST /v1/recordings/get (M5.3): a recording's result, when its revision moved

export const PhoneSpeaker = named(
  "PhoneSpeaker",
  "A voice of the transcript: its number (« Voix 2 »), the user's name for it, or whom Sondine takes it for (ADR 030: a guess, unconfirmed, shown as one), and whether it is the user. Version 2: `guessSelf`, the guess is the user (« Moi ? »), which the phone may confirm (`VoiceRequest`).",
  z.strictObject({
    ordinal: z.int().min(1),
    name: z.string().min(1).max(200).nullable(),
    guess: z.string().min(1).max(200).nullable(),
    self: z.boolean(),
    guessSelf: z.boolean().optional(),
  }),
);
export type PhoneSpeaker = z.output<typeof PhoneSpeaker>;

export const PhoneSentence = named(
  "PhoneSentence",
  "A sentence of the transcript, in time order: its id on the Mac, its times, the voice that said it (`PhoneSpeaker.ordinal`) and its text.",
  z.strictObject({
    id: z.int().min(1),
    startMs: WallMs,
    endMs: WallMs,
    speaker: z.int().min(1).nullable(),
    text: z.string().max(20_000),
  }),
);
export type PhoneSentence = z.output<typeof PhoneSentence>;

export const PhoneLineVoice = named(
  "PhoneLineVoice",
  "A voice a journal line names as `{P2}` in its text: the user's name for it, whom Sondine takes it for (a guess), the user, and its number when known.",
  z.strictObject({
    ref: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
    ordinal: z.int().min(0).nullable(),
    name: z.string().min(1).max(200).nullable(),
    guess: z.string().min(1).max(200).nullable(),
    self: z.boolean(),
  }),
);
export type PhoneLineVoice = z.output<typeof PhoneLineVoice>;

export const PhoneJournalLine = named(
  "PhoneJournalLine",
  "A line of the Mac's journal (ADR 028) or a commitment that cites this recording: its text with voices as `{P2}`, the sentences of this recording it cites, when, and for a commitment whether it is done and its date (`YYYY-MM-DD`).",
  z.strictObject({
    kind: z.enum(["line", "commitment"]),
    text: z.string().min(1).max(2_000),
    voices: z.array(PhoneLineVoice).max(32),
    sentenceIds: z.array(z.int().min(1)).max(64),
    startMs: WallMs,
    done: z.boolean(),
    due: z.iso.date().nullable(),
  }),
);
export type PhoneJournalLine = z.output<typeof PhoneJournalLine>;

export const PhoneNote = named(
  "PhoneNote",
  "A note (or a link) on the recording's conversation (ADR 024), from the phone or the Mac.",
  z.strictObject({ id: z.int().min(1), text: z.string().min(1).max(20_000), addedAtMs: WallMs }),
);
export type PhoneNote = z.output<typeof PhoneNote>;

/** A tag as the Mac keeps it: 1 to 40 characters as people count them, at most 400 code units. */
export const PhoneTagName = named(
  "PhoneTagName",
  "A tag's name as the Mac keeps it (ADR 039): cleaned, one line, 1 to 40 characters.",
  z.string().min(1).max(400),
);

export const PhoneResult = named(
  "PhoneResult",
  "What the Mac made of one of the phone's recordings: its name, times, voices, sentences, the journal lines and commitments that cite it, its notes, and what playback needs (`audio`: the generation for `GET …/audio?g=`, where the WAV's first sample is, its length; null when there is nothing to hear). Version 2: its `tags` (ADR 039).",
  z.strictObject({
    recordingId: Uuid,
    name: RecordingName.nullable(),
    startedAtMs: WallMs,
    endedAtMs: WallMs,
    timeUncertain: z.boolean(),
    speakers: z.array(PhoneSpeaker).max(64),
    sentences: z.array(PhoneSentence),
    journal: z.array(PhoneJournalLine).max(500),
    notes: z.array(PhoneNote).max(500),
    tags: z.array(PhoneTagName).max(400).optional(),
    audio: z
      .strictObject({
        generation: z.int().min(1),
        startedAtMs: WallMs,
        durationMs: z.int().min(0),
      })
      .nullable(),
  }),
);
export type PhoneResult = z.output<typeof PhoneResult>;

export const GetRequest = named(
  "GetRequest",
  "A recording's result, with the revision the phone holds (null when it has none).",
  z.strictObject({ recordingId: Uuid, revision: Sha256Hex.nullable() }),
);
export type GetRequest = z.output<typeof GetRequest>;

export const GetAnswer = named(
  "GetAnswer",
  "`result`: the result and its revision (the SHA-256 of the result's JSON as sent). `unchanged`: the phone's revision is current. `unavailable`: no result now, with the recording's state. `withheld`: something was deleted while it was read; ask again.",
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("result"), revision: Sha256Hex, result: PhoneResult }),
    z.strictObject({ status: z.literal("unchanged") }),
    z.strictObject({
      status: z.literal("unavailable"),
      state: z.enum(["unknown", "receiving", "waiting", "transcribing", "deleted"]),
    }),
    z.strictObject({ status: z.literal("withheld") }),
  ]),
);
export type GetAnswer = z.output<typeof GetAnswer>;

// POST /v1/recordings/rename and /v1/recordings/note (M5.3): outbox operations

export const RenameRequest = named(
  "RenameRequest",
  "A name typed on the phone (null: back to the hour), and when it was typed: of two names, the later one typed wins.",
  z.strictObject({
    operationId: OperationId,
    recordingId: Uuid,
    name: RecordingName.nullable(),
    typedAtMs: WallMs,
  }),
);
export type RenameRequest = z.output<typeof RenameRequest>;

export const NoteRequest = named(
  "NoteRequest",
  "A note added on the phone to its recording's conversation; sent twice, it is one note.",
  z.strictObject({
    operationId: OperationId,
    recordingId: Uuid,
    text: z.string().min(1).max(20_000),
  }),
);
export type NoteRequest = z.output<typeof NoteRequest>;

export const TagRequest = named(
  "TagRequest",
  "A tag put on (`on`) or taken off the phone's recording (ADR 039), by its name as typed; the Mac cleans it and ignores one it refuses.",
  z.strictObject({
    operationId: OperationId,
    recordingId: Uuid,
    name: z.string().min(1).max(200),
    on: z.boolean(),
  }),
);
export type TagRequest = z.output<typeof TagRequest>;

export const VoiceRequest = named(
  "VoiceRequest",
  "« C'est moi »: the voice `ordinal` of the recording's transcript is the user, as « Moi ? » suggested (ADR 039). `sentenceId` is one of its sentences as the phone read them: a transcript made again since leaves the voice as it is.",
  z.strictObject({
    operationId: OperationId,
    recordingId: Uuid,
    ordinal: z.int().min(1),
    sentenceId: z.int().min(1),
  }),
);
export type VoiceRequest = z.output<typeof VoiceRequest>;

// POST /v1/tags (version 2): the Mac's tags, to offer on the phone, offline too.

export const TagsRequest = named("TagsRequest", "The Mac's tags: no fields.", z.strictObject({}));
export const TagsAnswer = named(
  "TagsAnswer",
  "The Mac's tags, the latest used first, 50 at most.",
  z.strictObject({ tags: z.array(PhoneTagName).max(50) }),
);
export type TagsAnswer = z.output<typeof TagsAnswer>;

export const OperationAnswer = named(
  "OperationAnswer",
  "`done`: applied, or already, or a later name won; the operation leaves the outbox. `later`: the Mac does not hold the recording yet; it stays. `deleted`: the recording was deleted; it leaves.",
  z.strictObject({ status: z.enum(["done", "later", "deleted"]) }),
);
export type OperationAnswer = z.output<typeof OperationAnswer>;

// POST /v1/forget: « Oublier ce Mac » on the phone revokes its own credential. Body `{}`.

export const ForgetRequest = named(
  "ForgetRequest",
  "« Oublier ce Mac »: no fields.",
  z.strictObject({}),
);
export const ForgetAnswer = named(
  "ForgetAnswer",
  "The credential is revoked.",
  z.strictObject({ status: z.literal("forgotten") }),
);

/** The routes and their bodies, for both sides' tests. */
export const PHONE_ROUTES = {
  pair: { path: "/v1/pair", request: PairRequest, answer: PairAnswer },
  hello: { path: "/v1/hello", request: HelloRequest, answer: HelloAnswer },
  announce: { path: "/v1/recordings/announce", request: AnnounceRequest, answer: UploadStatus },
  states: { path: "/v1/recordings/states", request: StatesRequest, answer: StatesAnswer },
  delete: { path: "/v1/recordings/delete", request: DeleteRequest, answer: DeleteAnswer },
  get: { path: "/v1/recordings/get", request: GetRequest, answer: GetAnswer },
  rename: { path: "/v1/recordings/rename", request: RenameRequest, answer: OperationAnswer },
  note: { path: "/v1/recordings/note", request: NoteRequest, answer: OperationAnswer },
  tag: { path: "/v1/recordings/tag", request: TagRequest, answer: OperationAnswer },
  voice: { path: "/v1/recordings/voice", request: VoiceRequest, answer: OperationAnswer },
  tags: { path: "/v1/tags", request: TagsRequest, answer: TagsAnswer },
  forget: { path: "/v1/forget", request: ForgetRequest, answer: ForgetAnswer },
} as const;

/** The upload's path for one recording, and its playback's with `?g=<generation>`. */
export const phoneAudioPath = (recordingId: string): string =>
  `/v1/recordings/${recordingId}/audio`;

/** The WAV playback serves, as `GET …/audio` answers it. */
export const PHONE_AUDIO_TYPE = "audio/wav";

/** Every message schema by name: the fixtures' `schema` field names one. */
export const PHONE_SYNC_SCHEMAS = {
  PairingInvite,
  PhoneRelayHello,
  PhoneError,
  PairRequest,
  PairAnswer,
  HelloRequest,
  HelloAnswer,
  AnnounceRequest,
  UploadStatus,
  StatesRequest,
  StatesAnswer,
  DeleteRequest,
  DeleteAnswer,
  GetRequest,
  GetAnswer,
  RenameRequest,
  NoteRequest,
  TagRequest,
  VoiceRequest,
  TagsRequest,
  TagsAnswer,
  OperationAnswer,
  ForgetRequest,
  ForgetAnswer,
} as const;
export type PhoneSyncSchemaName = keyof typeof PHONE_SYNC_SCHEMAS;
