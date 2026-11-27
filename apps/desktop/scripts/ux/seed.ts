// Seeds invented conversations into a fresh development data folder, for the
// redesign's captures and click paths (docs/ux-redesign.md §8). Every name and
// sentence here is made up; nothing comes from a real recording.
//
// Usage: node scripts/ux/seed.ts <data-folder> [--ask]

import { registerHooks } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Workspace packages import without extensions (bundler resolution).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || context.parentURL?.endsWith(".ts") !== true) throw error;
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
  },
});

const sondineDb = await import("@sondine/db");
const { openDatabase, upsertTrackRun, openSpeechRegion, closeSpeechRegion, publishAnalysis } =
  sondineDb;
const { nameSpeaker, loadJournalSource, startJournalRun, publishJournalRun, setJournalMark } =
  sondineDb;
const { setEpisodeTag, setUsageConsent, addVocabularyWord, startWebPlay, endWebPlay } = sondineDb;
const { cleanTitle, webPageOf } = await import("@sondine/core");
const { USAGE_REPORT_VERSION } = await import("@sondine/protocol");

const RATE = 16_000;
const H = 3600;
const M = 60;
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

type Line = readonly [label: string, text: string];
interface Item {
  readonly kind: "event" | "commitment";
  readonly text: string;
  readonly line: number;
  readonly who?: string;
  readonly to?: string;
  readonly dueText?: string;
  /** Days after the conversation it is due; none when absent. */
  readonly dueIn?: number;
}
interface Episode {
  readonly at: number;
  readonly size: "conversation" | "moment" | "trace";
  readonly context: "in_person" | "call" | "media" | "dictation";
  readonly voicedMin: number;
  /** The app it was heard from (a call, what played it) or said to (a dictation). */
  readonly app?: { readonly bundleId: string; readonly name: string };
  /** The page a browser played it from: the tab's address and title, as the extension reports them (ADR 023). */
  readonly page?: { readonly url: string; readonly title: string };
  readonly names?: Readonly<Record<string, string>>;
  readonly lines: readonly Line[];
  readonly journal?: readonly Item[];
}

const folder = process.argv[2];
if (folder === undefined) throw new Error("usage: node scripts/ux/seed.ts <data-folder>");
mkdirSync(folder, { recursive: true });
const db = openDatabase(join(folder, "sondine.db"));

const people = new Map<string, number>();
const now = Date.now();

function seedDay(base: number, uid: string, list: readonly Episode[]): void {
  const { trackRunId } = upsertTrackRun(db, {
    uid,
    trackKey: "input:BuiltInMicrophoneDevice",
    sourceKind: "input",
    device: {
      uid: "BuiltInMicrophoneDevice",
      name: "MacBook Pro Microphone",
      transport: "built_in",
      hasInput: true,
      seenAtMs: base,
    },
    startedWallMs: base,
    nowMs: base,
  });
  for (const episode of list) seedEpisode(base, trackRunId, episode);
  // The run ends after its last episode, as a capture that stopped would: an
  // episode's timeline (its playback) stays within the run.
  const end = Math.max(0, ...list.map(episodeEnd));
  db.statement(
    "UPDATE track_runs SET state = 'closed', sample_end = ?, ended_wall_ms = ? WHERE id = ?",
  ).run(end * RATE, base + end * 1000, trackRunId);
}

/** An episode lasts about its voiced time, and at least its lines (seconds from the day's base). */
function episodeEnd(ep: Episode): number {
  return ep.at + Math.max(ep.lines.length * 9, 6, Math.round(ep.voicedMin * 60 * 1.25));
}

