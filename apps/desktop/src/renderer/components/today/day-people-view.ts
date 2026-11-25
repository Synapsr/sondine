import type { EpisodeSummary, PersonRef } from "@sondine/api";

/** The people of a day's conversations, the user left out, most conversations first; `named` when the user named them in one. */
export function dayPeople(
  conversations: readonly EpisodeSummary[],
): { readonly person: PersonRef; readonly count: number; readonly named: boolean }[] {
  const counts = new Map<number, { person: PersonRef; count: number; named: boolean }>();
  for (const episode of conversations) {
    const there = [
      ...episode.people.map((person) => ({ person, named: true })),
      ...episode.recognized.map((person) => ({ person, named: false })),
    ];
    for (const { person, named } of there) {
      if (person.self) continue;
      const known = counts.get(person.id);
      counts.set(person.id, {
        person,
        count: (known?.count ?? 0) + 1,
        named: named || known?.named === true,
      });
    }
  }
  return [...counts.values()].toSorted(
    (a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name),
  );
}
