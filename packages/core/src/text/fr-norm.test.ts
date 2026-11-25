import { describe, expect, it } from "vitest";

import {
  FR_NORM_VERSION,
  frNorm,
  frNormId,
  frNormSpans,
  frNormTokens,
  type FrNormOptions,
} from "./fr-norm";

type Golden = readonly [input: string, expected: string, options?: FrNormOptions];

const keepFillers = { fillers: "keep" } satisfies FrNormOptions;
const strip = { diacritics: "strip" } satisfies FrNormOptions;
const keepNumbers = { numbers: "keep" } satisfies FrNormOptions;
const en = { language: "en" } satisfies FrNormOptions;
const enKeep = { language: "en", fillers: "keep" } satisfies FrNormOptions;

const basics: readonly Golden[] = [
  ["Bonjour à tous.", "bonjour à tous"],
  ["  Salut,   ça va ? ", "salut ça va"],
  ["oui ; non : peut-être", "oui non peut être"],
  ["Attends… quoi ?!", "attends quoi"],
  ["« Bonjour », dit-il.", "bonjour dit il"],
  ["“Bonjour” (silence) merci", "bonjour silence merci"],
  ["a\tb\nc", "a b c"],
  ["", ""],
  ["?!…", ""],
  ["Tom & Jerry", "tom et jerry"],
  ["[rire] oui", "oui"],
  ["<bruit> bon d'accord", "bon d' accord"],
  ["ÉCOLE", "école"],
  ["À BIENTÔT", "à bientôt"],
  ["été", "été"],
  ["Noël", "noël"],
  ["ça", "ça"],
  ["l'œuvre", "l' oeuvre"],
  ["L'Œuvre de Cœur", "l' oeuvre de coeur"],
  ["nœud, sœur, bœuf", "noeud soeur boeuf"],
  ["ex æquo", "ex aequo"],
  ["Lætitia", "laetitia"],
  ["it's", "it's"],
  ["l'homme_politique", "l' homme politique"],
];

const elisions: readonly Golden[] = [
  ["Qu'est-ce que tu fais ?", "qu' est ce que tu fais"],
  ["L’homme est là.", "l' homme est là"],
  ["J'ai vu l'arbre d'Anne.", "j' ai vu l' arbre d' anne"],
  ["C'est-à-dire", "c' est à dire"],
  ["Jusqu'à demain", "jusqu' à demain"],
  ["Lorsqu'il viendra, puisqu'on attend", "lorsqu' il viendra puisqu' on attend"],
  ["Quoiqu'il arrive", "quoiqu' il arrive"],
  ["N'importe quoi", "n' importe quoi"],
  ["Il s'en va", "il s' en va"],
  ["Je m'appelle Paul", "je m' appelle paul"],
  ["Tu t'es trompé", "tu t' es trompé"],
  ["qu’il", "qu' il"],
  ["l‘école", "l' école"],
  ["lʼami", "l' ami"],
  ["aujourd'hui", "aujourd'hui"],
  ["Aujourd’hui, c’est lundi", "aujourd'hui c' est lundi"],
  ["quelqu'un", "quelqu'un"],
  ["presqu'île", "presqu'ile"],
  ["prud'homme", "prud'homme"],
  ["l' homme", "l' homme"],
  ["'bonjour'", "bonjour"],
  ["l''homme", "l' homme"],
  ["jusqu'au bout", "jusqu' au bout"],
  ["Va-t'en !", "va t' en"],
];

const hyphens: readonly Golden[] = [
  ["peut-être", "peut être"],
  ["Peut être", "peut être"],
  ["a-t-il dit", "a t il dit"],
  ["Jean-Pierre et Marie-Claire", "jean pierre et marie claire"],
  ["dis-moi", "dis moi"],
  ["e-mail", "e mail"],
  ["week‑end", "week end"],
  ["oui – non — peut‐être", "oui non peut être"],
  ["-- fin --", "fin"],
];

