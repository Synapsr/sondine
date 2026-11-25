import type { EpisodeSummary, PersonRef } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { dayPeople } from "./day-people-view";

const marie: PersonRef = { id: 4, name: "Marie", self: false };
const jean: PersonRef = { id: 5, name: "Jean", self: false };

const episode = (people: PersonRef[], recognized: PersonRef[]) =>
  ({ people, recognized }) as Pick<EpisodeSummary, "people" | "recognized"> as EpisodeSummary;

describe("the people of a day", () => {
  it("lists those Sondine recognized too, named once the user named them anywhere that day", () => {
    const people = dayPeople([
      episode([], [marie, jean]),
      episode([marie], []),
      episode([{ id: 1, name: "Téo", self: true }], []),
    ]);
    expect(people).toEqual([
      { person: marie, count: 2, named: true },
      { person: jean, count: 1, named: false },
    ]);
  });
});
