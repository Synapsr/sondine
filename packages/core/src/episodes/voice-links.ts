// Linking a transcript's voices (architecture §8). Nemotron numbers the
// voices of each request on its own, and sometimes gives one person two
// numbers within a request: a 3 h 22 recording of four people came out as
// 25 voices. Voices whose embeddings are close are one person, grouped by
// average linkage: the two closest groups merge while they are at
// `LINK_SIMILARITY` or more.

/**
 * Average cosine similarity two groups of voices need to be one person.
 * Téo's 3 h 22 import (2026-11-08): one person 0.72–0.94 across and within
 * its 55-minute requests, two people at most 0.53; SUMM-RE room mixes: two
 * people at most 0.63.
 */
export const LINK_SIMILARITY = 0.7;

export interface VoiceToLink {
  readonly label: string;
  /** Voices of different tracks are never linked (the microphone and the Mac's sound). */
  readonly track: string;
  readonly vector: readonly number[];
  /**
   * Whom the user named the voice as. A named voice links only with voices
   * named as the same person: a name covers the speech it was given, so a
   * voice grown with unnamed speech could lose it, and a link never names.
   */
  readonly person?: string | null;
}

/**
 * Each voice's label once linked: the first label of its group, in the order
 * given (callers give voices in the order they first speak).
 */
export function linkVoices(
  voices: readonly VoiceToLink[],
  threshold = LINK_SIMILARITY,
): Map<string, string> {
  const unit = voices.map((voice) => {
    const norm = Math.hypot(...voice.vector);
    return voice.vector.map((value) => (norm === 0 ? 0 : value / norm));
  });
  const similarity = unit.map((a) =>
    unit.map((b) => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)),
  );
  let groups = voices.map((_, index) => [index]);
  // Every voice of a group has the same name, or none.
  const person = (group: readonly number[]) => voices[group[0] ?? 0]?.person ?? null;
  const linkable = (a: readonly number[], b: readonly number[]) =>
    voices[a[0] ?? 0]?.track === voices[b[0] ?? 0]?.track && person(a) === person(b);
  const average = (a: readonly number[], b: readonly number[]) => {
    let sum = 0;
    for (const i of a) for (const j of b) sum += similarity[i]?.[j] ?? 0;
    return sum / (a.length * b.length);
  };
  for (;;) {
    let best: { i: number; j: number; score: number } | null = null;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i] ?? [];
        const b = groups[j] ?? [];
        if (!linkable(a, b)) continue;
        const score = average(a, b);
        if (score >= threshold && (best === null || score > best.score)) best = { i, j, score };
      }
    }
    if (best === null) break;
    const { i, j } = best;
    groups = groups.flatMap((group, index) =>
      index === i ? [[...group, ...(groups[j] ?? [])]] : index === j ? [] : [group],
    );
  }
  const links = new Map<string, string>();
  for (const group of groups) {
    const first = voices[Math.min(...group)]?.label;
    if (first === undefined) continue;
    for (const index of group) {
      const label = voices[index]?.label;
      if (label !== undefined) links.set(label, first);
    }
  }
  return links;
}
