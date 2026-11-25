# Diagnostic faux moments — revalidation de l’étape 2

Mesuré sur `9caf5788895b37c44b94fec9c7b2365731037656`, `grouping/2`, Apple M2 / 16 GiB / macOS 27.0.1, le 6 novembre 2026. Ce rapport remplace la livraison sur `cec8c54`. Aucun fichier produit modifié, aucun seuil appliqué, aucune transcription exécutée.

## Résultat de la revalidation

**Les 1 332 essais conservent exactement les résultats acoustiques et les classifications hors appel de `cec8c54`.** Les 333 signaux générés ont les mêmes SHA-256. Les régions, probabilités, temps voisé, rejets, paramètres, scores de conservation et témoins appariés sont identiques. Les membres, bornes, contextes, tailles et entrées du classificateur des épisodes sont également identiques. Les clés dérivées de la version de regroupement sont comparées séparément.

Les seuls changements attendus concernent `grouping/2` et la création des jobs de traces. Les jobs hors traces gardent leurs comptes et priorités. Toutes les traces fermées ont maintenant un vrai job de priorité `analysisPriorities.trace` (50), lu dans la table `jobs`. Aucun job n’est exécuté : ce résultat ne mesure ni le coût d’une transcription de trace ni le nombre pouvant tenir dans une session de modèle déjà chargé.

| Variante    | Jobs hors traces cec8c54 | Jobs hors traces 9caf578 | Jobs traces cec8c54 | Jobs traces 9caf578 |
| ----------- | -----------------------: | -----------------------: | ------------------: | ------------------: |
| default-250 |                       79 |                       79 |                   0 |                 236 |
| short-128   |                       79 |                       79 |                   0 |                 249 |
| short-192   |                       79 |                       79 |                   0 |                 246 |
| strict-384  |                       79 |                       79 |                   0 |                 213 |

Ces totaux couvrent les 333 fixtures de chaque variante : mots isolés, témoins de fond, flux synthétiques, bruits et médias. Ils ne décrivent pas une journée réelle, et les mêmes originaux sont réutilisés entre conditions.

## Constats utiles au produit

- **La toux peut encore devenir un moment à cause des silences internes comptés comme voix.** Six répétitions espacées de 4 s produisent au défaut 250 ms cinq régions, un moment et un job hors traces. Le helper compte 1 056 ms de voix ; le produit, 2 528 ms. Avec 55 s d’espacement, les cinq régions deviennent cinq traces : elles créent maintenant cinq jobs de priorité trace, contre zéro job auparavant.
- **Durcir à 384 ms ne supprime pas le job ordinaire de toux.** Cela conserve seulement 7/9 clips français propres et 5/9 atténués de 24 dB, contre 8/9 et 7/9 au défaut 250 ms.
- **192 ms reste une piste d’essai.** Cette variante conserve 9/9 clips français propres, 8/9 atténués et 4/9 sur musique, contre 8/9, 7/9 et 2/9 au défaut. Elle conserve aussi six régions de toux au lieu de cinq. À 128 ms, le score sur musique atteint 5/9 sans améliorer les deux autres comptes au-delà de 192 ms. Aucun seuil produit n’est proposé comme acquis sur ce petit corpus.
- **Le fond parlé explique à lui seul le rappel apparent parfait.** Les neuf fenêtres françaises sont conservées avec la cible et sans la cible. Cela ne prouve pas que la petite voix ajoutée a été détectée.

La piste de transmettre le vrai temps voisé à la qualification reste réservée au chantier produit. Pour la toux dense, 1 056 ms se trouve sous le seuil trace de 1 500 ms : l’effet attendu serait un job de trace à la place d’un job ordinaire, sous réserve de la qualification complète. Ce changement n’a pas été implémenté ou mesuré dans ce patch.

## Adaptation au produit et contrôles

- Le bridge importe toujours les vrais `planEpisodes` et `applyEpisodePlan`, et applique leurs écritures dans SQLite en mémoire. Il utilise maintenant `GROUPING_V2`, le champ `attributedBundleId` et les vraies priorités des jobs.
- **46 tests propres au benchmark passent**, dont 20 sur le planner. Les 11 nouveaux cas d’appel importent des intervalles déclarés via `recordCallActive`, `recordCallEnded` et `loadCallsBetween` : témoin sans appel, milieu de région aux bornes inclusives, fermeture après 45 s, appel actif, parole avant/pendant/après et piste système sans attribution. Un appel avec moins de 1,5 s de voix reste de taille trace, même avec le contexte `call`.
- Les fichiers audio du corpus restent sans métadonnée d’appel. Les fixtures d’appel ne valident ni la détection matérielle des appels, ni la règle navigateur micro + sortie, ni les taps simultanés de plusieurs apps.
- Le TypeScript dédié au benchmark passe sur le runner. Le paquet bench compte 95 tests réussis et un test d’expérience ignoré lors des contrôles ordinaires ; l’expérience opt-in de 1 332 essais a bien été exécutée séparément.
- **`pnpm check` passe sur le portable de Téo**, dans un worktree détaché à `9caf578`, après vérification et application du candidat de 18 fichiers. Le bench y a été exécuté à neuf. Les sept autres tâches de test ont réutilisé des entrées Turbo identiques ; les tests engines ont en plus été relancés à neuf : 89 réussis. Le journal est livré et son SHA-256 vérifié sur le runner : `079ea4afee4248702a64e9c252b01919a717629f2f2b8e342a878e3ba89478ef`. Le worktree de validation a été supprimé, main est resté intact pendant cette validation.
- Sur le runner, la commande complète a terminé l’expérience puis échoué au contrôle produit : le test de copie de modèle exige environ 14 GiB libres, contre 2,9 GiB disponibles. Une relance inchangée confirme cette seule erreur ; le timeout initial du test exhaustif des nombres français disparaît. Ces deux journaux sont conservés. Le fil principal indique avoir rendu le test de copie indépendant du disque dans `ce09b15` ; ce commit est hors de la base mesurée ici.
- Pic RSS maximal du helper fichier : **46.78 MiB**. Le swap système avant/après reste à 4 033,62 MiB. Ces instantanés ne mesurent ni le pic de swap, ni l’impact d’un modèle de transcription, ni une amélioration de fluidité par rapport à la campagne précédente.
- Aucun enregistrement audio ni transcript dans le patch ou l’archive. Les sons restent dans le cache externe. Aucun serveur ni instance Sondine lancé ou redémarré.

