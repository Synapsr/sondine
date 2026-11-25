import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLanIdentity,
  FULL_KEY_DER_BYTES,
  generateKey,
  keyDerLength,
  readLanIdentity,
} from "./lan-identity";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!existsSync("/usr/bin/openssl"))("the Mac's TLS identity", () => {
  it("is a private P-256 key in a PKCS#12 bundle, pinned by its public key", async () => {
    const data = mkdtempSync(join(tmpdir(), "sondine-lan-"));
    dirs.push(data);
    const dir = join(data, "lan");
    expect(readLanIdentity(dir)).toBeNull();
    const identity = await createLanIdentity(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of ["identity.p12", "identity.pass", "cert.pem"]) {
      expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
    }
    // One copy of the key: in the bundle.
    expect(existsSync(join(dir, "key.pem"))).toBe(false);
    const certificate = new X509Certificate(readFileSync(join(dir, "cert.pem")));
    expect(certificate.publicKey.asymmetricKeyType).toBe("ec");
    expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    // The pin as openssl computes it from the certificate, apart from Node.
    const publicPem = execFileSync("/usr/bin/openssl", [
      "x509",
      "-pubkey",
      "-noout",
      "-in",
      join(dir, "cert.pem"),
    ]);
    const der = execFileSync("/usr/bin/openssl", ["pkey", "-pubin", "-outform", "DER"], {
      input: publicPem,
    });
    expect(identity.pin).toBe(createHash("sha256").update(der).digest("hex"));
    expect(identity.pin).toMatch(/^[0-9a-f]{64}$/);
    // The relay reads the password as the whole file: no newline.
    expect(readFileSync(identity.passwordPath, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The key inside the bundle is whole: what SecPKCS12Import reads.
    const keyPem = execFileSync("/usr/bin/openssl", [
      "pkcs12",
      "-in",
      identity.bundlePath,
      "-nocerts",
      "-nodes",
      "-passin",
      `file:${identity.passwordPath}`,
    ]);
    const keyDer = execFileSync("/usr/bin/openssl", ["ec", "-outform", "DER"], { input: keyPem });
    expect(keyDer.length).toBe(FULL_KEY_DER_BYTES);
    expect(readLanIdentity(dir)).toEqual(identity);
    // « Réinitialiser l'appairage »: a new key.
    const again = await createLanIdentity(dir);
    expect(again.pin).not.toBe(identity.pin);
  });

  it("makes the key again until its DER is whole, which SecPKCS12Import needs", async () => {
    const data = mkdtempSync(join(tmpdir(), "sondine-key-"));
    dirs.push(data);
    const key = join(data, "key.pem");
    // A key whose top byte is zero comes out short: made again, twice here.
    const lengths = [120, 120, FULL_KEY_DER_BYTES];
    const seen: number[] = [];
    const attempts = await generateKey(key, async (path) => {
      seen.push(await keyDerLength(path));
      return lengths[seen.length - 1] ?? 0;
    });
    expect(attempts).toBe(3);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    // Real keys, as openssl wrote them: whole ones are 121 bytes, short ones 120.
    for (const length of seen) expect([120, FULL_KEY_DER_BYTES]).toContain(length);
    expect(await keyDerLength(key)).toBe(seen.at(-1));
    await expect(generateKey(key, async () => 120)).rejects.toThrow(/no whole P-256 key/);
  });
});