function seedEpisode(base: number, trackRunId: number, ep: Episode): void {
  const step = 9;
  const end = episodeEnd(ep);
  const opened = openSpeechRegion(db, {
    trackRunId,
    sampleStart: ep.at * RATE,
    wallStartMs: base + ep.at * 1000,
    vadVersion: "silero-6.2",
  });
  if (opened.speechRegionId === null) throw new Error("speech region refused");
  closeSpeechRegion(db, {
    trackRunId,
    sampleStart: ep.at * RATE,
    sampleEnd: end * RATE,
    wallEndMs: base + end * 1000,
    endReason: "silence",
  });
  const episodeId = Number(
    db
      .statement(
        `INSERT INTO episodes (state, started_at_ms, ended_at_ms, grouping_version,
           classifier_version, created_at_ms, updated_at_ms, size, context, size_state, voiced_ms)
         VALUES ('closed', ?, ?, 'g1', 'c1', ?, ?, ?, ?, 'final', ?)`,
      )
      .run(
        base + ep.at * 1000,
        base + end * 1000,
        base,
        base,
        ep.size,
        ep.context,
        ep.voicedMin * 60_000,
      ).lastInsertRowid,
  );
  db.statement(
    `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start)
     VALUES (?, ?, 'g1', ?)`,
  ).run(episodeId, opened.speechRegionId, ep.at * RATE);
  if (ep.app !== undefined) {
    db.statement(
      `INSERT INTO apps (bundle_id, name, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (bundle_id) DO NOTHING`,
    ).run(ep.app.bundleId, ep.app.name, base, base);
    const appId = db.statement(`SELECT id FROM apps WHERE bundle_id = ?`).get(ep.app.bundleId)?.[
      "id"
    ];
    // The region names its app, as a process tap's attribution would; a dictation names the app said to.
    db.statement(`UPDATE speech_regions SET attributed_app_id = ? WHERE id = ?`).run(
      appId,
      opened.speechRegionId,
    );
    if (ep.context === "dictation") {
      db.statement(`UPDATE episodes SET primary_app_id = ? WHERE id = ?`).run(appId, episodeId);
    }
    if (ep.page !== undefined) {
      const page = webPageOf(ep.page.url);
      if (page === null) throw new Error(`not a web page: ${ep.page.url}`);
      const play = startWebPlay(db, {
        appId: Number(appId),
        page,
        url: ep.page.url,
        // As the play recorder keeps it: without « - YouTube ».
        title: cleanTitle(page.site, ep.page.title),
        atMs: base + ep.at * 1000,
        nowMs: base + ep.at * 1000,
      });
      endWebPlay(db, play, base + end * 1000, base + end * 1000);
      db.statement(`UPDATE episodes SET page_key = ? WHERE id = ?`).run(page.pageKey, episodeId);
    }
  }
  if (ep.lines.length === 0) return;
  const runId = Number(
    db
      .statement(
        `INSERT INTO analysis_runs (episode_id, stage, status, engine_id, engine_version,
           engine_runtime, adapter_class, input_hash, input_generation, started_at_ms)
         VALUES (?, 'asr', 'succeeded', 'nemotron-3.5-transcribe-30b', 'iq4_nl', 'speech.cpp',
           'product', ?, 1, ?)`,
      )
      .run(episodeId, `ux-${episodeId}`, base).lastInsertRowid,
  );
  const segments = ep.lines.map(([label, text], i) => {
    const s = ep.at + i * step;
    return {
      trackRunId,
      sampleStart: s * RATE,
      sampleEnd: (s + step - 1) * RATE,
      startMs: base + s * 1000,
      endMs: base + (s + step - 1) * 1000,
      text,
      speakerLabel: label,
    };
  });
  const published = publishAnalysis(db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments,
    turns: segments.map(({ text: _text, ...turn }) => turn),
    analysisState: "complete",
  });
  if (!published.published) throw new Error(`analysis not published: ${JSON.stringify(published)}`);
  for (const [label, name] of Object.entries(ep.names ?? {})) {
    const known = people.get(name);
    const person =
      name === "@self"
        ? ({ kind: "self", name: "Alex" } as const)
        : known === undefined
          ? ({ kind: "new", name } as const)
          : ({ kind: "existing", personId: known } as const);
    const result = nameSpeaker(db, { episodeId, runId, label, person, nowMs: now });
    if (!result.ok) throw new Error(`could not name ${name}: ${result.reason}`);
    people.set(name, result.value.id);
  }
  if (ep.journal !== undefined) seedJournal(episodeId, ep);
}