## Limites conservées

42 originaux publics : 9 clips FR, 24 EN, 5 bruits, un instrumental, un chant et deux lectures FR servant de proxy de média parlé. Les fenêtres acoustiques françaises provisoires, autour de 310–510 ms, ne sont pas une vérité terrain validée. Le rappel strict 100–600 ms, notamment 100–300 ms, la vraie télévision, les chuchotements et la distance réelle restent non mesurés. Les bruits sont décrits par leurs auteurs, sans écoute indépendante certifiant l’absence de parole. Les taux horaires décrivent la densité synthétique imposée.

## Reproduire et vérifier

Depuis la racine du dépôt, avec Swift, Node, pnpm et ffmpeg disponibles :

```sh
node apps/bench/false-moments/run.mjs
```

Sur `9caf578`, prévoir aussi plus de 14 GiB libres pour le test produit de copie exécuté par `pnpm check`. Le [README du benchmark](../../apps/bench/false-moments/README.md) détaille le cache hors dépôt, les métriques et les licences. Les objets publics vérifiés sont réutilisés ; une acquisition vierge peut être soumise au Retry-After du fournisseur.

La livraison externe contient les sorties natives, les deux jeux de résultats, les journaux et le comparateur. Depuis ce dossier :

```sh
python3 compare-9caf578.py baseline-results.json results.json comparison-replayed.json
```

`comparison-9caf578.json` expose les champs comparés et chaque différence attendue ou inattendue. Les temps CPU/mur, RSS, PID et états système sont exclus de l’égalité déterministe. Le code du harness livré est identique à celui exécuté et à celui validé sur le portable ; seul ce rapport est ajouté après les contrôles.

Corpus SHA-256 : `4f9a8f4bd6eee2ac9805b58fd7677818e101f4b480ca6d728292636017a91c0b`. Harness SHA-256 : `69752cb09b2837d86eae3a091ad60b8dfe517f91b7254950d24a19773edd7a2b`. Le manifeste de livraison couvre tous les fichiers, dont les preuves de validation.

---

# Faux moments et paroles courtes — mesures sur fichiers

Source : `9caf5788895b37c44b94fec9c7b2365731037656`. Regroupement : grouping/2. Graine : 20261106.

Corpus SHA-256 : `4f9a8f4bd6eee2ac9805b58fd7677818e101f4b480ca6d728292636017a91c0b`. Helper : `343d2e24d8b16df070735ee0bc6254be001d88a9a2aa3b08b648ec20ee29c2d6`.

Aucun modèle de transcription exécuté. Les jobs sont réellement insérés par le code produit dans une base SQLite en mémoire, puis la base est fermée.

Avec grouping/2, les traces fermées reçoivent des jobs de priorité trace. Les compteurs séparent ces jobs de ceux des autres épisodes ; aucun compteur ne mesure des transcriptions terminées. La disponibilité du modèle déjà chargé et le coût de traitement des traces ne sont pas mesurés ici. Le corpus est exécuté sans métadonnée d’appel ; les appels déclarés sont couverts séparément par les tests du bridge.

## Conservation des mots isolés

Les dénominateurs sont des fichiers portant un mot selon le corpus, pas des mots chronométrés. Une conservation demande au moins 50 ms de chevauchement du fichier avec une région gardée (pré/post-roll inclus). La colonne entier demande 95 % du fichier. L’enveloppe parole exclut le roll, mais ne donne pas les frames VAD. Les répétitions par condition ne sont pas de nouveaux locuteurs.

