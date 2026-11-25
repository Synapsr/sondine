import { execFile } from "node:child_process";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// The Mac's TLS identity for phones (ADR 008): a P-256 key and a
// self-signed certificate, made with macOS's `/usr/bin/openssl` at the first
// pairing, in `<data>/lan/` (0700, files 0600). The relay loads it as a
// PKCS#12 bundle (`SecPKCS12Import`), whose random password sits beside it.
// Phones trust nothing but the key: its pin is the SHA-256 of the public
// key's SubjectPublicKeyInfo (DER). Whoever copies these files can pass for
// the Mac; « Réinitialiser l'appairage » makes a new key.

const OPENSSL = "/usr/bin/openssl";
const CERTIFICATE = "cert.pem";
const BUNDLE = "identity.p12";
const PASSWORD = "identity.pass";

/**
 * A P-256 private key in DER (SEC 1, with its curve and public key) when its
 * scalar has all 32 bytes. About one key in 256 has a zero top byte, which
 * `/usr/bin/openssl` writes in 31 bytes; inside the PKCS#12 bundle too, and
 * `SecPKCS12Import` then finds no identity. Such a key is made again.
 */
export const FULL_KEY_DER_BYTES = 121;
const KEY_ATTEMPTS = 64;

export interface LanIdentity {
  /** The PKCS#12 bundle the relay loads, and the file holding its password. */
  readonly bundlePath: string;
  readonly passwordPath: string;
  /** SHA-256 of the public key (SubjectPublicKeyInfo, DER), lowercase hex. */
  readonly pin: string;
}

function openssl(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(OPENSSL, [...args], { timeout: 30_000, env: {} }, (error, _stdout, stderr) => {
      if (error === null) resolve();
      else
        reject(
          new Error(`openssl ${args[0] ?? ""} failed: ${String(stderr).trim().slice(0, 300)}`),
        );
    });
  });
}

/** The length of a private key's DER, as openssl writes it. */
export function keyDerLength(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      OPENSSL,
      ["ec", "-in", path, "-outform", "DER"],
      { timeout: 30_000, env: {}, encoding: "buffer" },
      (error, stdout) => (error === null ? resolve(stdout.length) : reject(error)),
    );
  });
}

/**
 * Writes a P-256 private key to `path`, made again until its DER is whole
 * (`FULL_KEY_DER_BYTES`); the number of attempts it took.
 */
export async function generateKey(
  path: string,
  derLength: (path: string) => Promise<number> = keyDerLength,
): Promise<number> {
  for (let attempt = 1; attempt <= KEY_ATTEMPTS; attempt += 1) {
    await openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", path]);
    chmodSync(path, 0o600);
    if ((await derLength(path)) === FULL_KEY_DER_BYTES) return attempt;
  }
  throw new Error(`no whole P-256 key in ${KEY_ATTEMPTS} attempts`);
}

/** The pin of a certificate or public key in PEM. */
export function keyPin(pem: string): string {
  const spki = createPublicKey(pem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("hex");
}

/** The identity in `dir`, or null when there is none (or it is incomplete). */
export function readLanIdentity(dir: string): LanIdentity | null {
  const bundlePath = join(dir, BUNDLE);
  const passwordPath = join(dir, PASSWORD);
  const certificate = join(dir, CERTIFICATE);
  if (!existsSync(bundlePath) || !existsSync(passwordPath) || !existsSync(certificate)) return null;
  try {
    return { bundlePath, passwordPath, pin: keyPin(readFileSync(certificate, "utf8")) };
  } catch {
    return null;
  }
}

/**
 * Makes a new identity in `dir`, replacing any: written in a sibling
 * folder, then renamed over it, so a crash leaves the old one or the new.
 */
export async function createLanIdentity(dir: string): Promise<LanIdentity> {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const work = `${dir}.new-${randomBytes(4).toString("hex")}`;
  mkdirSync(work, { mode: 0o700 });
  try {
    const key = join(work, "key.pem");
    const password = join(work, PASSWORD);
    writeFileSync(password, randomBytes(32).toString("base64url"), { mode: 0o600 });
    await generateKey(key);
    await openssl([
      "req",
      "-new",
      "-x509",
      "-sha256",
      "-key",
      key,
      "-out",
      join(work, CERTIFICATE),
      "-days",
      "3650",
      "-subj",
      "/CN=Sondine",
    ]);
    // SHA-1 and 3DES: what SecPKCS12Import reads on every macOS this runs on.
    await openssl([
      "pkcs12",
      "-export",
      "-inkey",
      key,
      "-in",
      join(work, CERTIFICATE),
      "-out",
      join(work, BUNDLE),
      "-name",
      "Sondine",
      "-keypbe",
      "PBE-SHA1-3DES",
      "-certpbe",
      "PBE-SHA1-3DES",
      "-macalg",
      "sha1",
      "-passout",
      `file:${password}`,
    ]);
    // The bundle holds the key: one copy is enough.
    rmSync(key);
    for (const file of [CERTIFICATE, BUNDLE, PASSWORD]) chmodSync(join(work, file), 0o600);
    rmSync(dir, { recursive: true, force: true });
    renameSync(work, dir);
    chmodSync(dir, 0o700);
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
  const identity = readLanIdentity(dir);
  if (identity === null) throw new Error("the new identity cannot be read");
  return identity;
}
