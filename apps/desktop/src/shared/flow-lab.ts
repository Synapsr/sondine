import * as z from "zod";

// Development only: the flow lab (ADR 049). Environment-free, so the catalog
// and its rules are tested in Node.

/** What core is told at its start (`SONDINE_FLOW_LAB`, core/flow-lab.ts). */
export const LabCoreSettings = z.strictObject({
  /** The lab's fake Cloud (apps/compute/scripts/fake-cloud.ts); null closes the Cloud. */
  cloud: z.strictObject({ endpoint: z.url(), key: z.string().min(1) }).nullable(),
  /** Nothing answers: the Cloud, the updates and the downloads fail as without a network. */
  offline: z.boolean(),
  /** The version the update check finds; null finds none. */
  update: z
    .string()
    .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u)
    .nullable(),
  /** The fake `claude` (packages/engines/test/fake-claude.ts), or none installed. */
  agent: z.strictObject({
    executable: z.string().min(1).nullable(),
    mode: z.enum(["normal", "signed-out", "old"]),
  }),
});
export type LabCoreSettings = z.output<typeof LabCoreSettings>;

// The catalog: journeys cut into steps, each with a starting state the lab
// puts back exactly (main/flow-lab/controller.ts). Not translated, like the
// design system page: the lab is for whoever builds Sondine.

/** What the step's world is like; the HUD changes it, the step sets its defaults. */
export const LabSituation = z.strictObject({
  /** What macOS says of the microphone and system audio (the fake helper). */
  permissions: z.enum(["ask", "granted", "denied", "restricted"]),
  /** The transcription model on this Mac (an empty file of its size, with its manifest). */
  model: z.enum(["absent", "present"]),
  network: z.enum(["online", "offline"]),
  /** Places left in the Cloud's wave. */
  wave: z.enum(["free", "full"]),
  agent: z.enum(["ready", "signed-out", "missing"]),
  /** « Ce Mac est trop petit » (the model step's development switch). */
  mac: z.enum(["normal", "small"]),
});
export type LabSituation = z.output<typeof LabSituation>;
export type LabSituationKey = keyof LabSituation;

export const DEFAULT_SITUATION: LabSituation = {
  permissions: "ask",
  model: "absent",
  network: "online",
  wave: "free",
  agent: "ready",
  mac: "normal",
};

/** How the HUD names each part of the situation and its values. */
export const SITUATION_LABELS: {
  readonly [Key in LabSituationKey]: {
    readonly label: string;
    readonly values: Readonly<Record<LabSituation[Key], string>>;
  };
} = {
  permissions: {
    label: "Permissions",
    values: {
      ask: "À demander",
      granted: "Accordées",
      denied: "Refusées",
      restricted: "Restreintes",
    },
  },
  model: { label: "Modèle", values: { absent: "Absent", present: "Présent" } },
  network: { label: "Réseau", values: { online: "En ligne", offline: "Hors ligne" } },
  wave: { label: "Vague du Cloud", values: { free: "Places libres", full: "Complète" } },
  agent: {
    label: "Agent",
    values: { ready: "Prêt", "signed-out": "Non connecté", missing: "Absent" },
  },
  mac: { label: "Mac", values: { normal: "Assez grand", small: "Trop petit" } },
};

export type FakeCloudScenario =
  | "wave-70"
  | "wave-full"
  | "trial"
  | "trial-done"
  | "subscribed"
  | "cancelling"
  | "past-due";

/** Done in order once the data is seeded and core is up. */
export type LabAction =
  /** The first run, open at this step (nothing recorded until its end). */
  | { readonly type: "first-run"; readonly step: FirstRunStep }
  /** The first run done, on an empty data folder. */
  | { readonly type: "first-run-done" }
  /** A row of the settings table, as JSON. */
  | { readonly type: "setting"; readonly key: string; readonly value: unknown }
  /** A trial place on the lab's Cloud, chosen for transcription. */
  | { readonly type: "cloud-trial" }
  | { readonly type: "cloud"; readonly scenario: FakeCloudScenario }
  /** « S'abonner »: the Checkout page is asked for (no browser opens in the lab). */
  | { readonly type: "cloud-checkout" }
  | { readonly type: "chat"; readonly enabled: boolean }
  | { readonly type: "check-updates" }
  /** A phone paired with this Mac. */
  | { readonly type: "phone-paired" };

export type FirstRunStep = "welcome" | "statistics" | "permissions" | "model" | "voice" | "start";