| Variante    | Langue | Condition              | Fichiers | Chevauchement gardé | Fichier entier | Enveloppe parole |
| ----------- | ------ | ---------------------- | -------: | ------------------: | -------------: | ---------------: |
| default-250 | fr     | clean                  |        9 |                   8 |              8 |                8 |
| default-250 | fr     | quiet-12db             |        9 |                   8 |              8 |                8 |
| default-250 | fr     | quiet-24db             |        9 |                   7 |              7 |                7 |
| default-250 | fr     | room-proxy             |        9 |                   8 |              8 |                8 |
| default-250 | fr     | music-equal-rms        |        9 |                   2 |              2 |                2 |
| default-250 | fr     | speech-proxy-equal-rms |        9 |                   9 |              9 |                9 |
| default-250 | fr     | echo-120ms             |        9 |                   9 |              9 |                9 |
| default-250 | en     | clean                  |       24 |                  22 |             22 |               22 |
| default-250 | en     | quiet-12db             |       24 |                  22 |             22 |               22 |
| default-250 | en     | quiet-24db             |       24 |                  21 |             21 |               21 |
| default-250 | en     | room-proxy             |       24 |                  22 |             22 |               22 |
| default-250 | en     | music-equal-rms        |       24 |                  16 |             16 |               16 |
| default-250 | en     | speech-proxy-equal-rms |       24 |                  24 |             24 |               24 |
| default-250 | en     | echo-120ms             |       24 |                  22 |             22 |               22 |
| short-128   | fr     | clean                  |        9 |                   9 |              9 |                9 |
| short-128   | fr     | quiet-12db             |        9 |                   9 |              9 |                9 |
| short-128   | fr     | quiet-24db             |        9 |                   8 |              8 |                8 |
| short-128   | fr     | room-proxy             |        9 |                   9 |              9 |                9 |
| short-128   | fr     | music-equal-rms        |        9 |                   5 |              5 |                5 |
| short-128   | fr     | speech-proxy-equal-rms |        9 |                   9 |              9 |                9 |
| short-128   | fr     | echo-120ms             |        9 |                   9 |              9 |                9 |
| short-128   | en     | clean                  |       24 |                  22 |             22 |               22 |
| short-128   | en     | quiet-12db             |       24 |                  22 |             22 |               22 |
| short-128   | en     | quiet-24db             |       24 |                  21 |             21 |               21 |
| short-128   | en     | room-proxy             |       24 |                  22 |             22 |               22 |
| short-128   | en     | music-equal-rms        |       24 |                  18 |             18 |               18 |
| short-128   | en     | speech-proxy-equal-rms |       24 |                  24 |             24 |               24 |
| short-128   | en     | echo-120ms             |       24 |                  24 |             24 |               24 |
| short-192   | fr     | clean                  |        9 |                   9 |              9 |                9 |
| short-192   | fr     | quiet-12db             |        9 |                   9 |              9 |                9 |
| short-192   | fr     | quiet-24db             |        9 |                   8 |              8 |                8 |
| short-192   | fr     | room-proxy             |        9 |                   9 |              9 |                9 |
| short-192   | fr     | music-equal-rms        |        9 |                   4 |              4 |                4 |
| short-192   | fr     | speech-proxy-equal-rms |        9 |                   9 |              9 |                9 |
| short-192   | fr     | echo-120ms             |        9 |                   9 |              9 |                9 |
| short-192   | en     | clean                  |       24 |                  22 |             22 |               22 |
| short-192   | en     | quiet-12db             |       24 |                  22 |             22 |               22 |
| short-192   | en     | quiet-24db             |       24 |                  21 |             21 |               21 |
| short-192   | en     | room-proxy             |       24 |                  22 |             22 |               22 |
| short-192   | en     | music-equal-rms        |       24 |                  16 |             16 |               16 |
| short-192   | en     | speech-proxy-equal-rms |       24 |                  24 |             24 |               24 |
| short-192   | en     | echo-120ms             |       24 |                  24 |             24 |               24 |
| strict-384  | fr     | clean                  |        9 |                   7 |              7 |                7 |
| strict-384  | fr     | quiet-12db             |        9 |                   7 |              7 |                7 |
| strict-384  | fr     | quiet-24db             |        9 |                   5 |              5 |                5 |
| strict-384  | fr     | room-proxy             |        9 |                   6 |              6 |                6 |
| strict-384  | fr     | music-equal-rms        |        9 |                   1 |              1 |                1 |
| strict-384  | fr     | speech-proxy-equal-rms |        9 |                   9 |              9 |                9 |
| strict-384  | fr     | echo-120ms             |        9 |                   7 |              7 |                7 |
| strict-384  | en     | clean                  |       24 |                  22 |             22 |               22 |
| strict-384  | en     | quiet-12db             |       24 |                  21 |             21 |               21 |
| strict-384  | en     | quiet-24db             |       24 |                  20 |             20 |               20 |
| strict-384  | en     | room-proxy             |       24 |                  21 |             21 |               21 |
| strict-384  | en     | music-equal-rms        |       24 |                  12 |             12 |               12 |
| strict-384  | en     | speech-proxy-equal-rms |       24 |                  24 |             24 |               24 |
| strict-384  | en     | echo-120ms             |       24 |                  22 |             22 |               22 |

Les conditions avec fond parlé ou musical mesurent une conservation de fenêtre. Le fond peut expliquer toute la détection ; voir les témoins appariés. Aucun taux de reconnaissance du mot n’en est déduit.

## Flux continus : bruit, médias, épisodes et jobs

Six répétitions d’un même bruit sont six expositions, pas six enregistrements indépendants. Le rythme imposé (gap dans le nom) détermine les taux horaires. Les médias vocaux sont comptés à part, jamais automatiquement classés faux positifs. La fermeture logique après la fin du fichier ne rallonge pas le dénominateur.

