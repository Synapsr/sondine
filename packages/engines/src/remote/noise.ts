import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from "node:crypto";

// Noise_NK_25519_AESGCM_SHA256 (noiseprotocol.org, revision 34), the whole
// channel between this Mac and a compute server (ADR 040): the client knows
// the server's static key beforehand, so nothing between them (a tunnel, a
// proxy, the network) reads or changes a message. The first message is
// protected by that static key alone; every later one by keys both sides
// forget with the session. Checked against the public cacophony vector.

const PROTOCOL = "Noise_NK_25519_AESGCM_SHA256";
export const KEY_BYTES = 32;
export const TAG_BYTES = 16;

export class NoiseError extends Error {
  override readonly name = "NoiseError";
}

export interface KeyPair {
  readonly publicKey: Buffer;
  readonly privateKey: Buffer;
}

const EMPTY = Buffer.alloc(0);

export function generateKeyPair(): KeyPair {
  const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.d === undefined) throw new NoiseError("no x25519 key");
  return {
    publicKey: Buffer.from(jwk.x, "base64url"),
    privateKey: Buffer.from(jwk.d, "base64url"),
  };
}

function dh(own: KeyPair, theirs: Uint8Array): Buffer {
  if (theirs.length !== KEY_BYTES) throw new NoiseError("bad public key length");
  const x = Buffer.from(theirs).toString("base64url");
  let shared: Buffer;
  try {
    shared = diffieHellman({
      privateKey: createPrivateKey({
        format: "jwk",
        key: {
          kty: "OKP",
          crv: "X25519",
          x: own.publicKey.toString("base64url"),
          d: own.privateKey.toString("base64url"),
        },
      }),
      publicKey: createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "X25519", x } }),
    });
  } catch (error) {
    throw new NoiseError("key agreement failed", { cause: error });
  }
  // A low-order point would make the secret known to everyone.
  if (shared.every((byte) => byte === 0)) throw new NoiseError("weak public key");
  return shared;
}

const hmac = (key: Uint8Array, ...data: readonly Uint8Array[]) => {
  const mac = createHmac("sha256", key);
  for (const part of data) mac.update(part);
  return mac.digest();
};

function hkdf(chainingKey: Uint8Array, input: Uint8Array): [Buffer, Buffer] {
  const temp = hmac(chainingKey, input);
  const first = hmac(temp, Buffer.of(1));
  return [first, hmac(temp, first, Buffer.of(2))];
}

function nonceOf(counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

/** One direction's key. The caller never seals two different messages under one counter. */
export class CipherKey {
  private readonly key: Buffer;
  private wiped = false;

  constructor(key: Buffer) {
    this.key = key;
  }

  seal(counter: bigint, plain: Uint8Array, ad: Uint8Array = EMPTY): Buffer {
    if (this.wiped) throw new NoiseError("key forgotten");
    const cipher = createCipheriv("aes-256-gcm", this.key, nonceOf(counter));
    cipher.setAAD(ad);
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }

  open(counter: bigint, sealed: Uint8Array, ad: Uint8Array = EMPTY): Buffer {
    if (sealed.length < TAG_BYTES) throw new NoiseError("message too short");
    if (this.wiped) throw new NoiseError("key forgotten");
    const end = sealed.length - TAG_BYTES;
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonceOf(counter));
    decipher.setAAD(ad);
    decipher.setAuthTag(sealed.subarray(end));
    try {
      return Buffer.concat([decipher.update(sealed.subarray(0, end)), decipher.final()]);
    } catch (error) {
      throw new NoiseError("message not authentic", { cause: error });
    }
  }

  /** Forgets the key: nothing seals or opens with it any more. */
  wipe(): void {
    this.wiped = true;
    this.key.fill(0);
  }
}

class Symmetric {
  private ck: Buffer;
  private h: Buffer;
  private key: CipherKey | null = null;
  private counter = 0n;

  constructor(prologue: Uint8Array) {
    this.h = Buffer.alloc(32);
    this.h.write(PROTOCOL, "ascii");
    this.ck = Buffer.from(this.h);
    this.mixHash(prologue);
  }

  mixHash(data: Uint8Array): void {
    this.h = createHash("sha256").update(this.h).update(data).digest();
  }

  mixKey(input: Uint8Array): void {
    const [ck, key] = hkdf(this.ck, input);
    this.ck = ck;
    this.key = new CipherKey(key);
    this.counter = 0n;
  }

  seal(plain: Uint8Array): Buffer {
    if (this.key === null) throw new NoiseError("no key yet");
    const sealed = this.key.seal(this.counter++, plain, this.h);
    this.mixHash(sealed);
    return sealed;
  }

  open(sealed: Uint8Array): Buffer {
    if (this.key === null) throw new NoiseError("no key yet");
    const plain = this.key.open(this.counter++, sealed, this.h);
    this.mixHash(sealed);
    return plain;
  }

  split(): { toServer: CipherKey; toClient: CipherKey; hash: Buffer } {
    const [first, second] = hkdf(this.ck, EMPTY);
    return { toServer: new CipherKey(first), toClient: new CipherKey(second), hash: this.h };
  }
}

export interface Channel {
  readonly toServer: CipherKey;
  readonly toClient: CipherKey;
  /** The handshake's hash: the same on both sides, unique to this channel. */
  readonly hash: Buffer;
}

export interface Initiated {
  /** The first message: an ephemeral key, then the sealed payload. */
  readonly message: Buffer;
  /** Reads the server's answer. */
  finish(answer: Uint8Array): Channel & { readonly payload: Buffer };
}

export function initiate(
  serverKey: Uint8Array,
  payload: Uint8Array,
  prologue: Uint8Array,
  /** Tests only. */
  ephemeral: KeyPair = generateKeyPair(),
): Initiated {
  const state = new Symmetric(prologue);
  state.mixHash(serverKey);
  state.mixHash(ephemeral.publicKey);
  state.mixKey(dh(ephemeral, serverKey));
  const message = Buffer.concat([ephemeral.publicKey, state.seal(payload)]);
  return {
    message,
    finish(answer) {
      const theirs = answer.subarray(0, KEY_BYTES);
      state.mixHash(theirs);
      state.mixKey(dh(ephemeral, theirs));
      const opened = state.open(answer.subarray(KEY_BYTES));
      return { ...state.split(), payload: opened };
    },
  };
}

export interface Responded {
  readonly payload: Buffer;
  /** The client's ephemeral key: one per first message, so a replay shows. */
  readonly clientKey: Buffer;
  answer(payload: Uint8Array, ephemeral?: KeyPair): Channel & { readonly message: Buffer };
}

export function respond(server: KeyPair, message: Uint8Array, prologue: Uint8Array): Responded {
  const state = new Symmetric(prologue);
  state.mixHash(server.publicKey);
  const clientKey = Buffer.from(message.subarray(0, KEY_BYTES));
  state.mixHash(clientKey);
  state.mixKey(dh(server, clientKey));
  const payload = state.open(message.subarray(KEY_BYTES));
  return {
    payload,
    clientKey,
    answer(reply, ephemeral = generateKeyPair()) {
      state.mixHash(ephemeral.publicKey);
      state.mixKey(dh(ephemeral, clientKey));
      const sealed = state.seal(reply);
      return { ...state.split(), message: Buffer.concat([ephemeral.publicKey, sealed]) };
    },
  };
}
