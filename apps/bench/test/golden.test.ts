import { describe, expect, it } from "vitest";
import { formatReference, formatTime, parseReference, seedTurns } from "../src/golden/golden.ts";

describe("golden set references", () => {
  it("round-trips the text Téo edits, overlaps included", () => {
    const reference = {
      status: "à corriger" as const,
      voices: "S1 = Moi, S2 = Léa",
      turns: [
        { startSec: 1.2, endSec: 4.8, speaker: "S1", text: "Bonjour, ça va ?" },
        { startSec: 4.5, endSec: 6, speaker: "S2", text: "Oui : et toi ?" },
      ],
    };
    const text = formatReference("Un appel en français", reference);
    expect(text).toContain("[00:00:01.2 → 00:00:04.8] S1: Bonjour, ça va ?");
    expect(parseReference(text)).toEqual(reference);
    expect(parseReference(text.replace("statut: à corriger", "statut: corrigé")).status).toBe(
      "corrigé",
    );
  });

  it("says which line is wrong", () => {
    expect(() => parseReference("# statut: corrigé\nBonjour sans heure\n")).toThrow(/line 2/);
    expect(() => parseReference("[00:00:05.0 → 00:00:04.0] S1: à l'envers\n")).toThrow(/line 1/);
  });

  it("formats times past an hour", () => {
    expect(formatTime(3723.44)).toBe("01:02:03.4");
  });

  it("gives each segment the speaker it overlaps most, numbered by first appearance", () => {
    const turns = seedTurns(
      [
        { startSec: 0, endSec: 2, text: "Salut." },
        { startSec: 2, endSec: 5, text: "Ça va ?" },
        { startSec: 5, endSec: 6, text: "" },
        { startSec: 6, endSec: 7, text: "Hum." },
      ],
      [
        { speaker: "speaker_3", startSec: 0, endSec: 2.5 },
        { speaker: "speaker_0", startSec: 2.5, endSec: 5 },
      ],
    );
    expect(turns.map((turn) => turn.speaker)).toEqual(["S1", "S2", "?"]);
  });
});