| Variante    | Séquence                               | Route  | Secondes | Régions | Régions/h | Trace | Moment | Conversation | Jobs hors traces | Jobs traces | Tous jobs/h | Traces candidates à chaud |
| ----------- | -------------------------------------- | ------ | -------: | ------: | --------: | ----: | -----: | -----------: | ---------------: | ----------: | ----------: | ------------------------: |
| default-250 | timeline-fr-gap600-clean               | input  |    19.41 |       1 |    185.46 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| default-250 | timeline-fr-gap600-quiet-24db          | input  |    19.41 |       1 |    185.46 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| default-250 | timeline-fr-gap600-music-equal-rms     | input  |    19.41 |       1 |    185.46 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| default-250 | timeline-fr-gap55000-clean             | input  |   454.61 |       8 |     63.35 |     8 |      0 |            0 |                0 |           8 |       63.35 |                         8 |
| default-250 | timeline-fr-gap55000-quiet-24db        | input  |   454.61 |       8 |     63.35 |     8 |      0 |            0 |                0 |           8 |       63.35 |                         8 |
| default-250 | timeline-fr-gap55000-music-equal-rms   | input  |   454.61 |       1 |      7.92 |     1 |      0 |            0 |                0 |           1 |        7.92 |                         1 |
| default-250 | timeline-en-gap600-clean               | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| default-250 | timeline-en-gap600-quiet-24db          | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| default-250 | timeline-en-gap600-music-equal-rms     | input  |    43.80 |       2 |    164.38 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| default-250 | timeline-en-gap55000-clean             | input  |  1295.00 |      22 |     61.16 |    22 |      0 |            0 |                0 |          22 |       61.16 |                        22 |
| default-250 | timeline-en-gap55000-quiet-24db        | input  |  1295.00 |      22 |     61.16 |    22 |      0 |            0 |                0 |          22 |       61.16 |                        22 |
| default-250 | timeline-en-gap55000-music-equal-rms   | input  |  1295.00 |       3 |      8.34 |     3 |      0 |            0 |                0 |           3 |        8.34 |                         3 |
| default-250 | noise-door-2431-gap4000                | input  |    37.38 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | noise-door-2431-gap55000               | input  |   292.38 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | noise-cough-1657-gap4000               | input  |    35.00 |       5 |    514.35 |     0 |      1 |            0 |                1 |           0 |      102.87 |                         0 |
| default-250 | noise-cough-1657-gap55000              | input  |   290.00 |       5 |     62.07 |     5 |      0 |            0 |                0 |           5 |       62.07 |                         5 |
| default-250 | noise-keyboard-1726-gap4000            | input  |   147.91 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | noise-keyboard-1726-gap55000           | input  |   402.91 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | noise-dishes-1189-gap4000              | input  |   236.45 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | noise-dishes-1189-gap55000             | input  |   491.45 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | noise-notification-1112-gap4000        | input  |    83.56 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | noise-notification-1112-gap55000       | input  |   338.56 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | media-input-navy-marseillaise          | input  |    79.26 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | media-system-navy-marseillaise         | system |    79.26 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | media-input-happy-birthday             | input  |    95.62 |       3 |    112.95 |     0 |      1 |            0 |                1 |           0 |       37.65 |                         0 |
| default-250 | media-system-happy-birthday            | system |    95.62 |       3 |    112.95 |     0 |      1 |            0 |                1 |           0 |       37.65 |                         0 |
| default-250 | media-input-fleurs-fr-fr-validation-0  | input  |    14.46 |       1 |    248.96 |     0 |      1 |            0 |                1 |           0 |      248.96 |                         0 |
| default-250 | media-system-fleurs-fr-fr-validation-0 | system |    14.46 |       1 |    248.96 |     0 |      1 |            0 |                1 |           0 |      248.96 |                         0 |
| default-250 | media-input-fleurs-fr-fr-validation-1  | input  |     6.00 |       1 |    600.00 |     0 |      1 |            0 |                1 |           0 |      600.00 |                         0 |
| default-250 | media-system-fleurs-fr-fr-validation-1 | system |     6.00 |       1 |    600.00 |     0 |      1 |            0 |                1 |           0 |      600.00 |                         0 |
| default-250 | digital-silence                        | input  |    60.00 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| default-250 | synthetic-clicks                       | input  |    60.00 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | timeline-fr-gap600-clean               | input  |    19.41 |       1 |    185.46 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| short-128   | timeline-fr-gap600-quiet-24db          | input  |    19.41 |       1 |    185.46 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| short-128   | timeline-fr-gap600-music-equal-rms     | input  |    19.41 |       1 |    185.46 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| short-128   | timeline-fr-gap55000-clean             | input  |   454.61 |       9 |     71.27 |     9 |      0 |            0 |                0 |           9 |       71.27 |                         9 |
| short-128   | timeline-fr-gap55000-quiet-24db        | input  |   454.61 |       8 |     63.35 |     8 |      0 |            0 |                0 |           8 |       63.35 |                         8 |
| short-128   | timeline-fr-gap55000-music-equal-rms   | input  |   454.61 |       1 |      7.92 |     1 |      0 |            0 |                0 |           1 |        7.92 |                         1 |
| short-128   | timeline-en-gap600-clean               | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| short-128   | timeline-en-gap600-quiet-24db          | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| short-128   | timeline-en-gap600-music-equal-rms     | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| short-128   | timeline-en-gap55000-clean             | input  |  1295.00 |      22 |     61.16 |    22 |      0 |            0 |                0 |          22 |       61.16 |                        22 |
| short-128   | timeline-en-gap55000-quiet-24db        | input  |  1295.00 |      22 |     61.16 |    22 |      0 |            0 |                0 |          22 |       61.16 |                        22 |
| short-128   | timeline-en-gap55000-music-equal-rms   | input  |  1295.00 |       3 |      8.34 |     3 |      0 |            0 |                0 |           3 |        8.34 |                         3 |
| short-128   | noise-door-2431-gap4000                | input  |    37.38 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | noise-door-2431-gap55000               | input  |   292.38 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | noise-cough-1657-gap4000               | input  |    35.00 |       6 |    617.22 |     0 |      1 |            0 |                1 |           0 |      102.87 |                         0 |
| short-128   | noise-cough-1657-gap55000              | input  |   290.00 |       6 |     74.48 |     6 |      0 |            0 |                0 |           6 |       74.48 |                         6 |
| short-128   | noise-keyboard-1726-gap4000            | input  |   147.91 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | noise-keyboard-1726-gap55000           | input  |   402.91 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | noise-dishes-1189-gap4000              | input  |   236.45 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | noise-dishes-1189-gap55000             | input  |   491.45 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | noise-notification-1112-gap4000        | input  |    83.56 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | noise-notification-1112-gap55000       | input  |   338.56 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | media-input-navy-marseillaise          | input  |    79.26 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | media-system-navy-marseillaise         | system |    79.26 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | media-input-happy-birthday             | input  |    95.62 |       3 |    112.95 |     0 |      1 |            0 |                1 |           0 |       37.65 |                         0 |
| short-128   | media-system-happy-birthday            | system |    95.62 |       3 |    112.95 |     0 |      1 |            0 |                1 |           0 |       37.65 |                         0 |
| short-128   | media-input-fleurs-fr-fr-validation-0  | input  |    14.46 |       1 |    248.96 |     0 |      1 |            0 |                1 |           0 |      248.96 |                         0 |
| short-128   | media-system-fleurs-fr-fr-validation-0 | system |    14.46 |       1 |    248.96 |     0 |      1 |            0 |                1 |           0 |      248.96 |                         0 |
| short-128   | media-input-fleurs-fr-fr-validation-1  | input  |     6.00 |       1 |    600.00 |     0 |      1 |            0 |                1 |           0 |      600.00 |                         0 |
| short-128   | media-system-fleurs-fr-fr-validation-1 | system |     6.00 |       1 |    600.00 |     0 |      1 |            0 |                1 |           0 |      600.00 |                         0 |
| short-128   | digital-silence                        | input  |    60.00 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-128   | synthetic-clicks                       | input  |    60.00 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | timeline-fr-gap600-clean               | input  |    19.41 |       1 |    185.46 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| short-192   | timeline-fr-gap600-quiet-24db          | input  |    19.41 |       1 |    185.46 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| short-192   | timeline-fr-gap600-music-equal-rms     | input  |    19.41 |       1 |    185.46 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| short-192   | timeline-fr-gap55000-clean             | input  |   454.61 |       9 |     71.27 |     9 |      0 |            0 |                0 |           9 |       71.27 |                         9 |
| short-192   | timeline-fr-gap55000-quiet-24db        | input  |   454.61 |       8 |     63.35 |     8 |      0 |            0 |                0 |           8 |       63.35 |                         8 |
| short-192   | timeline-fr-gap55000-music-equal-rms   | input  |   454.61 |       1 |      7.92 |     1 |      0 |            0 |                0 |           1 |        7.92 |                         1 |
| short-192   | timeline-en-gap600-clean               | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| short-192   | timeline-en-gap600-quiet-24db          | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| short-192   | timeline-en-gap600-music-equal-rms     | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| short-192   | timeline-en-gap55000-clean             | input  |  1295.00 |      22 |     61.16 |    22 |      0 |            0 |                0 |          22 |       61.16 |                        22 |
| short-192   | timeline-en-gap55000-quiet-24db        | input  |  1295.00 |      22 |     61.16 |    22 |      0 |            0 |                0 |          22 |       61.16 |                        22 |
| short-192   | timeline-en-gap55000-music-equal-rms   | input  |  1295.00 |       3 |      8.34 |     3 |      0 |            0 |                0 |           3 |        8.34 |                         3 |
| short-192   | noise-door-2431-gap4000                | input  |    37.38 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | noise-door-2431-gap55000               | input  |   292.38 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | noise-cough-1657-gap4000               | input  |    35.00 |       6 |    617.22 |     0 |      1 |            0 |                1 |           0 |      102.87 |                         0 |
| short-192   | noise-cough-1657-gap55000              | input  |   290.00 |       6 |     74.48 |     6 |      0 |            0 |                0 |           6 |       74.48 |                         6 |
| short-192   | noise-keyboard-1726-gap4000            | input  |   147.91 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | noise-keyboard-1726-gap55000           | input  |   402.91 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | noise-dishes-1189-gap4000              | input  |   236.45 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | noise-dishes-1189-gap55000             | input  |   491.45 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | noise-notification-1112-gap4000        | input  |    83.56 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | noise-notification-1112-gap55000       | input  |   338.56 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | media-input-navy-marseillaise          | input  |    79.26 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | media-system-navy-marseillaise         | system |    79.26 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | media-input-happy-birthday             | input  |    95.62 |       3 |    112.95 |     0 |      1 |            0 |                1 |           0 |       37.65 |                         0 |
| short-192   | media-system-happy-birthday            | system |    95.62 |       3 |    112.95 |     0 |      1 |            0 |                1 |           0 |       37.65 |                         0 |
| short-192   | media-input-fleurs-fr-fr-validation-0  | input  |    14.46 |       1 |    248.96 |     0 |      1 |            0 |                1 |           0 |      248.96 |                         0 |
| short-192   | media-system-fleurs-fr-fr-validation-0 | system |    14.46 |       1 |    248.96 |     0 |      1 |            0 |                1 |           0 |      248.96 |                         0 |
| short-192   | media-input-fleurs-fr-fr-validation-1  | input  |     6.00 |       1 |    600.00 |     0 |      1 |            0 |                1 |           0 |      600.00 |                         0 |
| short-192   | media-system-fleurs-fr-fr-validation-1 | system |     6.00 |       1 |    600.00 |     0 |      1 |            0 |                1 |           0 |      600.00 |                         0 |
| short-192   | digital-silence                        | input  |    60.00 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| short-192   | synthetic-clicks                       | input  |    60.00 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | timeline-fr-gap600-clean               | input  |    19.41 |       2 |    370.92 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| strict-384  | timeline-fr-gap600-quiet-24db          | input  |    19.41 |       3 |    556.37 |     0 |      1 |            0 |                1 |           0 |      185.46 |                         0 |
| strict-384  | timeline-fr-gap600-music-equal-rms     | input  |    19.41 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | timeline-fr-gap55000-clean             | input  |   454.61 |       8 |     63.35 |     8 |      0 |            0 |                0 |           8 |       63.35 |                         8 |
| strict-384  | timeline-fr-gap55000-quiet-24db        | input  |   454.61 |       6 |     47.51 |     6 |      0 |            0 |                0 |           6 |       47.51 |                         6 |
| strict-384  | timeline-fr-gap55000-music-equal-rms   | input  |   454.61 |       1 |      7.92 |     1 |      0 |            0 |                0 |           1 |        7.92 |                         1 |
| strict-384  | timeline-en-gap600-clean               | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| strict-384  | timeline-en-gap600-quiet-24db          | input  |    43.80 |       4 |    328.77 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| strict-384  | timeline-en-gap600-music-equal-rms     | input  |    43.80 |       3 |    246.58 |     0 |      1 |            0 |                1 |           0 |       82.19 |                         0 |
| strict-384  | timeline-en-gap55000-clean             | input  |  1295.00 |      22 |     61.16 |    22 |      0 |            0 |                0 |          22 |       61.16 |                        22 |
| strict-384  | timeline-en-gap55000-quiet-24db        | input  |  1295.00 |      20 |     55.60 |    20 |      0 |            0 |                0 |          20 |       55.60 |                        20 |
| strict-384  | timeline-en-gap55000-music-equal-rms   | input  |  1295.00 |       1 |      2.78 |     1 |      0 |            0 |                0 |           1 |        2.78 |                         1 |
| strict-384  | noise-door-2431-gap4000                | input  |    37.38 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | noise-door-2431-gap55000               | input  |   292.38 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | noise-cough-1657-gap4000               | input  |    35.00 |       4 |    411.48 |     0 |      1 |            0 |                1 |           0 |      102.87 |                         0 |
| strict-384  | noise-cough-1657-gap55000              | input  |   290.00 |       4 |     49.66 |     4 |      0 |            0 |                0 |           4 |       49.66 |                         4 |
| strict-384  | noise-keyboard-1726-gap4000            | input  |   147.91 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | noise-keyboard-1726-gap55000           | input  |   402.91 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | noise-dishes-1189-gap4000              | input  |   236.45 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | noise-dishes-1189-gap55000             | input  |   491.45 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | noise-notification-1112-gap4000        | input  |    83.56 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | noise-notification-1112-gap55000       | input  |   338.56 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | media-input-navy-marseillaise          | input  |    79.26 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | media-system-navy-marseillaise         | system |    79.26 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | media-input-happy-birthday             | input  |    95.62 |       2 |     75.30 |     0 |      2 |            0 |                2 |           0 |       75.30 |                         0 |
| strict-384  | media-system-happy-birthday            | system |    95.62 |       2 |     75.30 |     0 |      1 |            0 |                1 |           0 |       37.65 |                         0 |
| strict-384  | media-input-fleurs-fr-fr-validation-0  | input  |    14.46 |       1 |    248.96 |     0 |      1 |            0 |                1 |           0 |      248.96 |                         0 |
| strict-384  | media-system-fleurs-fr-fr-validation-0 | system |    14.46 |       1 |    248.96 |     0 |      1 |            0 |                1 |           0 |      248.96 |                         0 |
| strict-384  | media-input-fleurs-fr-fr-validation-1  | input  |     6.00 |       1 |    600.00 |     0 |      1 |            0 |                1 |           0 |      600.00 |                         0 |
| strict-384  | media-system-fleurs-fr-fr-validation-1 | system |     6.00 |       1 |    600.00 |     0 |      1 |            0 |                1 |           0 |      600.00 |                         0 |
| strict-384  | digital-silence                        | input  |    60.00 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |
| strict-384  | synthetic-clicks                       | input  |    60.00 |       0 |      0.00 |     0 |      0 |            0 |                0 |           0 |        0.00 |                         0 |

