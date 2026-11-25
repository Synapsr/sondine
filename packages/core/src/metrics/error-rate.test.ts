import { describe, expect, it } from "vitest";

import { frNorm } from "../text/fr-norm";
import {
  ERROR_RATE_VERSION,
  charErrorRate,
  rateOf,
  sumErrorCounts,
  wordErrorRate,
} from "./error-rate";

const counts = (r: {
  hits: number;
  substitutions: number;
  insertions: number;
  deletions: number;
}) => ({
  H: r.hits,
  S: r.substitutions,
  I: r.insertions,
  D: r.deletions,
});

describe("wordErrorRate (hand-computed)", () => {
  it("counts one deletion", () => {
    const r = wordErrorRate("le chat est noir", "le chat noir");
    expect(counts(r)).toEqual({ H: 3, S: 0, I: 0, D: 1 });
    expect(r.rate).toBe(0.25);
    expect(r.alignment?.map((step) => step.op)).toEqual(["match", "match", "deletion", "match"]);
    expect(r.alignment?.[2]).toEqual({
      op: "deletion",
      ref: "est",
      hyp: null,
      refIndex: 2,
      hypIndex: null,
    });
  });

  it("counts one substitution", () => {
    const r = wordErrorRate("a b c", "a x c");
    expect(counts(r)).toEqual({ H: 2, S: 1, I: 0, D: 0 });
    expect(r.rate).toBeCloseTo(1 / 3, 12);
    expect(r.alignment?.[1]).toEqual({
      op: "substitution",
      ref: "b",
      hyp: "x",
      refIndex: 1,
      hypIndex: 1,
    });
  });

  it("counts insertions and can exceed 100 %", () => {
    const r = wordErrorRate("a b", "a b c d");
    expect(counts(r)).toEqual({ H: 2, S: 0, I: 2, D: 0 });
    expect(r.rate).toBe(1);
    const worse = wordErrorRate("oui", "non non non");
    expect(counts(worse)).toEqual({ H: 0, S: 1, I: 2, D: 0 });
    expect(worse.rate).toBe(3);
  });

  it("prefers a hit with an insertion and a deletion over two substitutions", () => {
    // Both cost 2; "a b"→"b c" keeps "b" aligned: D(a), H(b), I(c).
    const r = wordErrorRate("a b", "b c");
    expect(counts(r)).toEqual({ H: 1, S: 0, I: 1, D: 1 });
    expect(r.alignment?.map((step) => step.op)).toEqual(["deletion", "match", "insertion"]);
  });

  it("matches the classic English example", () => {
    // the cat sat on the mat / the cat sit on mat: S(sat→sit), D(the).
    const r = wordErrorRate("the cat sat on the mat", "the cat sit on mat");
    expect(counts(r)).toEqual({ H: 4, S: 1, I: 0, D: 1 });
    expect(r.errors).toBe(2);
    expect(r.rate).toBeCloseTo(2 / 6, 12);
  });

  it("handles a French sentence after fr-norm", () => {
    const ref = frNorm("Euh, j'ai vu 3 chats aujourd'hui à 14h30.");
    const hyp = frNorm("J’ai vu trois chat aujourd’hui à quatorze heures.");
    expect(ref).toBe("j' ai vu trois chats aujourd'hui à quatorze heures trente");
    expect(hyp).toBe("j' ai vu trois chat aujourd'hui à quatorze heures");
    const r = wordErrorRate(ref, hyp);
    // 10 reference words: S(chats→chat), D(trente).
    expect(counts(r)).toEqual({ H: 8, S: 1, I: 0, D: 1 });
    expect(r.rate).toBe(0.2);
  });

  it("handles empty inputs", () => {
    expect(wordErrorRate("", "").rate).toBe(0);
    const deleted = wordErrorRate("bonjour à tous", "");
    expect(counts(deleted)).toEqual({ H: 0, S: 0, I: 0, D: 3 });
    expect(deleted.rate).toBe(1);
    const inserted = wordErrorRate("", "bonjour");
    expect(counts(inserted)).toEqual({ H: 0, S: 0, I: 1, D: 0 });
    expect(inserted.rate).toBeNull();
    expect(wordErrorRate("   ", "  ").refLength).toBe(0);
  });

  it("accepts token arrays", () => {
    const r = wordErrorRate(["l'", "homme"], ["l", "homme"]);
    expect(counts(r)).toEqual({ H: 1, S: 1, I: 0, D: 0 });
  });

  it("returns counts only on request", () => {
    const r = wordErrorRate("a b c d", "a c d e", { alignment: false });
    expect(r.alignment).toBeNull();
    expect(counts(r)).toEqual({ H: 3, S: 0, I: 1, D: 1 });
  });
});

describe("charErrorRate (hand-computed)", () => {
  it("counts kitten → sitting as two substitutions and one insertion", () => {
    // LCS("kitten", "sitting") = 4, so S0/D1/I2 is impossible at distance 3.
    const r = charErrorRate("kitten", "sitting");
    expect(counts(r)).toEqual({ H: 4, S: 2, I: 1, D: 0 });
    expect(r.rate).toBe(0.5);
  });

  it("counts spaces and code points", () => {
    const r = charErrorRate("chat", "chats");
    expect(counts(r)).toEqual({ H: 4, S: 0, I: 1, D: 0 });
    expect(r.rate).toBe(0.25);
    expect(charErrorRate("a b", "ab").deletions).toBe(1);
    expect(charErrorRate("été", "ete").substitutions).toBe(2);
    expect(charErrorRate("😀a", "a").refLength).toBe(2);
  });
});

describe("aggregation", () => {
  it("sums counts instead of averaging rates", () => {
    const total = sumErrorCounts([wordErrorRate("a b c d", "a b c d"), wordErrorRate("e f", "e")]);
    expect(total.refLength).toBe(6);
    expect(total.errors).toBe(1);
    expect(total.rate).toBeCloseTo(1 / 6, 12);
    expect(sumErrorCounts([]).rate).toBe(0);
    expect(rateOf({ errors: 2, refLength: 0 })).toBeNull();
  });

  it("is versioned", () => {
    expect(ERROR_RATE_VERSION).toBe("error-rate/1");
  });
});

function levenshtein(a: readonly string[], b: readonly string[]): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next.push(
        Math.min(
          (row[j] ?? 0) + 1,
          (next[j - 1] ?? 0) + 1,
          (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("properties", () => {
  it("agrees with a plain Levenshtein distance and keeps the counts consistent", () => {
    const next = random(7);
    const vocabulary = ["le", "la", "chat", "chien", "est", "noir", "a"];
    const sentence = (): string[] =>
      Array.from(
        { length: Math.floor(next() * 12) },
        () => vocabulary[Math.floor(next() * vocabulary.length)] ?? "le",
      );
    for (let trial = 0; trial < 300; trial += 1) {
      const ref = sentence();
      const hyp = sentence();
      const full = wordErrorRate(ref, hyp);
      const fast = wordErrorRate(ref, hyp, { alignment: false });
      expect(full.errors).toBe(levenshtein(ref, hyp));
      expect({ ...fast, alignment: null }).toEqual({ ...full, alignment: null });
      expect(full.hits + full.substitutions + full.deletions).toBe(ref.length);
      expect(full.hits + full.substitutions + full.insertions).toBe(hyp.length);
      expect(full.alignment?.filter((s) => s.ref !== null).map((s) => s.ref)).toEqual(ref);
      expect(full.alignment?.filter((s) => s.hyp !== null).map((s) => s.hyp)).toEqual(hyp);
    }
  });
});