/** Clicks the window makes once the step's page is there (a screen only a click opens). */
export type LabClick =
  /** The nth choice of the first run's « où transcrire » (1 this Mac, 2 your server, 3 the Cloud). */
  | { readonly type: "transcription-choice"; readonly index: 1 | 2 | 3 }
  /** A button, by its exact text in either language. */
  | { readonly type: "button"; readonly fr: string; readonly en: string }
  /** A shortcut, with ⌘ (the agent's panel is ⌘J). */
  | { readonly type: "command-key"; readonly key: string };

export interface LabStep {
  readonly id: string;
  readonly title: string;
  /** The window's route, as the hash holds it. */
  readonly path: string;
  /** The data folder: nothing, or the invented days (scripts/ux/seed.ts). */
  readonly data: "empty" | "invented";
  readonly actions?: readonly LabAction[];
  readonly clicks?: readonly LabClick[];
  /** What this step changes from the default situation. */
  readonly situation?: Partial<LabSituation>;
  /** The parts of the situation the HUD offers here. */
  readonly offers?: readonly LabSituationKey[];
  /** What to look at, in a few words. */
  readonly note?: string;
}

export interface LabJourney {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly LabStep[];
}

const WELCOME = "/welcome";
const CLOUD_PAGE = "/settings/transcription";
const CONTINUE: LabClick = { type: "button", fr: "Continuer", en: "Continue" };
const ASK: LabClick = { type: "command-key", key: "j" };
const trialFirst: readonly LabAction[] = [{ type: "cloud-trial" }];