## Témoins de fond appariés

| Variante    | Condition              | Fenêtres cibles | Gardées avec cible | Gardées sans cible | Nouvellement gardées |
| ----------- | ---------------------- | --------------: | -----------------: | -----------------: | -------------------: |
| default-250 | music-equal-rms        |              33 |                 18 |                  0 |                   18 |
| default-250 | speech-proxy-equal-rms |              33 |                 33 |                 33 |                    0 |
| short-128   | music-equal-rms        |              33 |                 23 |                  0 |                   23 |
| short-128   | speech-proxy-equal-rms |              33 |                 33 |                 33 |                    0 |
| short-192   | music-equal-rms        |              33 |                 20 |                  0 |                   20 |
| short-192   | speech-proxy-equal-rms |              33 |                 33 |                 33 |                    0 |
| strict-384  | music-equal-rms        |              33 |                 13 |                  0 |                   13 |
| strict-384  | speech-proxy-equal-rms |              33 |                 33 |                 33 |                    0 |

## Coût du mode fichier

Nombre de processus helper : 1332. Pic RSS maximal : 46.78 MiB. Temps CPU helper total : 76.23 s. Temps mur total des invocations : 148.55 s.

Ces mesures incluent des chargements répétés de Silero en mode fichier. Elles ne mesurent ni le budget always-on, ni Nemotron, ni une régression de fluidité du Mac. Les états système avant/après et les temps individuels sont dans results.json.