const fillers: readonly Golden[] = [
  ["Hein ? Quoi ?", "quoi"],
  ["Euh, je pense, euh, que oui", "je pense que oui"],
  ["Euh, je pense que oui", "euh je pense que oui", keepFillers],
  ["euuuh", ""],
  ["euuuh", "euh", keepFillers],
  ["Heu… bah… ben oui", "oui"],
  ["Heu… bah… ben oui", "heu bah ben oui", keepFillers],
  ["mmh mmmh hum hummm", ""],
  ["mmh mmmh hum hummm", "mmh mmh hum hum", keepFillers],
  ["hmm d'accord", "d' accord"],
  ["hmm", "hum", keepFillers],
  ["Ben voyons", "voyons"],
  ["bah oui hein", "oui"],
  ["heinnn", "hein", keepFillers],
  ["bennn", "ben", keepFillers],
  ["benoît", "benoit"],
  ["humour", "humour"],
  ["heureux", "heureux"],
];

const spelling: readonly Golden[] = [
  ["connaître", "connaitre"],
  ["il paraît", "il parait"],
  ["coût, goût, août", "cout gout aout"],
  ["flûte", "flute"],
  ["sûr et sûre", "sûr et sûre"],
  ["sûrement", "sûrement"],
  ["mûr, dû, jeûne", "mûr dû jeûne"],
  ["qu'il fût", "qu' il fût"],
  ["événement", "évènement"],
  ["Événements", "évènements"],
  ["une clef", "une clé"],
];

const diacritics: readonly Golden[] = [
  ["Événement à côté", "evenement a cote", strip],
  ["Où êtes-vous ?", "ou etes vous", strip],
  ["Noël", "noel", strip],
  ["ça", "ca", strip],
  ["l'œuvre", "l' oeuvre", strip],
  ["sûr", "sur", strip],
];

const numbers: readonly Golden[] = [
  ["0", "zéro"],
  ["1", "un"],
  ["16", "seize"],
  ["17", "dix sept"],
  ["21", "vingt et un"],
  ["22", "vingt deux"],
  ["30", "trente"],
  ["31", "trente et un"],
  ["61", "soixante et un"],
  ["70", "soixante dix"],
  ["71", "soixante et onze"],
  ["72", "soixante douze"],
  ["77", "soixante dix sept"],
  ["80", "quatre vingt"],
  ["81", "quatre vingt un"],
  ["90", "quatre vingt dix"],
  ["91", "quatre vingt onze"],
  ["99", "quatre vingt dix neuf"],
  ["100", "cent"],
  ["101", "cent un"],
  ["200", "deux cent"],
  ["201", "deux cent un"],
  ["999", "neuf cent quatre vingt dix neuf"],
  ["1000", "mille"],
  ["1001", "mille un"],
  ["1990", "mille neuf cent quatre vingt dix"],
  ["2023", "deux mille vingt trois"],
  ["21000", "vingt et un mille"],
  ["80000", "quatre vingt mille"],
  ["200000", "deux cent mille"],
  ["999999", "neuf cent quatre vingt dix neuf mille neuf cent quatre vingt dix neuf"],
  ["1 000 000", "un million"],
  ["2000000", "deux millions"],
  ["80 000 000", "quatre vingt millions"],
  ["1 000 000 000", "un milliard"],
  [
    "123456789",
    "cent vingt trois millions quatre cent cinquante six mille sept cent quatre vingt neuf",
  ],
  ["1234567890123", "un deux trois quatre cinq six sept huit neuf zéro un deux trois"],
  ["10 000", "dix mille"],
  ["10 000 personnes", "dix mille personnes"],
  ["10 000", "dix mille"],
  ["1.000", "mille"],
  ["en 2020 100 personnes", "en deux mille vingt cent personnes"],
  ["007", "zéro zéro sept"],
  ["06 12 34 56 78", "zéro six douze trente quatre cinquante six soixante dix huit"],
  ["2023-2024", "deux mille vingt trois deux mille vingt quatre"],
  ["J'ai 3 ans.", "j' ai trois ans"],
  ["j'ai 3, 4 ou 5 pommes", "j' ai trois quatre ou cinq pommes"],
  ["vingt-et-un", "vingt et un"],
  ["quatre-vingts", "quatre vingt"],
  ["deux cents euros", "deux cent euros"],
  ["trois-cents", "trois cent"],
  ["les cents", "les cents"],
  ["dix-sept", "dix sept"],
];

