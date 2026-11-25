import { FR_NORM_ALIGN_VERSION } from "@sondine/core";
import { afterEach, describe, expect, it } from "vitest";
import { publishAnalysis } from "./publish";
import { searchSegments } from "./search";
import { compileSearchQuery, highlightRanges, searchHighlightsId } from "./search-match";
import { searchNormalizerId } from "./search-text";
import { seedEpisode, segment, startRun, tempDatabase, type TempDatabase } from "./test-helpers";

/** The text with each highlight in brackets. */
function marked(text: string, query: string, lang: string | null = null): string {
  let out = "";
  let at = 0;
  for (const range of highlightRanges(text, lang, compileSearchQuery(query))) {
    out += `${text.slice(at, range.start)}[${text.slice(range.start, range.end)}]`;
    at = range.end;
  }
  return out + text.slice(at);
}

describe("compileSearchQuery", () => {
  it("quotes each typed word as one phrase, so FTS5 syntax in the input is inert", () => {
    expect(compileSearchQuery('l\'image "de" NEAR(a b) OR -x*', { prefix: false }).match).toBe(
      '"l image" AND "de" AND "near a" AND "b" AND "or" AND "x"',
    );
  });

  it("keeps what one word normalizes to together", () => {
    expect(compileSearchQuery("22", { prefix: false }).match).toBe('("vingt deux") OR ("22")');
    expect(compileSearchQuery("l'école 10h30").match).toBe(
      '("l ecole" AND "dix heures trente"*) OR ("l ecole" AND "10h30"*)',
    );
    expect(compileSearchQuery("rendez-vous").match).toBe('"rendez vous"*');
  });

  it("makes the last word a prefix when it has two letters or more", () => {
    expect(compileSearchQuery("budget sem").match).toBe('"budget" AND "sem"*');
    expect(compileSearchQuery("budget s").match).toBe('"budget" AND "s"');
  });

  it("returns no expression when nothing is searchable", () => {
    expect(compileSearchQuery("  ... !! ")).toEqual({ forms: [], match: null });
  });
});

describe("highlightRanges", () => {
  it("finds a word typed without accents or capitals", () => {
    expect(marked("L'École est fermée demain.", "ecole")).toBe("L'[École] est fermée demain.");
    expect(marked("L'École est fermée demain.", "ÉCOLE FERMEE")).toBe(
      "L'[École] est [fermée] demain.",
    );
  });

  it("marks the whole phrase an elided word makes, and only it", () => {
    const text = "Alors, pour Léa, l’inscription à l'école pour la rentrée.";
    expect(marked(text, "l'école")).toBe(
      "Alors, pour Léa, l’inscription à [l'école] pour la rentrée.",
    );
    expect(marked(text, "ecole")).toBe(
      "Alors, pour Léa, l’inscription à l'[école] pour la rentrée.",
    );
    expect(marked(text, "inscription")).toBe(
      "Alors, pour Léa, l’[inscription] à l'école pour la rentrée.",
    );
  });

  it("never marks a filler, which the index drops", () => {
    const text = "Il faudrait renvoyer le devis, euh, voilà.";
    expect(marked(text, "euh")).toBe(text);
    expect(marked(text, "euh voila")).toBe("Il faudrait renvoyer le devis, euh, [voilà].");
  });

  it("matches digits and number words both ways", () => {
    expect(marked("On perd 15 % de remise.", "quinze")).toBe("On perd [15 %] de remise.");
    expect(marked("On perd quinze pour cent de remise.", "15 %")).toBe(
      "On perd [quinze pour cent] de remise.",
    );
    expect(marked("Il y avait 22 personnes.", "vingt-deux")).toBe("Il y avait [22] personnes.");
    expect(marked("Il y avait vingt-deux personnes.", "22")).toBe(
      "Il y avait [vingt-deux] personnes.",
    );
    expect(marked("Ça fait 1 000 euros.", "mille")).toBe("Ça fait [1 000] euros.");
    expect(marked("Rendez-vous à 10 h 30 devant.", "10h30")).toBe(
      "Rendez-vous à [10 h 30] devant.",
    );
    expect(marked("Rendez-vous à dix heures trente.", "10h30")).toBe(
      "Rendez-vous à [dix heures trente].",
    );
  });

  it("marks the whole word a prefix starts, never the inside of a word", () => {
    expect(marked("L'école est fermée.", "eco")).toBe("L'[école] est fermée.");
    expect(marked("Le rendez-vous est pris.", "rend")).toBe("Le [rendez]-vous est pris.");
    expect(marked("L'école est fermée.", "cole")).toBe("L'école est fermée.");
    expect(marked("Bonjour, on y va.", "on")).toBe("Bonjour, [on] y va.");
    expect(marked("Bonjour, on y va.", "on", null)).not.toContain("B[on");
  });

  it("finds English text with English rules", () => {
    expect(marked("We talked about the budget for next week.", "next week", "en")).toBe(
      "We talked about the budget for [next] [week].",
    );
    expect(marked("Don't worry, it costs 1,000 bucks.", "don't", "en")).toBe(
      "[Don't] worry, it costs 1,000 bucks.",
    );
    expect(marked("Don't worry, it costs 1,000 bucks.", "1000", "en")).toBe(
      "Don't worry, it costs [1,000] bucks.",
    );
  });

  it("marks nothing unless every word of the query is there", () => {
    expect(marked("L'école est fermée.", "école piscine")).toBe("L'école est fermée.");
  });

  it("is versioned with the normalizer", () => {
    expect(searchHighlightsId).toBe(`${FR_NORM_ALIGN_VERSION};${searchNormalizerId}`);
  });
});