export const LAB_JOURNEYS: readonly LabJourney[] = [
  {
    id: "first-run",
    title: "Premier lancement",
    steps: [
      { id: "goal", title: "Bienvenue, l’objectif", path: WELCOME, data: "empty" },
      {
        id: "statistics",
        title: "Statistiques anonymes",
        path: WELCOME,
        data: "empty",
        actions: [{ type: "first-run", step: "statistics" }],
      },
      {
        id: "permissions",
        title: "Permissions",
        path: WELCOME,
        data: "empty",
        actions: [{ type: "first-run", step: "permissions" }],
        offers: ["permissions"],
      },
      {
        id: "where",
        title: "Où transcrire",
        path: WELCOME,
        data: "empty",
        actions: [{ type: "first-run", step: "model" }],
        offers: ["mac", "model"],
      },
      {
        id: "device",
        title: "Sur ce Mac : le modèle",
        path: WELCOME,
        data: "empty",
        actions: [{ type: "first-run", step: "model" }],
        clicks: [{ type: "transcription-choice", index: 1 }, CONTINUE],
        offers: ["model", "network", "mac"],
      },
      {
        id: "own-server",
        title: "Votre serveur",
        path: WELCOME,
        data: "empty",
        actions: [{ type: "first-run", step: "model" }],
        clicks: [{ type: "transcription-choice", index: 2 }, CONTINUE],
      },
      {
        id: "cloud-wave",
        title: "Cloud : la vague",
        path: WELCOME,
        data: "empty",
        actions: [{ type: "first-run", step: "model" }],
        clicks: [{ type: "transcription-choice", index: 3 }, CONTINUE],
        offers: ["wave", "network"],
      },
      {
        id: "voice",
        title: "Lecture de la voix",
        path: WELCOME,
        data: "empty",
        actions: [{ type: "first-run", step: "voice" }],
      },
      {
        id: "start",
        title: "Commencer l’écoute",
        path: WELCOME,
        data: "empty",
        actions: [{ type: "first-run", step: "start" }],
        offers: ["permissions", "model"],
      },
      {
        id: "restore",
        title: "Restaurer une sauvegarde",
        path: WELCOME,
        data: "empty",
        note: "« Restaurer une sauvegarde » ouvre le fichier du labo (backup.sondine) : exportez-en un d’abord (Sauvegarde ▸ Exporter).",
      },
    ],
  },
  {
    id: "first-listen",
    title: "Première écoute",
    steps: [
      {
        id: "empty-today",
        title: "Aujourd’hui, vide",
        path: "/",
        data: "empty",
        actions: [{ type: "first-run-done" }],
        situation: { permissions: "granted" },
        offers: ["permissions"],
      },
      {
        id: "first-episode",
        title: "Premier épisode en cours",
        path: "/",
        data: "empty",
        actions: [{ type: "first-run-done" }],
        situation: { permissions: "granted" },
        note: "Le faux micro parle toutes les deux secondes : l’épisode s’ouvre en une dizaine de secondes.",
      },
      {
        id: "waiting-model",
        title: "En attente du modèle",
        path: "/settings/transcription",
        data: "empty",
        actions: [{ type: "first-run-done" }],
        situation: { permissions: "granted", model: "absent" },
        offers: ["model"],
      },
    ],
  },
  {
    id: "daily",
    title: "Le quotidien",
    steps: [
      { id: "today", title: "Aujourd’hui", path: "/", data: "invented" },
      {
        id: "episode",
        title: "Un épisode et sa transcription",
        path: "/episode/1",
        data: "invented",
      },
      { id: "search", title: "Recherche", path: "/search?q=four", data: "invented" },
      { id: "calendar", title: "Calendrier", path: "/calendar?zoom=week", data: "invented" },
      { id: "commitments", title: "Engagements", path: "/commitments", data: "invented" },
      {
        id: "statistics-question",
        title: "La question des statistiques",
        path: "/",
        data: "invented",
        actions: [{ type: "setting", key: "usage.consent", value: null }],
      },
    ],
  },
  {
    id: "people",
    title: "Personnes et voix",
    steps: [
      { id: "people", title: "Personnes", path: "/people", data: "invented" },
      { id: "person", title: "Une personne", path: "/people/1", data: "invented" },
      {
        id: "name-voice",
        title: "Nommer une voix",
        path: "/episode/4",
        data: "invented",
        note: "Une voix sans nom : cliquez sur son badge.",
      },
      {
        id: "merge",
        title: "Fusionner deux personnes",
        path: "/people/2",
        data: "invented",
        note: "Menu de la personne ▸ Fusionner.",
      },
    ],
  },
  {
    id: "agent",
    title: "Agent",
    steps: [
      { id: "off", title: "Désactivé", path: "/settings/agents", data: "invented" },
      {
        id: "missing",
        clicks: [ASK],
        title: "Absent",
        path: "/",
        data: "invented",
        actions: [{ type: "chat", enabled: true }],
        situation: { agent: "missing" },
        offers: ["agent"],
      },
      {
        id: "signed-out",
        clicks: [ASK],
        title: "Non connecté",
        path: "/",
        data: "invented",
        actions: [{ type: "chat", enabled: true }],
        situation: { agent: "signed-out" },
        offers: ["agent"],
      },
      {
        id: "ready",
        clicks: [ASK],
        title: "Prêt, une discussion",
        path: "/",
        data: "invented",
        actions: [{ type: "chat", enabled: true }],
        offers: ["agent"],
        note: "Le faux claude répond par un appel d’outil, puis un texte.",
      },
    ],
  },
  {
    id: "cloud",
    title: "Cloud Sondine",
    steps: [
      {
        id: "trial",
        title: "Essai en cours, la jauge",
        path: CLOUD_PAGE,
        data: "invented",
        actions: [...trialFirst, { type: "cloud", scenario: "trial" }],
        offers: ["network"],
      },
      {
        id: "trial-done",
        title: "Quota atteint",
        path: CLOUD_PAGE,
        data: "invented",
        actions: [...trialFirst, { type: "cloud", scenario: "trial-done" }],
        offers: ["network"],
      },
      {
        id: "checkout",
        title: "Checkout",
        path: CLOUD_PAGE,
        data: "invented",
        actions: [
          ...trialFirst,
          { type: "cloud", scenario: "trial-done" },
          { type: "cloud-checkout" },
        ],
        note: "En attente du paiement : aucun navigateur ne s’ouvre.",
      },
      {
        id: "subscribed",
        title: "Abonné",
        path: CLOUD_PAGE,
        data: "invented",
        actions: [...trialFirst, { type: "cloud", scenario: "subscribed" }],
        offers: ["network"],
      },
      {
        id: "past-due",
        title: "Échec de paiement",
        path: CLOUD_PAGE,
        data: "invented",
        actions: [...trialFirst, { type: "cloud", scenario: "past-due" }],
      },
      {
        id: "cancelling",
        title: "Fin d’abonnement",
        path: CLOUD_PAGE,
        data: "invented",
        actions: [...trialFirst, { type: "cloud", scenario: "cancelling" }],
      },
    ],
  },
  {
    id: "backup",
    title: "Sauvegarde",
    steps: [
      {
        id: "export",
        title: "Exporter",
        path: "/settings/data",
        data: "invented",
        note: "Le panneau d’enregistrement répond seul : backup.sondine, dans le dossier du labo.",
      },
      {
        id: "restored",
        title: "Après la restauration",
        path: "/",
        data: "invented",
        actions: [
          {
            type: "setting",
            key: "backup.restored",
            value: { restoredAtMs: 0, createdAtMs: 0, models: [], prefs: {} },
          },
        ],
      },
    ],
  },
  {
    id: "update",
    title: "Mise à jour",
    steps: [
      {
        id: "available",
        title: "Mise à jour disponible",
        path: "/settings/general",
        data: "invented",
        actions: [{ type: "check-updates" }],
        offers: ["network"],
      },
      {
        id: "updated",
        title: "Après la mise à jour",
        path: "/",
        data: "invented",
        actions: [{ type: "setting", key: "updates.updated", value: { version: "0.12.0" } }],
      },
    ],
  },
  {
    id: "phone",
    title: "iPhone",
    steps: [
      {
        id: "none",
        title: "Aucun iPhone",
        path: "/settings/phone",
        data: "empty",
        actions: [{ type: "first-run-done" }],
      },
      {
        id: "paired",
        title: "iPhone appairé, un enregistrement reçu",
        path: "/settings/phone",
        data: "invented",
        actions: [{ type: "phone-paired" }],
      },
    ],
  },
  {
    id: "end",
    title: "La fin",
    steps: [
      {
        id: "end-episode",
        title: "Terminer un épisode en cours",
        path: "/",
        data: "invented",
        situation: { permissions: "granted" },
        note: "Le faux micro ouvre un épisode en une dizaine de secondes : « Terminer » le clôt.",
      },
      {
        id: "forget",
        title: "Oublier les dernières minutes",
        path: "/",
        data: "invented",
        situation: { permissions: "granted" },
        note: "Menu de l’écoute ▸ Oublier.",
      },
    ],
  },
];

