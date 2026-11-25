import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { corpusSchema } from "./schema.ts";

it("keeps short acknowledgements positive and media speech separate from noise", async () => {
  const corpus = corpusSchema.parse(
    JSON.parse(await readFile(new URL("./corpus.json", import.meta.url), "utf8")),
  );
  const frenchWords = corpus.sources.filter(
    (source) => source.language === "fr" && source.role === "word",
  );
  expect(frenchWords).toHaveLength(9);
  expect(frenchWords.find((source) => source.category === "backchannel")?.id).toBe(
    "fr-hum-loquaxfr",
  );
  expect(corpus.sources.filter((source) => source.role === "noise")).toHaveLength(5);
  expect(
    corpus.sources
      .filter((source) => source.role === "noise")
      .every((source) => source.language === null),
  ).toBe(true);
  expect(
    corpus.sources
      .filter((source) => source.category === "read-speech-proxy")
      .every((source) => source.role === "spoken-proxy"),
  ).toBe(true);
});