const decimals: readonly Golden[] = [
  ["3,5", "trois virgule cinq"],
  ["3,05", "trois virgule zéro cinq"],
  ["12,25", "douze virgule vingt cinq"],
  ["0,5", "zéro virgule cinq"],
  ["3,0", "trois virgule zéro"],
  ["3.14", "trois point quatorze"],
  ["1 234,56", "mille deux cent trente quatre virgule cinquante six"],
  ["la version 2.0", "la version deux point zéro"],
];

const units: readonly Golden[] = [
  ["15 %", "quinze pour cent"],
  ["15%", "quinze pour cent"],
  ["3,5 %", "trois virgule cinq pour cent"],
  ["100 % sûr", "cent pour cent sûr"],
  ["cinquante pourcent", "cinquante pour cent"],
  ["5 €", "cinq euros"],
  ["5€", "cinq euros"],
  ["1 €", "un euro"],
  ["0 €", "zéro euro"],
  ["3,50 €", "trois euros cinquante"],
  ["3,5 €", "trois euros cinquante"],
  ["2,05 €", "deux euros cinq"],
  ["0,50 €", "cinquante centimes"],
  ["0,01 €", "un centime"],
  ["€20", "vingt euros"],
  ["1 000 €", "mille euros"],
  ["1 000 000 €", "un million d' euros"],
  ["3,505 €", "trois virgule cinq cent cinq euros"],
  ["$5", "cinq dollars"],
  ["1,50 $", "un dollar cinquante"],
  ["2 000 000 $", "deux millions de dollars"],
  ["14h30", "quatorze heures trente"],
  ["14 h 30", "quatorze heures trente"],
  ["14h", "quatorze heures"],
  ["14h00", "quatorze heures"],
  ["à 8h05", "à huit heures cinq"],
  ["1h", "une heure"],
  ["21h", "vingt et une heures"],
  ["21h21", "vingt et une heures vingt et une"],
  ["0h30", "zéro heure trente"],
  ["48h", "quarante huit heures"],
  ["14:30", "quatorze heures trente"],
  ["il est 3 h.", "il est trois heures"],
  ["3 hommes", "trois hommes"],
  ["25:70", "vingt cinq soixante dix"],
];

const ordinals: readonly Golden[] = [
  ["1er", "premier"],
  ["le 1er janvier", "le premier janvier"],
  ["la 1re fois", "la première fois"],
  ["1ère", "première"],
  ["1ᵉʳ", "premier"],
  ["2e", "deuxième"],
  ["3ème", "troisième"],
  ["4e", "quatrième"],
  ["5e", "cinquième"],
  ["9e", "neuvième"],
  ["11e", "onzième"],
  ["21e siècle", "vingt et unième siècle"],
  ["80e", "quatre vingtième"],
  ["100e", "centième"],
  ["1000e", "millième"],
  ["2nd", "second"],
  ["2nde", "seconde"],
  ["les 1ers", "les premiers"],
  ["les 2es", "les deuxièmes"],
  ["2er", "deux er"],
  ["XXIe", "xxie"],
];

const mixed: readonly Golden[] = [
  ["MP3", "mp trois"],
  ["covid-19", "covid dix neuf"],
  ["3D", "trois d"],
  ["4G", "quatre g"],
  ["n° 5", "numéro cinq"],
  ["N°5", "numéro cinq"],
  [
    "Le 14 juillet 1789, à 10h, 1 000 personnes.",
    "le quatorze juillet mille sept cent quatre vingt neuf à dix heures mille personnes",
  ],
];

const keptNumbers: readonly Golden[] = [
  ["3,5 %", "3,5", keepNumbers],
  ["14h30", "14h30", keepNumbers],
  ["le 1er, puis 2.", "le 1er puis 2", keepNumbers],
  ["1 000", "1 000", keepNumbers],
  ["3,14 et 2.5", "3,14 et 2.5", keepNumbers],
];