describe("highlights agree with FTS5", () => {
  let temp: TempDatabase | undefined;
  afterEach(() => temp?.cleanup());

  const corpus: readonly (readonly [string, string | null])[] = [
    ["L'École est fermée demain matin.", null],
    ["Alors, pour Léa, l’inscription à l'école pour la rentrée de janvier.", null],
    ["Il faudrait renvoyer le devis, sinon on perd 15 % de remise, euh, voilà.", null],
    ["On perd quinze pour cent, vingt-deux personnes, 1 000 euros.", null],
    ["Rendez-vous à 10 h 30 devant l'hôpital, d'accord ?", null],
    ["Aujourd'hui, c'est le 1er, au 3e étage, quatre-vingts ans.", null],
    ["Bonjour, on y va ? Ok Google, minuteur dix minutes.", null],
    ["We talked about the budget for next week, don't worry.", "en"],
    ["It costs 1,000 bucks, um, and 3.5 percent.", "en"],
    ["Le budget de la semaine prochaine est validé.", "fr"],
  ];
  const queries = [
    "ecole",
    "l'école",
    "école fermée",
    "15",
    "quinze",
    "22",
    "vingt-deux",
    "mille",
    "euh",
    "voila",
    "10h30",
    "dix heures",
    "d'accord",
    "aujourd'hui",
    "premier",
    "quatre vingt",
    "next week",
    "budg",
    "rend",
    "eco",
    "cole",
    "on",
    "don't",
    "1000",
    "3.5",
    "minuteur 10",
  ];

  it("highlights exactly the segments FTS5 returns", () => {
    temp = tempDatabase();
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 200]]);
    const runId = startRun(temp.db, episodeId, "asr");
    const published = publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: corpus.map(([text, lang], index) => ({
        ...segment(trackRunId, index * 10, index * 10 + 8, text),
        lang,
      })),
      turns: [],
    });
    expect(published.published).toBe(true);
    for (const query of queries) {
      const fromIndex = new Set(
        searchSegments(temp.db, query, { limit: 100 }).map((hit) => hit.text),
      );
      const highlighted = new Set(
        corpus
          .filter(
            ([text, lang]) => highlightRanges(text, lang, compileSearchQuery(query)).length > 0,
          )
          .map(([text]) => text),
      );
      expect(highlighted, query).toEqual(fromIndex);
    }
  });
});
