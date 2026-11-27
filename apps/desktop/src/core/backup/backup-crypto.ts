import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import * as z from "zod";

// How a backup's frames are sealed (ADR 048), kept apart from the format so
// the protection can change alone. With a passphrase: scrypt gives the key,
// each frame is AES-256-GCM with a nonce of a random prefix and the frame's
// index, and the header and the « last frame » flag are authenticated, so a
// frame moved, cut off or changed fails. Without one, by the user's explicit
// choice, frames go as they are; the stream's SHA-256 and each file's still
// prove the file whole (backup-format).

const KEY_BYTES = 32;
const TAG_BYTES = 16;
const NONCE_PREFIX_BYTES = 8;
/** scrypt N = 2^17, r = 8: about 128 MiB and a few tenths of a second, once per backup. */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const CHECK_LABEL = "sondine-backup-passphrase-check";

export const MIN_PASSPHRASE_LENGTH = 12;

const Base64 = z.string().regex(/^[A-Za-z0-9+/]+=*$/);

export const BackupProtection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("passphrase"),
    cipher: z.literal("aes-256-gcm"),
    kdf: z.strictObject({
      name: z.literal("scrypt"),
      n: z
        .int()
        .min(2 ** 14)
        .max(2 ** 20),
      r: z.int().min(1).max(32),
      p: z.int().min(1).max(4),
      salt: Base64,
    }),
    noncePrefix: Base64,
    /** HMAC of a fixed label under the key: tells a wrong passphrase from a damaged file. */
    check: Base64,
  }),
]);
export type BackupProtection = z.output<typeof BackupProtection>;

/** Seals and opens one frame. `aad` is the clear header, the same for every frame. */
export interface FrameCodec {
  seal(index: number, final: boolean, plain: Buffer): Buffer;
  /** Throws `FrameRejected` when the frame is not the one sealed at this place. */
  open(index: number, final: boolean, sealed: Buffer): Buffer;
}

export class WrongPassphrase extends Error {
  override readonly name = "WrongPassphrase";
}

export class FrameRejected extends Error {
  override readonly name = "FrameRejected";
}

function deriveKey(
  passphrase: string,
  kdf: { n: number; r: number; p: number; salt: Buffer },
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase.normalize("NFC"),
      kdf.salt,
      KEY_BYTES,
      { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    ),
  );
}

const checkOf = (key: Buffer) => createHmac("sha256", key).update(CHECK_LABEL).digest();

function nonce(prefix: Buffer, index: number): Buffer {
  const value = Buffer.alloc(12);
  prefix.copy(value, 0);
  value.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  return value;
}

function frameAad(aad: Buffer, index: number, final: boolean): Buffer {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(index), 0);
  tail.writeUInt8(final ? 1 : 0, 8);
  return Buffer.concat([aad, tail]);
}

const plainCodec: FrameCodec = { seal: (_index, _final, plain) => plain, open: (_i, _f, s) => s };

function gcmCodec(key: Buffer, prefix: Buffer, aad: Buffer): FrameCodec {
  return {
    seal(index, final, plain) {
      const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, index));
      cipher.setAAD(frameAad(aad, index, final));
      return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    open(index, final, sealed) {
      if (sealed.length < TAG_BYTES) throw new FrameRejected("frame too short");
      const decipher = createDecipheriv("aes-256-gcm", key, nonce(prefix, index));
      decipher.setAAD(frameAad(aad, index, final));
      decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
      try {
        return Buffer.concat([
          decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
          decipher.final(),
        ]);
      } catch {
        throw new FrameRejected("frame does not authenticate");
      }
    },
  };
}

/** A new backup's protection: with a passphrase, a fresh salt and nonce prefix. */
export async function newProtection(passphrase: string | null): Promise<{
  readonly protection: BackupProtection;
  /** The codec once the clear header is known. */
  readonly codec: (aad: Buffer) => FrameCodec;
}> {
  if (passphrase === null) return { protection: { kind: "none" }, codec: () => plainCodec };
  const salt = randomBytes(16);
  const prefix = randomBytes(NONCE_PREFIX_BYTES);
  const key = await deriveKey(passphrase, { n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt });
  return {
    protection: {
      kind: "passphrase",
      cipher: "aes-256-gcm",
      kdf: { name: "scrypt", n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
      noncePrefix: prefix.toString("base64"),
      check: checkOf(key).toString("base64"),
    },
    codec: (aad) => gcmCodec(key, prefix, aad),
  };
}

/** The codec to read a backup; throws `WrongPassphrase` when the passphrase is not its own. */
export async function openProtection(
  protection: BackupProtection,
  passphrase: string | null,
  aad: Buffer,
): Promise<FrameCodec> {
  if (protection.kind === "none") return plainCodec;
  if (passphrase === null) throw new WrongPassphrase("this backup needs its passphrase");
  const key = await deriveKey(passphrase, {
    n: protection.kdf.n,
    r: protection.kdf.r,
    p: protection.kdf.p,
    salt: Buffer.from(protection.kdf.salt, "base64"),
  });
  const expected = Buffer.from(protection.check, "base64");
  const actual = checkOf(key);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new WrongPassphrase("the passphrase does not open this backup");
  }
  return gcmCodec(key, Buffer.from(protection.noncePrefix, "base64"), aad);
}