/** Where the HUD is: a journey's step, and what the user changed of its situation. */
export const LabPosition = z.strictObject({
  journey: z.string(),
  step: z.string(),
  situation: LabSituation.partial(),
});
export type LabPosition = z.output<typeof LabPosition>;

export const FIRST_POSITION: LabPosition = { journey: "first-run", step: "goal", situation: {} };

export const WINDOW_SIZES = [
  { width: 1280, height: 820 },
  { width: 1024, height: 700 },
  { width: 800, height: 600 },
] as const;

export const LabCommand = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("go"), journey: z.string(), step: z.string() }),
  z.strictObject({ type: z.literal("next") }),
  z.strictObject({ type: z.literal("previous") }),
  z.strictObject({ type: z.literal("replay") }),
  z.strictObject({ type: z.literal("restart") }),
  z.strictObject({ type: z.literal("situation"), situation: LabSituation.partial() }),
  z.strictObject({
    type: z.literal("size"),
    width: z.int().positive(),
    height: z.int().positive(),
  }),
]);
export type LabCommand = z.output<typeof LabCommand>;

export interface LabView {
  readonly position: LabPosition;
  /** The situation in force: the defaults, the step's, then the user's. */
  readonly situation: LabSituation;
  /** A step is being put back; the HUD waits. */
  readonly busy: boolean;
  readonly problem: string | null;
  /** The last step of its journey. */
  readonly last: boolean;
  /** Counts the steps put back: the window makes the step's clicks once per new one. */
  readonly generation: number;
  /** When the step's page was asked for: only a page loaded after it makes the clicks. */
  readonly loadedAtMs: number;
}

export function findStep(
  journeyId: string,
  stepId: string,
): { readonly journey: LabJourney; readonly step: LabStep; readonly index: number } | null {
  const journey = LAB_JOURNEYS.find((candidate) => candidate.id === journeyId);
  const index = journey?.steps.findIndex((candidate) => candidate.id === stepId) ?? -1;
  const step = journey?.steps[index];
  return journey === undefined || step === undefined ? null : { journey, step, index };
}

export function situationOf(step: LabStep, chosen: LabPosition["situation"]): LabSituation {
  const given = Object.fromEntries(
    Object.entries(chosen).filter(([, value]) => value !== undefined),
  );
  return LabSituation.parse({ ...DEFAULT_SITUATION, ...step.situation, ...given });
}

/** Where a command leads; null when it stays (the first step's « précédente »). */
export function nextPosition(position: LabPosition, command: LabCommand): LabPosition | null {
  const found = findStep(position.journey, position.step);
  switch (command.type) {
    case "go":
      return findStep(command.journey, command.step) === null
        ? null
        : {
            journey: command.journey,
            step: command.step,
            situation: command.journey === position.journey ? position.situation : {},
          };
    case "next":
    case "previous": {
      if (found === null) return null;
      const step = found.journey.steps[found.index + (command.type === "next" ? 1 : -1)];
      return step === undefined ? null : { ...position, step: step.id };
    }
    case "replay":
      return found === null ? FIRST_POSITION : position;
    case "restart": {
      const first = found?.journey.steps[0];
      return first === undefined
        ? FIRST_POSITION
        : { journey: position.journey, step: first.id, situation: {} };
    }
    case "situation":
      return { ...position, situation: { ...position.situation, ...command.situation } };
    case "size":
      return null;
  }
}