function seedJournal(episodeId: number, ep: Episode): void {
  const source = loadJournalSource(db, episodeId, ZONE, now);
  if (source === null) return;
  const labels = [...new Set(ep.lines.map(([label]) => label))];
  const refs = Object.fromEntries(labels.map((label, i) => [`P${i + 1}`, label]));
  const refOf = (label: string | undefined) =>
    label === undefined ? null : (Object.entries(refs).find(([, l]) => l === label)?.[0] ?? null);
  const runId = startJournalRun(db, {
    episodeId,
    asrRunId: source.asrRunId,
    inputHash: source.inputHash,
    configKey: "ux-seed",
    engineId: "ux-seed",
    modelSha256: null,
    speakerRefs: refs,
    nowMs: now,
  });
  const result = publishJournalRun(db, {
    runId,
    items: (ep.journal ?? []).map((item) => ({
      kind: item.kind,
      text: item.text,
      whoRef: refOf(item.who),
      toRef: refOf(item.to),
      due:
        item.dueIn === undefined
          ? null
          : localDay((source.input.lines[0]?.startMs ?? now) + item.dueIn * 86_400_000),
      dueText: item.dueText ?? null,
      segmentIds: [source.input.lines[item.line]?.segmentId ?? -1],
    })),
    metrics: {},
    timeZone: ZONE,
    nowMs: now,
  });
  if (!result.published) throw new Error(`journal not published: ${JSON.stringify(result)}`);
}

