// The code signing identity of a build (ADR 010): build-mac.mjs signs the app
// and its helpers with it, check-package.mjs signs its sandbox twin with it.
import { execFileSync } from "node:child_process";

export const DEFAULT_IDENTITY = "Developer ID Application: Téo Goulois (P5G8WAJ2G2)";

// codesign decodes its arguments in the CoreFoundation default encoding,
// MacRoman unless the user set another, and then finds no "Téo" certificate.
// Every child of the build scripts runs in UTF-8; helpers are signed by hash.
export const utf8TextEncoding = `0x${process.getuid().toString(16).toUpperCase()}:0x8000100:0x0`;

/**
 * `SONDINE_SIGN_IDENTITY` (default: the Developer ID certificate), or `-` for
 * an ad-hoc build. `sign` is what codesign takes: the certificate's SHA-1, or
 * `-`. Null when the keychain has no such certificate.
 */
export function signingIdentity() {
  const name = process.env.SONDINE_SIGN_IDENTITY ?? DEFAULT_IDENTITY;
  if (name === "-") return { name, adHoc: true, sign: "-" };
  const listing = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  const line = listing.split("\n").find((entry) => entry.includes(`"${name}"`));
  const hash = line?.match(/\b[0-9A-F]{40}\b/)?.[0];
  return hash === undefined ? null : { name, adHoc: false, sign: hash };
}