const english: readonly Golden[] = [
  ["Don't worry, it's fine.", "don't worry it's fine", en],
  ["I'm gonna call you back!", "i'm gonna call you back", en],
  ["Uh, I think, um, yes", "i think yes", en],
  ["Uh, I think, um, yes", "uh i think um yes", enKeep],
  ["Hmm, okay", "okay", en],
  ["hmmm mmm", "hmm mm", enKeep],
  ["state-of-the-art", "state of the art", en],
  ["It costs 3.5 dollars.", "it costs 3.5 dollars", en],
  ["1,000 people", "1000 people", en],
  ["1,000,000", "1000000", en],
  ["Rock'n'roll", "rock'n'roll", en],
  ["'Cause I said so", "cause i said so", en],
  ["the students' books", "the students books", en],
  ["l'homme", "l'homme", en],
  ["Tom & Jerry", "tom and jerry", en],
  ["Café", "café", en],
  ["Café", "cafe", { language: "en", diacritics: "strip" }],
  ["Ben said so", "ben said so", en],
  ["euh", "euh", en],
  ["The Œuvre", "the oeuvre", en],
  ["50%", "50", en],
];

const all: readonly (readonly [string, readonly Golden[]])[] = [
  ["basics", basics],
  ["elisions", elisions],
  ["hyphens", hyphens],
  ["fillers", fillers],
  ["spelling", spelling],
  ["diacritics", diacritics],
  ["numbers", numbers],
  ["decimals", decimals],
  ["units", units],
  ["ordinals", ordinals],
  ["mixed", mixed],
  ["kept numbers", keptNumbers],
  ["english", english],
];

describe("fr-norm goldens", () => {
  for (const [name, goldens] of all) {
    describe(name, () => {
      for (const [input, expected, options] of goldens) {
        it(`${JSON.stringify(input)}${options === undefined ? "" : ` ${JSON.stringify(options)}`}`, () => {
          expect(frNorm(input, options)).toBe(expected);
        });
      }
    });
  }

  it("has at least 120 cases", () => {
    expect(all.reduce((sum, [, goldens]) => sum + goldens.length, 0)).toBeGreaterThanOrEqual(120);
  });

  it("is idempotent on every golden", () => {
    for (const [, goldens] of all) {
      for (const [input, , options] of goldens) {
        const once = frNorm(input, options);
        expect(frNorm(once, options)).toBe(once);
      }
    }
  });
});

describe("fr-norm spans", () => {
  it("normalizes each span with its language", () => {
    expect(
      frNormSpans([
        { text: "Alors on fait le meeting,", language: "fr" },
        { text: "let's go!", language: "en" },
        { text: "D'accord.", language: "fr" },
      ]),
    ).toBe("alors on fait le meeting let's go d' accord");
  });

  it("keeps digits in English spans and spells them in French spans", () => {
    expect(
      frNormSpans([
        { text: "J'ai 2 réunions", language: "fr" },
        { text: "at 3 pm", language: "en" },
      ]),
    ).toBe("j' ai deux réunions at 3 pm");
  });

  it("applies shared options to every span", () => {
    expect(
      frNormSpans(
        [
          { text: "Euh, été", language: "fr" },
          { text: "um, café", language: "en" },
        ],
        { fillers: "keep", diacritics: "strip" },
      ),
    ).toBe("euh ete um cafe");
  });
});

describe("fr-norm API", () => {
  it("returns tokens without empty strings", () => {
    expect(frNormTokens("  l'homme,  euh   là ")).toEqual(["l'", "homme", "là"]);
    expect(frNormTokens("")).toEqual([]);
  });

  it("identifies the version and options", () => {
    expect(FR_NORM_VERSION).toBe("fr-norm/1");
    expect(frNormId()).toBe("fr-norm/1;fillers=drop;numbers=words;diacritics=keep");
    expect(frNormId({ fillers: "keep", diacritics: "strip" })).toBe(
      "fr-norm/1;fillers=keep;numbers=words;diacritics=strip",
    );
  });

  it("does not read object prototype keys as spelling variants", () => {
    expect(frNorm("constructor toString __proto__")).toBe("constructor tostring proto");
  });
});