function localDay(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

const today = new Date();
today.setHours(8, 0, 0, 0);
const base = today.getTime();

seedDay(base, "ux-today", [
  {
    at: 1 * H + 12 * M,
    size: "conversation",
    context: "in_person",
    voicedMin: 14,
    names: { A: "@self", B: "Camille" },
    lines: [
      ["B", "Bon, on fait le point sur la nouvelle carte du café avant jeudi ?"],
      ["A", "Oui. J'ai reçu les devis pour le four, le moins cher est à quatre mille deux cents."],
      ["B", "C'est au-dessus du budget, on avait dit trois mille cinq."],
      ["A", "Je rappelle le fournisseur demain matin pour négocier la livraison."],
      ["B", "Et pour les horaires d'été, on ouvre à sept heures ?"],
      ["A", "Sept heures trente, sinon l'équipe ne suit pas."],
      ["B", "D'accord. Tu envoies le planning à tout le monde vendredi ?"],
      ["A", "Promis, vendredi avant midi."],
    ],
    journal: [
      { kind: "event", text: "Ouverture à 7 h 30 cet été", line: 5 },
      {
        kind: "commitment",
        text: "Rappeler le fournisseur du four",
        line: 3,
        who: "A",
        dueText: "demain",
      },
      {
        kind: "commitment",
        text: "Envoyer le planning à l'équipe",
        line: 7,
        who: "A",
        dueText: "vendredi",
      },
    ],
  },
  {
    at: 2 * H + 40 * M,
    size: "conversation",
    context: "call",
    app: { bundleId: "com.apple.FaceTime", name: "FaceTime" },
    voicedMin: 32,
    names: { A: "@self", B: "Jules" },
    lines: [
      ["B", "Salut, tu m'entends bien ? Je suis dans le train."],
      ["A", "Oui, ça coupe un peu. Tu as vu la maquette du site ?"],
      ["B", "Oui, j'aime bien la page des horaires, moins la photo d'accueil."],
      ["A", "On peut prendre celle de la terrasse au printemps."],
      ["B", "Parfait. Je t'envoie les textes d'ici lundi."],
    ],
    journal: [
      { kind: "event", text: "Maquette du site : garder la page des horaires", line: 2 },
      {
        kind: "commitment",
        text: "Envoyer les textes du site",
        line: 4,
        who: "B",
        dueText: "lundi",
      },
    ],
  },
  {
    at: 3 * H + 30 * M,
    size: "moment",
    context: "dictation",
    app: { bundleId: "com.apple.Notes", name: "Notes" },
    voicedMin: 1,
    lines: [["A", "Penser à commander les gobelets compostables et le sirop d'érable."]],
  },
  {
    at: 4 * H + 5 * M,
    size: "moment",
    context: "in_person",
    voicedMin: 2,
    lines: [
      ["A", "Tu as vu où j'ai posé les clés du local ?"],
      ["B", "Sur l'étagère, à côté de la caisse."],
    ],
  },
  {
    at: 4 * H + 50 * M,
    size: "trace",
    context: "media",
    app: { bundleId: "com.apple.Safari", name: "Safari" },
    voicedMin: 3,
    lines: [["A", "Et maintenant la météo : un ciel dégagé sur toute la Bretagne."]],
  },
  {
    at: 6 * H + 5 * M,
    size: "conversation",
    context: "in_person",
    voicedMin: 21,
    names: { A: "@self" },
    lines: [
      ["B", "Je passe pour la candidature, vous cherchez toujours quelqu'un le week-end ?"],
      ["A", "Oui, surtout le samedi matin. Vous avez déjà fait du service ?"],
      ["B", "Deux ans dans une boulangerie à Nantes."],
      ["A", "Très bien. On peut faire un essai samedi prochain ?"],
      ["B", "Avec plaisir."],
    ],
    journal: [{ kind: "event", text: "Essai samedi prochain pour le poste du week-end", line: 3 }],
  },
  {
    at: 7 * H + 45 * M,
    size: "conversation",
    context: "media",
    app: { bundleId: "com.apple.Safari", name: "Safari" },
    page: {
      url: "https://www.youtube.com/watch?v=Sondine0001",
      title: "Tempérer le chocolat sans thermomètre - YouTube",
    },
    voicedMin: 9,
    lines: [
      ["C", "Aujourd'hui, on tempère du chocolat noir, sans thermomètre."],
      ["C", "On fait fondre les deux tiers au bain-marie, doucement."],
      ["C", "Le secret, c'est de ne jamais laisser bouillir l'eau."],
      ["C", "Hors du feu, on ajoute le dernier tiers, haché fin."],
      ["C", "On remue jusqu'à ce que tout soit lisse et brillant."],
      ["C", "Pour vérifier, une goutte sur le bout d'une spatule."],
      ["C", "Si elle fige en cinq minutes, sans traces blanches, c'est gagné."],
      ["C", "La semaine prochaine : les bonbons au praliné."],
    ],
  },
  {
    at: 8 * H + 20 * M,
    size: "conversation",
    context: "call",
    app: { bundleId: "com.hnc.Discord", name: "Discord" },
    voicedMin: 18,
    names: { A: "@self", B: "Camille" },
    lines: [
      ["B", "Le fournisseur a accepté de baisser à trois mille huit."],
      ["A", "Super, on valide. Je signe le bon de commande demain."],
      ["B", "Et la livraison est offerte."],
    ],
    journal: [
      { kind: "event", text: "Four validé à 3 800 €, livraison offerte", line: 0 },
      {
        kind: "commitment",
        text: "Signer le bon de commande",
        line: 1,
        who: "A",
        dueText: "demain",
      },
    ],
  },
]);

seedDay(base - 24 * H * 1000, "ux-yesterday", [
  {
    at: 2 * H,
    size: "conversation",
    context: "in_person",
    voicedMin: 25,
    names: { A: "@self", B: "Jules" },
    lines: [
      ["B", "On a combien de couverts prévus pour samedi ?"],
      ["A", "Une quarantaine, plus le groupe de dix à midi."],
    ],
  },
  {
    at: 5 * H,
    size: "moment",
    context: "dictation",
    app: { bundleId: "com.apple.Notes", name: "Notes" },
    voicedMin: 1,
    lines: [["A", "Idée : une formule goûter pour les enfants le mercredi."]],
  },
]);

/** Days from today to the next `weekday` (0 Sunday … 6 Saturday), for a due date said as a day's name. */
const untilWeekday = (weekday: number): number => (weekday - new Date(now).getDay() + 7) % 7 || 7;

// The site's demos (sondine.app's hero film and pictures): a FaceTime call of
// four named voices with its commitments, and an idea recorded on the iPhone
// while walking, as the phone's recordings reach the Mac (ADR 032).
seedDay(base, "ux-demos", [
  {
    at: 5 * H + 15 * M,
    size: "conversation",
    context: "call",
    app: { bundleId: "com.apple.FaceTime", name: "FaceTime" },
    voicedMin: 18,
    names: { A: "@self", B: "Camille", C: "Jules", D: "Marc" },
    lines: [
      ["B", "On fait le point sur l'ouverture du deuxième café ?"],
      ["A", "Oui. Le bail est signé, on récupère les clés le 3 janvier."],
      ["C", "Les travaux peuvent commencer la semaine suivante, j'ai deux devis."],
      ["D", "Côté budget, on tient si les travaux restent sous quarante mille."],
      ["B", "Le moins cher ne fait pas la ventilation, il faudra la prévoir à part."],
      ["C", "Je redemande un chiffrage complet d'ici mercredi."],
      ["D", "Et Camille envoie le devis jeudi, je le relis avant la banque."],
      ["A", "Il nous faut aussi deux personnes de plus dans l'équipe."],
      ["B", "Je publie l'annonce demain matin."],
      ["A", "Parfait, on se rappelle vendredi."],
    ],
    journal: [
      { kind: "event", text: "Clés du deuxième café le 3 janvier", line: 1 },
      {
        kind: "commitment",
        text: "Redemander un chiffrage complet des travaux",
        line: 5,
        who: "C",
        dueText: "mercredi",
        dueIn: untilWeekday(3),
      },
      {
        kind: "commitment",
        text: "Envoyer le devis à Marc",
        line: 6,
        who: "B",
        to: "D",
        dueText: "jeudi",
        dueIn: untilWeekday(4),
      },
      {
        kind: "commitment",
        text: "Publier l'annonce de recrutement",
        line: 8,
        who: "B",
        dueText: "demain",
        dueIn: 1,
      },
    ],
  },
]);
seedDay(base, "ux-demos-phone", [
  {
    at: 7 * H + 18 * M,
    size: "conversation",
    context: "in_person",
    voicedMin: 2,
    names: { A: "@self" },
    lines: [
      ["A", "Idée pour le deuxième café : une carte du midi à emporter."],
      ["A", "Trois plats seulement, qui changent chaque semaine."],
      ["A", "Demander à Jules si la cuisine peut suivre à deux."],
    ],
    journal: [
      {
        kind: "event",
        text: "Idée : une carte du midi à emporter, trois plats par semaine",
        line: 0,
      },
      {
        kind: "commitment",
        text: "Demander à Jules si la cuisine peut suivre",
        line: 2,
        who: "A",
        dueText: "cette semaine",
      },
    ],
  },
]);
{
  // The walk came from the iPhone: a phone track and its recording, with the
  // name typed on the phone.
  const run = Number(
    db.statement("SELECT id FROM track_runs WHERE uid = 'ux-demos-phone'").get()?.["id"],
  );
  db.statement(
    "UPDATE track_runs SET source_kind = 'phone', track_key = 'phone:ux-walk' WHERE id = ?",
  ).run(run);
  db.statement(
    `INSERT INTO phone_recordings (recording_id, device_id, state, track_run_id, sha256,
       time_uncertain, received_at_ms, name, name_typed_at_ms)
     VALUES ('ux-walk', 'ux-iphone', 'stored', ?, ?, 0, ?, 'Idée en marchant', ?)`,
  ).run(run, "0".repeat(64), now, now);
}

// Weeks before: a made-up history, the same at every run (a fixed pseudo-random
// sequence), for the calendar's weeks and months and the commitments page.
// Commitments older than ten days are mostly done.
let seed = 20_261_119;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;

const facetime = { bundleId: "com.apple.FaceTime", name: "FaceTime" };
const discord = { bundleId: "com.hnc.Discord", name: "Discord" };
const notes = { bundleId: "com.apple.Notes", name: "Notes" };
const safari = { bundleId: "com.apple.Safari", name: "Safari" };
const music = { bundleId: "com.apple.Music", name: "Music" };

type Template = Omit<Episode, "at" | "voicedMin" | "size"> & { readonly minutes: number };
const conversations: readonly Template[] = [
  {
    context: "call",
    app: facetime,
    minutes: 12,
    names: { A: "@self", B: "Marc" },
    lines: [
      ["B", "J'ai fini le bilan du mois, le chiffre est en hausse de huit pour cent."],
      ["A", "Super nouvelle. Il te manque quelque chose ?"],
      ["B", "Les factures du fournisseur de lait, je ne les ai pas."],
      ["A", "Je te les envoie d'ici vendredi."],
    ],
    journal: [
      { kind: "event", text: "Bilan du mois : chiffre en hausse de 8 %", line: 0 },
      {
        kind: "commitment",
        text: "Envoyer à Marc les factures du lait",
        who: "A",
        line: 3,
        dueIn: 3,
      },
    ],
  },
  {
    context: "in_person",
    minutes: 25,
    names: { A: "@self", B: "Camille" },
    lines: [
      ["B", "Il faudrait revoir les horaires du dimanche, on ferme trop tôt."],
      ["A", "On peut tester jusqu'à dix-sept heures pendant un mois."],
      ["B", "D'accord, je préviens l'équipe."],
    ],
    journal: [
      { kind: "event", text: "Test d'une fermeture à 17 h le dimanche pendant un mois", line: 1 },
      {
        kind: "commitment",
        text: "Prévenir l'équipe des nouveaux horaires",
        who: "B",
        to: "A",
        line: 2,
        dueIn: 2,
      },
    ],
  },
  {
    context: "call",
    app: discord,
    minutes: 18,
    names: { A: "@self", B: "Jules" },
    lines: [
      ["B", "J'ai une première version du menu en ligne, je te montre ?"],
      ["A", "Oui. Les photos des desserts sont un peu sombres."],
      ["B", "Je les refais et je t'envoie le lien lundi."],
    ],
    journal: [
      {
        kind: "event",
        text: "Première version du menu en ligne, photos des desserts à refaire",
        line: 0,
      },
      {
        kind: "commitment",
        text: "Jules renvoie le lien du menu avec de nouvelles photos",
        who: "B",
        to: "A",
        line: 2,
        dueIn: 4,
      },
    ],
  },
  {
    context: "in_person",
    minutes: 9,
    names: { A: "@self", B: "Inès" },
    lines: [
      ["B", "La farine bio va augmenter de six pour cent le mois prochain."],
      ["A", "Tu peux me faire un prix si on prend deux palettes ?"],
      ["B", "Je regarde et je te rappelle."],
    ],
    journal: [
      { kind: "event", text: "La farine bio augmente de 6 % le mois prochain", line: 0 },
      {
        kind: "commitment",
        text: "Inès rappelle avec un prix pour deux palettes",
        who: "B",
        to: "A",
        line: 2,
      },
    ],
  },
  {
    context: "in_person",
    minutes: 30,
    names: { A: "@self", B: "Sophie" },
    lines: [
      ["B", "Je peux prendre plus de services le samedi à partir du mois prochain."],
      ["A", "Très bien, je refais le planning."],
      ["B", "Et pense à commander des tabliers, il en manque."],
    ],
    journal: [
      { kind: "event", text: "Sophie peut faire plus de samedis", line: 0 },
      { kind: "commitment", text: "Refaire le planning des samedis", who: "A", line: 1, dueIn: 7 },
      { kind: "commitment", text: "Commander des tabliers", who: "A", line: 2 },
    ],
  },
  {
    context: "call",
    app: facetime,
    minutes: 6,
    names: { A: "@self", B: "Paul" },
    lines: [
      ["B", "Le technicien passe pour l'entretien du four jeudi matin."],
      ["A", "Parfait, je serai là à huit heures."],
    ],
    journal: [
      { kind: "event", text: "Entretien du four prévu jeudi matin", line: 0 },
      {
        kind: "commitment",
        text: "Être au café à 8 h pour le technicien",
        who: "A",
        line: 1,
        dueIn: 2,
      },
    ],
  },
  {
    context: "in_person",
    minutes: 15,
    names: { A: "@self", B: "Camille", C: "Jules" },
    lines: [
      ["B", "Pour l'anniversaire du café, on fait une soirée ?"],
      ["C", "Je peux faire l'affiche."],
      ["A", "Bonne idée, on la fait le dernier vendredi du mois."],
    ],
    journal: [
      { kind: "event", text: "Soirée d'anniversaire du café le dernier vendredi du mois", line: 2 },
      {
        kind: "commitment",
        text: "Jules fait l'affiche de la soirée",
        who: "C",
        to: "B",
        line: 1,
        dueIn: 10,
      },
    ],
  },
  {
    context: "call",
    app: discord,
    minutes: 40,
    names: { A: "@self", B: "Camille" },
    lines: [
      ["B", "On regarde ensemble la nouvelle carte d'hiver ?"],
      ["A", "Oui, je verrais bien une soupe du jour et un chocolat épicé."],
      ["B", "Je fais les fiches recettes cette semaine."],
    ],
    journal: [
      { kind: "event", text: "Carte d'hiver : soupe du jour et chocolat épicé", line: 1 },
      {
        kind: "commitment",
        text: "Camille fait les fiches recettes",
        who: "B",
        to: "A",
        line: 2,
        dueIn: 5,
      },
    ],
  },
];
const moments: readonly Line[][] = [
  [["A", "Tu as pensé à sortir les poubelles ?"]],
  [["A", "Il reste du pain d'hier, on en fait du pain perdu ?"]],
  [["A", "La machine à café fait encore un drôle de bruit."]],
];
const dictations = [
  "Rappel : commander du sucre de canne et des gobelets.",
  "Idée : un brunch le premier dimanche du mois.",
  "Penser à renouveler l'assurance du local.",
];
const media = [
  { app: safari, text: "Dans cette vidéo, on apprend à faire une pâte feuilletée maison." },
  { app: music, text: "Et maintenant la météo pour le week-end en Bretagne." },
];

for (let daysAgo = 2; daysAgo <= 80; daysAgo += 1) {
  const day = new Date(base - daysAgo * 86_400_000);
  day.setHours(8, 0, 0, 0);
  // Quieter on Sundays, and some days without anything.
  if (random() < (day.getDay() === 0 ? 0.7 : 0.18)) continue;
  const list: Episode[] = [];
  const count = 1 + Math.floor(random() * 4);
  for (let index = 0; index < count; index += 1) {
    const template = pick(conversations);
    const at = (1 + Math.floor(random() * 10)) * H + Math.floor(random() * 50) * M;
    const { minutes, ...rest } = template;
    list.push({
      ...rest,
      at,
      size: "conversation",
      voicedMin: Math.max(2, Math.round(minutes * (0.6 + random()))),
    });
  }
  if (random() < 0.5) {
    list.push({
      at: (2 + Math.floor(random() * 8)) * H,
      size: "moment",
      context: "in_person",
      voicedMin: 1,
      lines: pick(moments),
    });
  }
  if (random() < 0.35) {
    list.push({
      at: (1 + Math.floor(random() * 9)) * H + 20 * M,
      size: "moment",
      context: "dictation",
      app: notes,
      voicedMin: 1,
      lines: [["A", pick(dictations)]],
    });
  }
  if (random() < 0.3) {
    const played = pick(media);
    list.push({
      at: (3 + Math.floor(random() * 8)) * H + 40 * M,
      size: "moment",
      context: "media",
      app: played.app,
      voicedMin: 1,
      lines: [["A", played.text]],
    });
  }
  // One after the other: an episode starts a minute after the one before ends.
  const spaced: Episode[] = [];
  for (const episode of list.toSorted((a, b) => a.at - b.at)) {
    const previous = spaced.at(-1);
    const at = previous === undefined ? episode.at : Math.max(episode.at, episodeEnd(previous) + M);
    spaced.push({ ...episode, at });
  }
  seedDay(day.getTime(), `ux-history-${daysAgo}`, spaced);
}

// What the user ticked off: most commitments older than ten days.
const tenDaysAgo = base - 10 * 86_400_000;
for (const row of db
  .statement(
    `SELECT i.id FROM journal_items i JOIN episodes e ON e.id = i.episode_id
     WHERE i.kind = 'commitment' AND e.started_at_ms < ? ORDER BY i.id`,
  )
  .all(tenDaysAgo)) {
  if (random() < 0.7) {
    setJournalMark(db, { itemId: Number(row["id"]), markId: null }, { status: "done" }, now);
  }
}

// Tags (ADR 039): the first conversation, every dictation that is an idea, some others.
const tagged = (episodeId: number, name: string, at: number) =>
  setEpisodeTag(db, { episodeId, name, on: true, origin: "app", nowMs: at });
tagged(1, "café", now - 3_000);
tagged(1, "fournisseurs", now - 2_000);
for (const row of db
  .statement(
    `SELECT DISTINCT e.id, e.context FROM episodes e JOIN segments s ON s.episode_id = e.id
     WHERE (e.context = 'dictation' AND s.text LIKE 'Idée%') OR (e.context = 'call' AND s.text LIKE '%carte d''hiver%')
     ORDER BY e.started_at_ms`,
  )
  .all()) {
  const id = Number(row["id"]);
  tagged(id, row["context"] === "dictation" ? "idées" : "carte", now - 10_000 + id);
}

// The Vocabulary (ADR 046): two words of the list, one with a note.
addVocabularyWord(db, { word: "Sondine", note: "le nom de mon app", nowMs: now });
addVocabularyWord(db, { word: "Graphical", nowMs: now });

// The question about anonymous statistics (ADR 042) is answered, so its card
// is not on every screen (`--ask` leaves it).
if (!process.argv.includes("--ask")) {
  setUsageConsent(db, { answer: "no", version: USAGE_REPORT_VERSION, atMs: now });
}

db.close();
console.log(`seeded ${folder}`);
