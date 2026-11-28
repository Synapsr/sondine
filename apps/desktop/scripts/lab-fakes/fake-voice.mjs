// The flow lab's `sondine-voice embed` (ADR 049): no model. It answers the
// voice read (key `read`) with a fixed embedding and the speech its pieces
// hold, and refuses any other voice, so the lab's invented episodes get no
// suggestion they did not have before.
//
//   fake-voice.mjs embed --model <unused>   (the request on stdin, JSON)
import { createHash } from "node:crypto";

if (process.argv[2] !== "embed") {
  console.error("usage: embed --model <path>");
  process.exit(2);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { speakers } = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const embedding = (key) => {
  const bytes = createHash("sha512").update(key).digest();
  const raw = Array.from(
    { length: 256 },
    (_, index) => (bytes[index % bytes.length] ?? 0) - 128 + (index % 7),
  );
  const norm = Math.hypot(...raw) || 1;
  return raw.map((value) => value / norm);
};

const read = speakers.filter(({ key }) => key === "read");
process.stdout.write(
  JSON.stringify({
    modelVersion: "flow-lab-fake",
    speakers: read.map(({ key, pieces }) => ({
      key,
      embedding: embedding(key),
      // Base64 PCM16 at 16 kHz: 4 characters for 3 bytes, 2 bytes a sample.
      speechMs: Math.round(
        pieces.reduce((total, piece) => total + (piece.length * 3) / 4 / 2, 0) / 16,
      ),
    })),
    errors: speakers
      .filter(({ key }) => key !== "read")
      .map(({ key }) => ({ key, message: "the flow lab embeds only the voice read" })),
  }),
);