## Seuils expérimentaux — non appliqués

La seule variable du helper est minSpeechMs : 250 (défaut), 128, 192 et 384 ms. Les tableaux montrent leurs effets mesurés sur les mêmes signaux. Baisser ce seuil vise à conserver davantage de petites rafales ; le coût en bruit et jobs doit être lu dans la même variante. Le durcir vise à réduire ces rafales au risque de perdre les mots courts. Ce corpus diagnostique ne suffit pas à choisir un seuil produit.

## Limites

- Diagnostic public corpus, not a representative field false-positive rate.
- Clip labels are not word timing annotations; strict 100–600 ms recall remains unmeasured.
- Transcription jobs are real planner/DB inserts in memory. No ASR, transcript, diarization, warm scheduling or hardware capture is run.
- No call attribution is inferred from file audio. Current grouping version is recorded.
- Peak process RSS is not physical footprint or proof of Mac responsiveness.
- Normal speech is attenuated/filter-transformed; real whispers, distant speech and actual television remain uncovered.

- Source labels, not independently listened gold; non-speech sound descriptions may omit background speech.
- French acoustic boundaries are provisional external review only; no validated 100–600 ms timing set.
- FLEURS read speech is a media-speech proxy, not a television corpus.
- CC BY-SA recordings and derived mixtures keep their source licences in the external cache. No audio or transcript is included in this patch.

