import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKeyPair, initiate, NoiseError, respond, type KeyPair } from "./noise.ts";

const hex = (text: string) => Buffer.from(text, "hex");

/** A key pair from the raw private key the vector gives. */
function pair(privateHex: string): KeyPair {
  const der = Buffer.concat([hex("302e020100300506032b656e04220420"), hex(privateHex)]);
  const key = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  return {
    privateKey: hex(privateHex),
    publicKey: Buffer.from(key.export({ format: "jwk" }).x ?? "", "base64url"),
  };
}

// haskell-cryptography/cacophony, vectors/cacophony.txt, Noise_NK_25519_AESGCM_SHA256.
const vector = {
  prologue: hex("4a6f686e2047616c74"),
  clientEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  serverStatic: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  serverEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  hash: "f8a87aa8add4fea6e33365b89637486c2f6564546ce29d1df9ce9abf78c507d7",
  messages: [
    [
      "4c756477696720766f6e204d69736573",
      "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c794475ab4d66d222457dd414bc5f296bc7b4078cc7d72af5192628b68bca7d28844b",
    ],
    [
      "4d757272617920526f746862617264",
      "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884303c7d89310502baa8299520ba451624c3c0492e2698f8d457c32400b91fd8a",
    ],
    ["462e20412e20486179656b", "304f70c37c93573099228016d54cb15213af94eb598d1b17df1153"],
    ["4361726c204d656e676572", "a1bf6c954529f29b31d8ae9f67d2c18dbd332aa1a0918690c6d80b"],
  ],
} as const;

describe("noise", () => {
  it("gives the public vector's bytes", () => {
    const server = pair(vector.serverStatic);
    const [first, second, toServer, toClient] = vector.messages;
    const client = initiate(
      server.publicKey,
      hex(first[0]),
      vector.prologue,
      pair(vector.clientEphemeral),
    );
    expect(client.message.toString("hex")).toBe(first[1]);
    const received = respond(server, client.message, vector.prologue);
    expect(received.payload.toString("hex")).toBe(first[0]);
    const answered = received.answer(hex(second[0]), pair(vector.serverEphemeral));
    expect(answered.message.toString("hex")).toBe(second[1]);
    const opened = client.finish(answered.message);
    expect(opened.payload.toString("hex")).toBe(second[0]);
    expect(opened.hash.toString("hex")).toBe(vector.hash);
    expect(answered.hash.toString("hex")).toBe(vector.hash);
    expect(opened.toServer.seal(0n, hex(toServer[0])).toString("hex")).toBe(toServer[1]);
    expect(answered.toClient.seal(0n, hex(toClient[0])).toString("hex")).toBe(toClient[1]);
    expect(answered.toServer.open(0n, hex(toServer[1])).toString("hex")).toBe(toServer[0]);
  });

  it("refuses another server's key, another prologue and a changed byte", () => {
    const server = generateKeyPair();
    const prologue = Buffer.from("test");
    const { message } = initiate(server.publicKey, Buffer.from("hello"), prologue);
    expect(() => respond(generateKeyPair(), message, prologue)).toThrow(NoiseError);
    expect(() => respond(server, message, Buffer.from("other"))).toThrow(NoiseError);
    const changed = Buffer.from(message);
    changed[40] = (changed[40] ?? 0) ^ 1;
    expect(() => respond(server, changed, prologue)).toThrow(NoiseError);
    expect(() => respond(server, message.subarray(0, 20), prologue)).toThrow(NoiseError);
  });

  it("refuses an answer from anyone else, a weak key and a wrong counter or label", () => {
    const server = generateKeyPair();
    const prologue = Buffer.from("test");
    const client = initiate(server.publicKey, Buffer.from("hello"), prologue);
    const impostor = initiate(server.publicKey, Buffer.from("hello"), prologue);
    const answer = respond(server, impostor.message, prologue).answer(Buffer.from("ok"));
    expect(() => client.finish(answer.message)).toThrow(NoiseError);
    expect(() => initiate(Buffer.alloc(32), Buffer.from("x"), prologue)).toThrow(NoiseError);
    const channel = impostor.finish(answer.message);
    const sealed = channel.toServer.seal(3n, Buffer.from("audio"), Buffer.from("a"));
    expect(() => answer.toServer.open(4n, sealed, Buffer.from("a"))).toThrow(NoiseError);
    expect(() => answer.toServer.open(3n, sealed, Buffer.from("b"))).toThrow(NoiseError);
    expect(answer.toServer.open(3n, sealed, Buffer.from("a")).toString()).toBe("audio");
    answer.toServer.wipe();
    expect(() => answer.toServer.open(3n, sealed, Buffer.from("a"))).toThrow(NoiseError);
  });
});
