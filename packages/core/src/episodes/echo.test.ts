import { describe, expect, it } from "vitest";
import { removeEcho, type EchoSegment } from "./echo";

const MIC = 1;
const SYSTEM = 2;
const APP = 3;
const tracks = { heard: new Set([MIC]), played: new Set([SYSTEM, APP]) };

/** A segment whose words are spread evenly over [startMs, endMs] (16 kHz samples). */
function timed(trackRunId: number, startMs: number, endMs: number, text: string): EchoSegment {
  const tokens = [...text.matchAll(/\S+/gu)];
  const step = (endMs - startMs) / tokens.length;
  return {
    trackRunId,
    sampleStart: startMs * 16,
    sampleEnd: endMs * 16,
    startMs,
    endMs,
    text,
    words: tokens.map((token, index) => ({
      charStart: token.index,
      charEnd: token.index + token[0].length,
      startMs: Math.round(index * step),
      endMs: Math.round((index + 1) * step),
    })),
  };
}

const untimed = (trackRunId: number, startMs: number, endMs: number, text: string) => ({
  ...timed(trackRunId, startMs, endMs, text),
  words: null,
});

const texts = (segments: readonly EchoSegment[]) =>
  segments.map((segment) => [segment.trackRunId, segment.text]);

describe("removeEcho", () => {
  it("takes the other side's words out of the microphone when the Mac's speakers played them", () => {
    const result = removeEcho(
      [
        timed(SYSTEM, 10_000, 13_000, "on se voit demain à dix heures"),
        timed(MIC, 10_150, 13_150, "on se voit demain à dix heures"),
      ],
      tracks,
    );
    expect(texts(result.segments)).toEqual([[SYSTEM, "on se voit demain à dix heures"]]);
    expect(result.echoWords).toBe(7);
    expect(result.spans).toEqual([{ trackRunId: MIC, sampleStart: 162_400, sampleEnd: 210_400 }]);
  });

  it("keeps what the user said before the echo, as its own sentence, and says where the echo was", () => {
    // « oui d'accord » from the user, then the other side's words, 150 ms after the speakers.
    const text = "oui d'accord on se voit demain";
    const at = [
      [0, 400],
      [500, 1_400],
      [2_150, 2_650],
      [2_650, 3_150],
      [3_150, 3_650],
      [3_650, 4_150],
    ];
    const mic: EchoSegment = {
      ...timed(MIC, 10_000, 14_200, text),
      words: [...text.matchAll(/\S+/gu)].map((token, index) => ({
        charStart: token.index,
        charEnd: token.index + token[0].length,
        startMs: at[index]?.[0] ?? 0,
        endMs: at[index]?.[1] ?? 0,
      })),
    };
    const result = removeEcho([timed(SYSTEM, 12_000, 14_000, "on se voit demain"), mic], tracks);
    expect(texts(result.segments)).toEqual([
      [SYSTEM, "on se voit demain"],
      [MIC, "oui d'accord"],
    ]);
    const kept = result.segments[1];
    expect(kept?.sampleEnd).toBe((10_000 + 1_400) * 16);
    expect(result.spans).toEqual([
      { trackRunId: MIC, sampleStart: 11_400 * 16, sampleEnd: 14_200 * 16 },
    ]);
  });

  it("never takes a reply that repeats one word, nor a mic sentence said before its source", () => {
    const segments = [
      timed(SYSTEM, 10_000, 10_300, "oui"),
      timed(MIC, 10_500, 10_800, "oui"),
      timed(SYSTEM, 20_700, 21_300, "on est prêts"),
      timed(MIC, 20_000, 20_600, "on est prêts"),
    ];
    expect(removeEcho(segments, tracks).segments).toEqual(segments);
  });

  it("needs the words in a row on the played side too", () => {
    const segments = [
      timed(SYSTEM, 10_000, 12_000, "je ne sais vraiment pas"),
      timed(MIC, 10_200, 11_800, "je sais pas"),
    ];
    expect(removeEcho(segments, tracks).segments).toEqual(segments);
  });

  it("leaves both sides alone with headphones, and words said again much later", () => {
    const segments = [
      timed(SYSTEM, 10_000, 12_000, "tu as vu le budget"),
      timed(MIC, 12_500, 14_000, "oui je l'ai lu"),
      timed(MIC, 20_000, 22_000, "tu as vu le budget"),
    ];
    const result = removeEcho(segments, tracks);
    expect(result.segments).toEqual(segments);
    expect(result.echoWords).toBe(0);
  });

  it("takes a two-word sentence only when all of it comes back", () => {
    const result = removeEcho(
      [
        timed(SYSTEM, 10_000, 11_000, "merci beaucoup"),
        timed(MIC, 10_100, 11_100, "merci beaucoup"),
        timed(SYSTEM, 20_000, 21_000, "à demain"),
        timed(MIC, 20_100, 21_100, "à plus"),
      ],
      tracks,
    );
    expect(texts(result.segments)).toEqual([
      [SYSTEM, "merci beaucoup"],
      [SYSTEM, "à demain"],
      [MIC, "à plus"],
    ]);
  });

  it("compares numbers and elisions as they are said", () => {
    const result = removeEcho(
      [
        timed(SYSTEM, 10_000, 12_000, "vingt deux euros"),
        timed(MIC, 10_100, 12_100, "22 euros"),
        timed(SYSTEM, 20_000, 22_000, "l'ai lu hier"),
        timed(MIC, 20_100, 22_100, "j'ai lu hier"),
      ],
      tracks,
    );
    expect(texts(result.segments)).toEqual([
      [SYSTEM, "vingt deux euros"],
      [SYSTEM, "l'ai lu hier"],
      [MIC, "j'ai lu hier"],
    ]);
  });

  it("joins ASR pieces of one word before comparing", () => {
    const mic: EchoSegment = {
      ...timed(MIC, 20_100, 22_100, "j'ai lu hier"),
      words: [
        { charStart: 0, charEnd: 2, startMs: 0, endMs: 300 },
        { charStart: 2, charEnd: 4, startMs: 300, endMs: 600 },
        { charStart: 5, charEnd: 7, startMs: 700, endMs: 1_200 },
        { charStart: 8, charEnd: 12, startMs: 1_300, endMs: 2_000 },
      ],
    };
    const segments = [timed(SYSTEM, 20_000, 22_000, "l'ai lu hier"), mic];
    expect(removeEcho(segments, tracks).segments).toEqual(segments);
  });

  it("takes fillers along when all that was said is echo", () => {
    const result = removeEcho(
      [timed(SYSTEM, 10_000, 12_000, "on se voit"), timed(MIC, 9_900, 12_100, "euh on se voit")],
      tracks,
    );
    expect(texts(result.segments)).toEqual([[SYSTEM, "on se voit"]]);
  });

  it("keeps an untimed mic sentence unless all of it is echo", () => {
    const result = removeEcho(
      [
        untimed(SYSTEM, 10_000, 13_000, "la réunion est déplacée à jeudi"),
        untimed(MIC, 10_100, 13_100, "la réunion est déplacée à jeudi"),
        untimed(SYSTEM, 30_000, 32_000, "on part demain"),
        untimed(MIC, 30_100, 33_000, "on part demain non impossible"),
      ],
      tracks,
    );
    expect(texts(result.segments)).toEqual([
      [SYSTEM, "la réunion est déplacée à jeudi"],
      [SYSTEM, "on part demain"],
      [MIC, "on part demain non impossible"],
    ]);
  });

  it("takes a long echo whole, and keeps pieces inside their samples", () => {
    const words = Array.from({ length: 600 }, (_, index) => `mot${index % 7}x${index % 13}`).join(
      " ",
    );
    const result = removeEcho(
      [timed(APP, 0, 300_000, words), timed(MIC, 100, 300_100, words)],
      tracks,
    );
    expect(result.segments).toHaveLength(1);
    expect(result.echoWords).toBe(600);
  });

  it("never glues two separate matches into one stretch", () => {
    const segments = [
      timed(SYSTEM, 10_000, 12_000, "on part ensemble demain matin"),
      timed(MIC, 10_100, 12_100, "on part demain matin"),
    ];
    expect(removeEcho(segments, tracks).segments).toEqual(segments);
  });

  it("keeps a short reply that comes too late for an echo, and speech said before its source", () => {
    const segments = [
      timed(SYSTEM, 10_000, 10_400, "à demain"),
      timed(MIC, 10_500, 10_900, "à demain"),
      timed(SYSTEM, 20_000, 20_600, "on est prêts"),
      timed(MIC, 19_800, 20_400, "on est prêts"),
    ];
    expect(removeEcho(segments, tracks).segments).toEqual(segments);
  });

  it("keeps the user's interjection said apart from the echo in the same sentence", () => {
    const text = "on est prêts hein";
    const at = [
      [100, 500],
      [500, 900],
      [900, 1_300],
      [4_100, 4_500],
    ];
    const mic: EchoSegment = {
      ...timed(MIC, 10_000, 14_500, text),
      words: [...text.matchAll(/\S+/gu)].map((token, index) => ({
        charStart: token.index,
        charEnd: token.index + token[0].length,
        startMs: at[index]?.[0] ?? 0,
        endMs: at[index]?.[1] ?? 0,
      })),
    };
    const result = removeEcho([timed(SYSTEM, 10_000, 11_200, "on est prêts"), mic], tracks);
    expect(texts(result.segments)).toEqual([
      [SYSTEM, "on est prêts"],
      [MIC, "hein"],
    ]);
  });

  it("compares numbers as they are said in context", () => {
    const result = removeEcho(
      [
        timed(SYSTEM, 10_000, 11_000, "mille euros"),
        timed(MIC, 10_050, 11_050, "1 000 euros"),
        timed(SYSTEM, 20_000, 22_000, "quatre vingts euros"),
        timed(MIC, 20_100, 22_100, "80 euros"),
      ],
      tracks,
    );
    expect(texts(result.segments)).toEqual([
      [SYSTEM, "mille euros"],
      [SYSTEM, "quatre vingts euros"],
    ]);
  });

  it("changes nothing without played sound", () => {
    const segments = [timed(MIC, 10_000, 12_000, "je parle tout seul")];
    expect(removeEcho(segments, tracks).segments).toEqual(segments);
  });

  it("takes the mic words said in a stretch known to be Sondine's own echo (ADR 035)", () => {
    // The user over a playback: « attends je reviens », then Sondine's echo heard alone.
    const segment = timed(MIC, 20_000, 24_000, "attends je reviens la réunion de mardi");
    const known = [{ trackRunId: MIC, sampleStart: 21_800 * 16, sampleEnd: 24_000 * 16 }];
    const result = removeEcho([segment], { ...tracks, known });
    expect(texts(result.segments)).toEqual([[MIC, "attends je reviens"]]);
    expect(result.echoWords).toBe(4);
    // The echo starts where « reviens » ends (three words of seven over 4 s).
    expect(result.spans).toEqual([
      { trackRunId: MIC, sampleStart: (20_000 + 1_714) * 16, sampleEnd: 24_000 * 16 },
    ]);
    // Another run's stretch takes nothing; nor does a stretch with nothing played on any track.
    const elsewhere = [{ trackRunId: SYSTEM, sampleStart: 0, sampleEnd: 1e9 }];
    expect(texts(removeEcho([segment], { ...tracks, known: elsewhere }).segments)).toEqual([
      [MIC, "attends je reviens la réunion de mardi"],
    ]);
  });
});
