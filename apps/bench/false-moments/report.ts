import type { BenchmarkResult } from "./benchmark.ts";

const round = (value: number) => value.toFixed(2);
export function reportMarkdown(result: BenchmarkResult) {
  const lines = [
    "# Faux moments et paroles courtes — mesures sur fichiers",
    "",
    `Source : \`${result.sourceCommit}\`. Regroupement : ${result.groupingVersions.join(", ")}. Graine : ${result.seed}.`,
    "",
    `Corpus SHA-256 : \`${result.corpusSha256}\`. Helper : \`${result.helperSha256}\`.`,
    "",
    "Aucun modèle de transcription exécuté. Les jobs sont réellement insérés par le code produit dans une base SQLite en mémoire, puis la base est fermée.",
    "",
    "Depuis grouping/2, les traces fermées reçoivent des jobs de priorité trace. Les compteurs séparent ces jobs de ceux des autres épisodes ; aucun compteur ne mesure des transcriptions terminées. La disponibilité du modèle déjà chargé et le coût de traitement des traces ne sont pas mesurés ici. Le corpus est exécuté sans métadonnée d’appel ; les appels déclarés sont couverts séparément par les tests du bridge.",
    "",
    "## Conservation des mots isolés",
    "",
    "Les dénominateurs sont des fichiers portant un mot selon le corpus, pas des mots chronométrés. Une conservation demande au moins 50 ms de chevauchement du fichier avec une région gardée (pré/post-roll inclus). La colonne entier demande 95 % du fichier. L’enveloppe parole exclut le roll, mais ne donne pas les frames VAD. Les répétitions par condition ne sont pas de nouveaux locuteurs.",
    "",
    "| Variante | Langue | Condition | Fichiers | Chevauchement gardé | Fichier entier | Enveloppe parole |",
    "|---|---|---|---:|---:|---:|---:|",
  ];
  const keys = new Set(
    result.measurements
      .filter((row) => row.scenario.suite === "isolated")
      .map((row) => `${row.variant}|${row.events[0]?.language}|${row.scenario.condition}`),
  );
  for (const key of keys) {
    const [variant, language, condition] = key.split("|");
    const rows = result.measurements.filter(
      (row) =>
        row.scenario.suite === "isolated" &&
        row.variant === variant &&
        row.events[0]?.language === language &&
        row.scenario.condition === condition,
    );
    const events = rows.flatMap((row) => row.events);
    lines.push(
      `| ${variant} | ${language} | ${condition} | ${events.length} | ${events.filter((e) => e.captureOverlap).length} | ${events.filter((e) => e.wholeClipRetained).length} | ${events.filter((e) => e.speechEnvelopeOverlap).length} |`,
    );
  }
  lines.push(
    "",
    "Les conditions avec fond parlé ou musical mesurent une conservation de fenêtre. Le fond peut expliquer toute la détection ; voir les témoins appariés. Aucun taux de reconnaissance du mot n’en est déduit.",
    "",
    "## Flux continus : bruit, médias, épisodes et jobs",
    "",
    "Six répétitions d’un même bruit sont six expositions, pas six enregistrements indépendants. Le rythme imposé (gap dans le nom) détermine les taux horaires. Les médias vocaux sont comptés à part, jamais automatiquement classés faux positifs. La fermeture logique après la fin du fichier ne rallonge pas le dénominateur.",
    "",
    "| Variante | Séquence | Route | Secondes | Régions | Régions/h | Trace | Moment | Conversation | Jobs hors traces | Jobs traces | Tous jobs/h | Traces candidates à chaud |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const row of result.measurements.filter((item) =>
    ["negative", "media", "timeline"].includes(item.scenario.suite),
  )) {
    const { trace, moment, conversation } = row.plan.counts;
    lines.push(
      `| ${row.variant} | ${row.scenario.id} | ${row.scenario.sourceKind} | ${round(row.durationMs / 1000)} | ${row.regionCount} | ${round(row.regionsPerHour)} | ${trace} | ${moment} | ${conversation} | ${row.plan.otherJobsCreated} | ${row.plan.traceJobsCreated} | ${round(row.jobsPerHour)} | ${row.plan.warmTraceCandidates} |`,
    );
  }
  lines.push(
    "",
    "## Témoins de fond appariés",
    "",
    "| Variante | Condition | Fenêtres cibles | Gardées avec cible | Gardées sans cible | Nouvellement gardées |",
    "|---|---|---:|---:|---:|---:|",
  );
  for (const variant of result.variants)
    for (const condition of ["music-equal-rms", "speech-proxy-equal-rms"]) {
      const measurements = result.measurements.filter(
        (row) =>
          row.variant === variant.id &&
          row.scenario.suite === "isolated" &&
          row.scenario.condition === condition,
      );
      const pairs = result.paired.filter((pair) => measurements.some((row) => row.id === pair.id));
      const sum = (
        key:
          | "targetWindows"
          | "retainedWithTarget"
          | "retainedWithoutTarget"
          | "newlyRetainedWindows",
      ) => pairs.reduce((total, pair) => total + pair[key], 0);
      lines.push(
        `| ${variant.id} | ${condition} | ${sum("targetWindows")} | ${sum("retainedWithTarget")} | ${sum("retainedWithoutTarget")} | ${sum("newlyRetainedWindows")} |`,
      );
    }
  lines.push(
    "",
    "## Coût du mode fichier",
    "",
    `Nombre de processus helper : ${result.measurements.length}. Pic RSS maximal : ${round(Math.max(...result.measurements.map((row) => row.maximumRssBytes)) / 2 ** 20)} MiB. Temps CPU helper total : ${round(result.measurements.reduce((sum, row) => sum + row.helperCpuMs, 0) / 1000)} s. Temps mur total des invocations : ${round(result.measurements.reduce((sum, row) => sum + row.processWallMs, 0) / 1000)} s.`,
    "",
    "Ces mesures incluent des chargements répétés de Silero en mode fichier. Elles ne mesurent ni le budget always-on, ni Nemotron, ni une régression de fluidité du Mac. Les états système avant/après et les temps individuels sont dans results.json.",
    "",
    "## Seuils expérimentaux — non appliqués",
    "",
    "La seule variable du helper est minSpeechMs : 250 (défaut), 128, 192 et 384 ms. Les tableaux montrent leurs effets mesurés sur les mêmes signaux. Baisser ce seuil vise à conserver davantage de petites rafales ; le coût en bruit et jobs doit être lu dans la même variante. Le durcir vise à réduire ces rafales au risque de perdre les mots courts. Ce corpus diagnostique ne suffit pas à choisir un seuil produit.",
    "",
    "## Limites",
    "",
    ...result.limits.map((limit) => `- ${limit}`),
    "",
    ...result.corpus.limitations.map((limit) => `- ${limit}`),
    "",
    "## Sources et licences",
    "",
    ...result.corpus.sources.map(
      (source) =>
        `- ${source.id} : [source](${source.sourcePage}), [licence ${source.license}](${source.licenseUrl}). ${source.attribution}. SHA-256 ${source.sha256}.`,
    ),
    "",
  );
  return lines.join("\n");
}