## Sources et licences

- fr-oui-vion : [source](https://commons.wikimedia.org/wiki/File:Fr-oui.ogg), [licence CC BY 2.0 fr](https://creativecommons.org/licenses/by/2.0/fr/deed.en). Vion Nicolas. SHA-256 9e9ee7eab5ea47df02fdc9a96ff1f4c509b2c1913bc7eaaecb40567f7be3b7c2.
- fr-non-vion : [source](https://commons.wikimedia.org/wiki/File:Fr-non.ogg), [licence CC BY 2.0 fr](https://creativecommons.org/licenses/by/2.0/fr/deed.en). Vion Nicolas. SHA-256 bf5a9ef83cabb95e220e9cfcb137e8a62a22d4449f85672a620f1c7f589548e6.
- door-2431 : [source](https://lasonotheque.org/porte-fermeture-1-s2431.html), [licence CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Joseph SARDIN / LaSonothèque (BigSoundBank). SHA-256 30e36537f43f5a95911fd5c24fb125410b8fce717cfe3de06ad3df0e04f6019a.
- cough-1657 : [source](https://lasonotheque.org/toux-d-homme-2-s1657.html), [licence CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Joseph SARDIN / LaSonothèque (BigSoundBank). SHA-256 5b1d34ab151147b1ce37a005cf5487f3f6faad84e4b0cb0645c70e3f776aa4f5.
- keyboard-1726 : [source](https://bigsoundbank.com/slow-macbook-keyboard-1-s1726.html), [licence CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Joseph SARDIN / LaSonothèque (BigSoundBank). SHA-256 fb32d03fab84d97c7d8f4cc5784659079a041afd3b8a9013b611ce95848260fa.
- dishes-1189 : [source](https://bigsoundbank.com/large-plate-set-on-table-s1189.html), [licence CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Joseph SARDIN / LaSonothèque (BigSoundBank). SHA-256 3ac3496c1f18e42868e555f44a7915dc2e21b896fb99971e7bef9e69e8945470.
- notification-1112 : [source](https://lasonotheque.org/message-2-s1112.html), [licence CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Joseph SARDIN / LaSonothèque (BigSoundBank). SHA-256 c664c0d01e9d434eed6e1a2af507656998edc00400d98ea2513231b17746ccc8.
- fr-oui-grandcelinien : [source](<https://commons.wikimedia.org/wiki/File:LL-Q150_(fra)-GrandCelinien-oui.wav>), [licence CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0). Speaker: GrandCelinien; Recorder: GrandCelinien. SHA-256 dfd1dc4b338341933cac7a4c6f8c05336b2766d43983d379115018030e37c610.
- fr-non-grandcelinien : [source](<https://commons.wikimedia.org/wiki/File:LL-Q150_(fra)-GrandCelinien-non.wav>), [licence CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0). Speaker: GrandCelinien; Recorder: GrandCelinien. SHA-256 cbe51cbebaca5626de90c1736db212437bf486f686d388c166425ee2a630400a.
- fr-oui-poslovitch : [source](<https://commons.wikimedia.org/wiki/File:LL-Q150_(fra)-Poslovitch-oui.wav>), [licence CC0](http://creativecommons.org/publicdomain/zero/1.0/deed.en). Speaker: Poslovitch; Recorder: Poslovitch. SHA-256 da08fc55d6e92ba150ac6e028912477be0caeadb96e89320ffa21cf9d4f21362.
- fr-non-poslovitch : [source](<https://commons.wikimedia.org/wiki/File:LL-Q150_(fra)-Poslovitch-non.wav>), [licence CC0](http://creativecommons.org/publicdomain/zero/1.0/deed.en). Speaker: Poslovitch; Recorder: Poslovitch. SHA-256 51fd32835e3ef2f8b88d6df4a9f696457596f67ed9a39edcad98045f7e8079a9.
- fr-oui-lunemarine : [source](<https://commons.wikimedia.org/wiki/File:LL-Q150_(fra)-LuneMarine_(DSwissK)-oui.wav>), [licence CC BY 4.0](https://creativecommons.org/licenses/by/4.0). Speaker: LuneMarine; Recorder: DSwissK. SHA-256 0dae4b84e4b109cb75dc442e171e623b4748d8dcde98fe07f4d7d06a59b684a1.
- fr-non-lunemarine : [source](<https://commons.wikimedia.org/wiki/File:LL-Q150_(fra)-LuneMarine_(DSwissK)-non.wav>), [licence CC BY 4.0](https://creativecommons.org/licenses/by/4.0). Speaker: LuneMarine; Recorder: DSwissK. SHA-256 d0904431804e1ff15b23231a861fc05ed2ce8d64326e0f9444410962dac9660a.
- fr-hum-loquaxfr : [source](<https://commons.wikimedia.org/wiki/File:LL-Q150_(fra)-LoquaxFR-hum.wav>), [licence CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0). Speaker: LoquaxFR; Recorder: LoquaxFR. SHA-256 d32f1abf6ec08b04b45e0742ee8b40e256a880dcbdaf551adb25aea53fb5e392.
- speech-commands-v002-yes-022cd682-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 b2a08b7b932afa26b95002c80ed940cc348f4a604162fa4553a35397c2983c9d.
- speech-commands-v002-yes-03401e93-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 5f805478d7cc5099b45d9e86ee278b6537d65ce124abf31ffc6e61944a711b2b.
- speech-commands-v002-yes-0bac8a71-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 b256c643cdb96a8193b9403ce5e3682ec20f54be4d798d79658fa1922e56fcc5.
- speech-commands-v002-yes-0cb74144-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 4392de990dd083d016aa45d80027fab85998a5e647173dd7326d66963396c2d9.
- speech-commands-v002-yes-0ea0e2f4-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 a1b074417eb73028ad8cf7608fbc0ccfdb09dce14c6cdbdd42289fd9d8c4e540.
- speech-commands-v002-yes-0fa1e7a9-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 1f8e3a9c8e7b803b03bc8063678f81df0aceef3c97eef696fa3a6ec8df078059.
- speech-commands-v002-yes-105a0eea-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 6ea7cf4c38cae3410e5284a4cc4bad96d7bc1bb8fd283f7c9be5ed3d09e36c49.
- speech-commands-v002-yes-1093c8e7-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 06e91017e9b3c2e22e689cf6ca49e2db9fa7260271fd6dcf32379f21a10e4ce9.
- speech-commands-v002-yes-1538beb7-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 d37d76ee5155aaec2b459951ffb2f4091f77daf7c215077c3e4368b87af1a3d0.
- speech-commands-v002-yes-189cbabe-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 72f210badafdbdd0e9d689fac5d6be4b108218aa284cb4f873ff98982b20c146.
- speech-commands-v002-yes-18f8afd5-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 6797d4f6ae6d7ed2809fc47f8da1fbcccb9361f5f2ec00e66c0f82b6b0cc2363.
- speech-commands-v002-yes-1acc97de-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 610dfc839174ddfba84838ba5eea2498663d7b546f144345d7eb51770b4b8c95.
- speech-commands-v002-no-03401e93-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 b3da9ec4a4b6f28e08ac5720fa56066a06a5acb1daf61a9b99c8abc5c8ce4629.
- speech-commands-v002-no-0c40e715-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 994a3b5a11a2b8c4f2fdbe59468b840dabcddc653116f555ed9ff39388269bad.
- speech-commands-v002-no-0c540988-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 a3a507ab136556c09a40bfbeafb9bdd0f68f49074fc83b88b570a9f6f9388763.
- speech-commands-v002-no-0cb74144-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 ded1c0fd417dd68b61b1f27ed2a4c03a349507e730b257b2381aeb90c59b5083.
- speech-commands-v002-no-0ea0e2f4-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 8b32ac6128039868b7f030850174f489cb220ced82ee9c155aca88f7ec7a667c.
- speech-commands-v002-no-1093c8e7-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 bdd05f73da9c74fd6ff21e5f07fc17fd7a99ba240c7d9b28b84dd06a078288cc.
- speech-commands-v002-no-135c6841-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 7cb3053a01cf84e6d9a2acc74ab17d642e2d0c6d87ee5670c4c6f3a614a817c2.
- speech-commands-v002-no-189cbabe-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 7fbcf5e3ae49fe92ae23f7aa43b46c91ad42b813c6edb14c777bf3dbbe8cf0e0.
- speech-commands-v002-no-18f8afd5-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 c27038ea4ccf18a960dec3838f1d7b4781f65f06432bbd572d33b3141afb37d5.
- speech-commands-v002-no-1acc97de-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 36d24ce7b9b9ae1f4860a9fd5ee4ec0dc500a6ad1f9cf2c591e9d5d06cee88f1.
- speech-commands-v002-no-1b4c9b89-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 4449e10157b9a6396bb7f6edc2adb7586d718145c2fec388205f02956daa8414.
- speech-commands-v002-no-1cb788bc-nohash-0 : [source](https://research.google/blog/launching-the-speech-commands-dataset/), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Speech Commands test set v0.02, Pete Warden / Google and contributing speakers, CC BY 4.0.. SHA-256 b79af7f169c7c0e3d302e4bfd459e38807d5a3c3c61c23c7b22596836d3421a2.
- navy-marseillaise : [source](https://commons.wikimedia.org/wiki/File:La_Marseillaise.ogg), [licence Public domain (US Navy performance; public-domain composition)](https://creativecommons.org/publicdomain/mark/1.0/). La Marseillaise, Claude Joseph Rouget de Lisle; performance by United States Navy Band, circa 1987; Wikimedia Commons recording.. SHA-256 2031c4835ddae2a9e1d718bf54c1a3222038f651555104cd264c7f5927b0523c.
- happy-birthday : [source](https://commons.wikimedia.org/wiki/File:Happy_birthday.ogg), [licence CC-BY-SA-3.0](https://creativecommons.org/licenses/by-sa/3.0/). Happy birthday, sung by Alexander Stephens, produced and arranged by Hanns Christian Müller for mylingo; uploaded by Sselmer, 13 June 2011, Wikimedia Commons, CC BY-SA 3.0.. SHA-256 cab7fd6f022110111a5e35caf9b86a265d7c98a30b7aa0ad6fa2b78957c76866.
- fleurs-fr-fr-validation-0 : [source](https://huggingface.co/datasets/google/fleurs), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). FLEURS, Alexis Conneau et al., Google, 2022. SHA-256 8bb53b14f4cc695c54a136a5db57e534344a225d81a6b5314ca6cdb0a12c7005.
- fleurs-fr-fr-validation-1 : [source](https://huggingface.co/datasets/google/fleurs), [licence CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). FLEURS, Alexis Conneau et al., Google, 2022. SHA-256 a9f2f1630034aae5bbe5273a25166d9ed1e92bedf4d613c7398fbda92b65ed12.
