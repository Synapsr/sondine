# 040 — Calcul hors du Mac : notre cloud ou le vôtre

Statut : **Accepted — 2026-11-24** pour « Votre machine » et la bêta (accord de Téo : « tu peux coder »), construites le même jour ([ce qui est construit](../cloud/engine-and-protocol.md)) ; la bêta est joignable depuis le 2026-11-25 (`CLOUD_BETA`), limitée à cinq places, que la 0.7.0 laisse prendre à qui choisit le cloud, tant que la liste de ceux qui administrent la machine n'est pas réduite. **Proposed** pour le cloud confidentiel. Brouillon de Gemini 4 Neon, critiqué par Codex Astra, complété et construit par Claude Opus 5.5.
Amende : [ADR 002](002-local-only.md) (local only), [ADR 005](005-swappable-engines.md) (localité des moteurs), [ADR 010](010-build-signing-hardening.md) (durcissement réseau), [ADR 016](016-transcription-pipeline.md) (admission, traces et files), [ADR 029](029-private-zones.md) (zones privées et sortie distante), [ADR 037](037-ux-redesign.md) (carte cloud), `AGENTS.md` (priorité 1) et `docs/product-vision.md`.

Documents associés de cette proposition :

- Modèle de menace et comparaison des mécanismes de confidentialité : [`docs/cloud/threat-model.md`](../cloud/threat-model.md)
- Contrat moteur (`packages/engines`), protocole binaire (`packages/protocol`), option « votre machine » et résilience : [`docs/cloud/engine-and-protocol.md`](../cloud/engine-and-protocol.md)
- Documentation utilisateur, opérateur, confidentialité `sondine.app` et estimations GPU (FR et EN) : [`docs/cloud/fr/`](../cloud/fr/) et [`docs/cloud/en/`](../cloud/en/)

## Contexte

Citation de Téo (2026-11-24) :

> « Préparer la possibilité d'utiliser un cloud, que ce soit notre cloud, ou alors, si quelqu'un a une machine, d'utiliser son cloud en ligne avec le modèle et toute la documentation, rédigée par Gemini NEON 4. Dans le but de ne pas limiter aux gens qui ont des grosses machines. Et de bien réfléchir à la partie privacy pour faire en sorte que les données ne soient pas accessibles par notre cloud aussi. Que ce soit chiffré ou d'une autre manière plus intelligente, je ne sais pas encore comment. »

Aujourd'hui, le catalogue de modèles (`packages/engines/src/models/catalog.ts`) donne la mémoire que chaque modèle demande (en dessous, Sondine prévient sans empêcher) :

| Rôle                                                       | Modèle par défaut                        | Poids disque | Mémoire minimale (`catalog.ts`) | Pic mesuré sur M5 32 Go | Licence     |
| ---------------------------------------------------------- | ---------------------------------------- | ------------ | ------------------------------- | ----------------------- | ----------- |
| Texte en direct (`live`, ADR 019) et dictées (ADR 020)     | Parakeet TDT 0.6B v3 (F16)               | 1,25 Go      | 8 Go                            | ~1,3 Go                 | CC-BY-4.0   |
| Transcription finale + diarisation (`final`, ADR 016, 018) | Nemotron 3.5 Transcribe 30B-A4B (IQ4_NL) | 19,0 Go      | 32 Go                           | 17,1–19 Go              | OpenMDW-1.1 |
| Journal du jour et engagements (`journal`, ADR 028)        | Qwen3.5 9B (Q4_K_M)                      | 5,68 Go      | 16 Go _(32 avant cet ADR)_      | 6,1–6,3 Go              | Apache-2.0  |

Les autres étapes restent légères et tournent localement sur un Mac Apple Silicon (8 Go ou 16 Go) : capture et VAD Silero v6.2 (`sondine-audio`, ~38 MiB), empreintes vocales WeSpeaker ResNet34-LM sur Core ML (`sondine-voice`), corrélation d'écho (`envelope-echo/1`, `echo/4`), indexation FTS5 et recherche.

Un Mac de moins de 32 Go n'a donc pas la transcription finale Nemotron (impossible physiquement sur 8/16 Go). Le journal local Qwen, 6,3 Go au pic, s'y télécharge dès 16 Go (Téo, 2026-11-25) ; il n'a été mesuré que sur 32 Go, et l'admission (pression mémoire, place pour le swap) le fait attendre quand le Mac n'a pas la place. L'[ADR 037](037-ux-redesign.md) a introduit une carte d'intention (« Prévu : une transcription dans le cloud, conçue pour ne rien garder ») et `apps/cloud-waitlist` (`sondine.app/cloud`) recueille des adresses e-mail dans le navigateur sans appel réseau depuis l'application. Comme l'exige ADR 037, ouvrir un calcul hors du Mac demande une décision dédiée qui amende explicitement ADR 002, `AGENTS.md` et `docs/product-vision.md`.

Les deux licences vérifiées dans `packages/engines/src/models/license-texts.ts` — Nemotron (OpenMDW-1.1) et Qwen3.5 9B (Apache-2.0) — autorisent l'hébergement commercial et l'auto-hébergement sans restriction de domaine ni de revenus, en conservant les notices en cas de redistribution.

## Décision

Sondine reste **local par défaut**. Le calcul hors du Mac est une capacité strictement **opt-in** qui délègue uniquement les étapes d'inférence lourdes à un serveur open source identique (`sondine-compute`, AGPL-3.0) exécuté au choix :

1. **Sur une machine de l'utilisateur (« Votre machine »)** : un autre Mac Apple Silicon ≥ 32 Go sur le réseau local ou via Tailscale, ou un PC / serveur / VM Linux (image Docker NVIDIA).
2. **Sur le cloud Sondine opéré par Synapsr (« Cloud Sondine »)**, en deux temps :
   - **Bêta** _(choix de Téo, 2026-11-24)_ : le même `sondine-compute` sur un serveur ordinaire de Synapsr, gratuit, pour les 10 premières personnes qui le choisissent, **en un clic**, sans compte ni Tailscale (l'avertissement est dans l'app). Sans attestation : les administrateurs peuvent techniquement accéder aux données, l'app le dit et s'engage sur l'honneur à ne pas les lire.
   - **Cloud confidentiel**, proposé comme condition de l'ouverture publique payante : exécuté dans un environnement d'exécution confidentiel (TEE) matériellement attesté, sans stockage applicatif persistant, derrière un relais OHTTP indépendant et financé par des jetons anonymes Privacy Pass (RSA Blind Signatures).

Les deux destinations sont proposées **ensemble**, dès la première version. Seule la **transcription finale** est déportée en v1 ; le journal ne l'est pas. Dans la suite, « Cloud Sondine » sans précision désigne le cloud confidentiel.

Tous les modes parlent **le même protocole binaire** (`packages/protocol`) et s'intègrent derrière **le contrat moteur** (`packages/engines`, ADR 005), avec des évolutions ciblées et explicites du planificateur ASR et du coordinateur de suppression (détaillées dans [`docs/cloud/engine-and-protocol.md`](../cloud/engine-and-protocol.md)).

### 1. Opt-in strict

- **Désactivé par défaut.** Tant que l'utilisateur n'active pas le calcul distant, aucune donnée n'est envoyée à un serveur de calcul distant (les autres options opt-in existantes — téléchargement de modèles, mises à jour, synchro iPhone ADR 008, agents/Claude ADR 027/028 — gardent leurs propres interrupteurs indépendants).
- **Un réglage, dans _Réglages ▸ Calcul_** : la transcription finale se fait sur _Ce Mac_ (défaut) | _Votre machine_ | _Cloud Sondine_. Le cloud bêta et le cloud confidentiel sont deux destinations avec deux accords séparés, sans repli de l'une vers l'autre.
- **Étapes jamais déportées** :
  - Journal du jour et engagements : sur le Mac, ou chez Claude si l'utilisateur l'a choisi (ADR 028).
  - Capture audio, VAD Silero, spool et archive (`sondine-audio`, zéro droit réseau).
  - Texte en direct (`live`) et dictées (`dictation`) sur Parakeet 0.6B (1,25 Go, dès 8 Go).
  - Extraction des empreintes vocales WeSpeaker (`sondine-voice`), comparaison, suggestions (« Marie ? ») et liaison d'identité (ADR 012, 030).
  - Détection d'écho (`envelope-echo/1`, `echo/4`), détection de même moment iPhone/Mac (`envelope-xcorr/1`, ADR 032), regroupement en épisodes, indexation FTS5 et recherche.
- **Dialogue de consentement avant activation.** Comme pour ADR 027 et ADR 028, activer un mode distant ouvre une boîte de dialogue qui précise : exactement ce qui quitte le Mac (y compris les voix et les noms prononcés dans les conversations, y compris ceux de tiers — ADR 012), vers quelle destination, les limites de confidentialité du mode choisi, et le fait que des octets déjà transmis ne peuvent être rappelés par le client.
- **Contrôle de configuration interdit aux agents MCP et à l'iPhone.** Aucune procédure MCP (`mcp: null`) ni route iPhone ne peut activer le calcul distant, modifier sa destination ou forcer un envoi manuel. _Précision :_ un enregistrement iPhone importé sur le Mac (ADR 032) crée un épisode `in_person` dont la transcription automatique suit la politique configurée sur le Mac (et déclenche donc indirectement un envoi distant si l'utilisateur a choisi un moteur distant sur son Mac).
- **Retour au local et annulation immédiate.** Repasser sur _Ce Mac_, couper le serveur distant ou supprimer un épisode déclenche l'annulation immédiate des requêtes distantes concernées via un raccordement explicite au service de file (`cancelEpisode` / `cancelAllRemote`), bloque tout nouvel envoi de morceau, et interdit toute publication tardive en base.

### 2. Frontière exacte des données : ce qui sort et ce qui ne sort jamais

| Donnée                                                                                                 | Sort pour `final-asr` ?         | Détail exact et limites honnêtes                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tranches audio planifiées d'un épisode clos (16 kHz mono FLAC sans perte)                              | **Oui** (chiffré E2E)           | Les `extents` produits par `planRequests` (`requests.ts`) : régions de parole élargies de 1,5 s pré-roll / 0,8 s post-roll et fusionnées quand l'écart est inférieur au seuil de regroupement, après retrait des `deleted_ranges` et des zones interdites. **Contient les voix réelles des participants** (dont des traits acoustiques identifiables pourraient être extraits par un serveur compromis). Jamais le spool brut, max 55 min / requête. |
| **Textes déjà sur le Mac, journal, engagements**                                                       | **JAMAIS**                      | Aucun texte du Mac n'est envoyé ; le serveur produit toutefois la transcription de l'audio reçu, et l'efface après la réponse. Le journal n'est pas déporté en v1 (sauf choix de Claude, ADR 028).                                                                                                                                                                                                                                                   |
| Paramètres techniques (`modelId`, langue optionnelle, `speakers`, `timestamps`)                        | **Oui** (chiffré E2E)           | Aucun identifiant d'épisode SQLite, aucun chemin local, aucun nom d'appareil.                                                                                                                                                                                                                                                                                                                                                                        |
| **Empreintes vocales stockées (WeSpeaker), exemplaires vocaux, lecture de voix (ADR 012, 030, 034)**   | **JAMAIS**                      | Données biométriques (RGPD art. 9) calculées et conservées uniquement sur le Mac après réception du texte.                                                                                                                                                                                                                                                                                                                                           |
| **Carnet « Personnes », noms associés aux voix sur le Mac, liens d'identité**                          | **JAMAIS**                      | Le serveur ne renvoie que des indices locaux `0, 1, 2…`.                                                                                                                                                                                                                                                                                                                                                                                             |
| **Base SQLite, index FTS5, historique de recherche, statistiques**                                     | **JAMAIS**                      | Restent dans le conteneur local du Mac (ADR 013).                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Contexte ajouté (notes, liens, images, PDF — ADR 024)**                                              | **JAMAIS**                      | Jamais inclus dans les requêtes.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Zones privées, règles « Ne pas identifier », applications frontales (ADR 022), pages web (ADR 023)** | **JAMAIS**                      | Évalués localement sur le Mac avant planification.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Audio supprimé ou oublié (« Oublier les N dernières minutes »)**                                     | **JAMAIS**                      | `subtractDeleted` excise les plages avant lecture. Une suppression en cours de vol annule la requête et bloque toute publication.                                                                                                                                                                                                                                                                                                                    |
| **Compte client / facturation (mode Cloud Sondine)**                                                   | **JAMAIS** au serveur de calcul | Dissociés cryptographiquement par jetons Privacy Pass (RSA Blind Signatures) ; l'IP est masquée au serveur de calcul par le relais OHTTP tiers. _(En bêta, Cloudflare voit l'IP, et le serveur le jeton de la place et l'IP transmise.)_                                                                                                                                                                                                             |

**Règle sur les zones privées (amendement explicite à ADR 029) :**

- En traitement **automatique** : une zone « Rien » ne capture rien ; une zone « Audio uniquement » ne transcrit rien (donc aucun envoi distant) ; une zone « Texte uniquement » autorise la transcription (et donc le calcul distant si l'utilisateur l'a activé).
- **Construit (2026-11-24) :** plus simple et plus strict que la règle suivante : un serveur ne reçoit jamais un épisode d'une zone qui ne garde pas de texte, même demandé ; l'app le dit.
- Sur geste explicite **« Transcrire maintenant »** pour un épisode couvert par une zone « Audio uniquement » (autorisé par ADR 029 en local) : si le moteur actif est distant, Sondine **demande une confirmation explicite** avant tout envoi réseau (« Cet enregistrement appartient à une zone privée. L'envoyer quand même à [destination] ? »).
- **Exception iPhone (ADR 032)** : les enregistrements iPhone ne sont pas soumis aux zones privées du Mac (`privacy-policy.ts`). Ils suivent la politique de calcul choisie sur le Mac ; cela est rappelé dans le dialogue d'activation du mode distant.
- Une règle dédiée de zone **« Calcul local uniquement »** (autorisant la transcription locale mais interdisant l'envoi distant) est prévue dans l'amendement à ADR 029 en passe 2.

**Règle sur les traces (< 1,5 s, ADR 016) :** comme sur le Mac, elles suivent un autre travail et ne font jamais charger le modèle pour elles : le serveur les reçoit après tout le reste, dans les 90 s qui suivent une transcription, 50 au plus à la fois (Téo, 2026-11-25 : « tout devrait passer par le cloud » ; la règle d'avant ne les envoyait jamais d'elles-mêmes). Dès que 30 attendent, elles partent toutes d'un coup, sans conversation (Téo, le même jour). « Transcrire maintenant » les envoie tout de suite. Les dictées restent sur le Mac (Parakeet : « elles n'ont pas vraiment besoin du cloud ») et, quand un serveur fait le reste, n'attendent ni secteur ni inactivité, seulement la chaleur et la mémoire : 0,7 s de calcul et 1,5 s de chargement en moyenne pour 35 s de dictée (241 dictées en 14 jours, 1,6 Go au pic) ; l'app dit séparément ce que le serveur et les dictées attendent.

### 3. Architecture de confidentialité

**Bêta.** Chiffrement jusqu'au programme, aucun archivage par le programme, aucun journal de contenu, swap de l'hôte désactivé. Aucun des serveurs relevés ne fournit la chaîne CPU + GPU confidentielle du cloud confidentiel : la confidentialité vis-à-vis de Synapsr n'y est **pas** assurée, donc jamais annoncée ([modèle de menace](../cloud/threat-model.md) §4.7).

**Cloud confidentiel.**

Le détail complet des adversaires, de la comparaison des six approches et des limites résiduelles figure dans [`docs/cloud/threat-model.md`](../cloud/threat-model.md). En résumé, le Cloud Sondine combine quatre couches vérifiables. Elles protègent contre Synapsr, l'hyperviseur et le réseau. Elles ne protègent **pas** contre un attaquant qui a un accès physique au serveur (TEE.fail, HBM du H100), et sur Azure elles supposent de faire confiance au paravisor de Microsoft :

1. **TEE matériel attesté CPU + GPU** : VM confidentielle **AMD SEV-SNP** ou **Intel TDX** (RAM CPU chiffrée et protégée contre l'hyperviseur) couplée à un GPU **NVIDIA Confidential Computing** (H100/H200/B200 en mode `cc_mode=ON` : transferts CPU ↔ GPU chiffrés sur PCIe via SPDM/bounce buffers et mémoire GPU HBM protégée par isolation matérielle — _note honnête :_ sur H100, la HBM embarquée est isolée matériellement mais **non chiffrée** ; voir modèle de menace §4.2). Aucun stockage applicatif persistant, aucun SSH, aucun shell interactif. Le processus frontal qui détient la clé d'attestation est isolé du processus d'inférence GPU.
2. **Politique d'autorisation signée + journal de transparence + preuve de révocation** : une simple entrée dans Sigstore Rekor rend une image observable, mais ne suffit pas à l'autoriser contre un adversaire interne contrôlant la CI (A1). Le Mac vérifie donc ces **conditions cumulatives** avant tout chiffrement :
   - signatures matérielles CPU (AMD VCEK / Intel PCK) et GPU (NVIDIA RIM) valides avec **preuves OCSP/CRL et TCB datées et non expirées** (≤ 24 h) ;
   - correspondance exacte de la mesure logicielle avec une **politique d'autorisation signée par quorum** (ex. 2-sur-3 clés matérielles de mainteneurs, avec numéro de version monotone anti-retour `policyVersion` et TTL court fichier statique servi par le relais), qui porte aussi la configuration de clé OHTTP et les clés Privacy Pass, identiques pour tous ;
   - preuve d'inclusion Merkle dans **Sigstore Rekor** avec checkpoint signé par témoins indépendants, liant la mesure à une build open source reproductible publique ;
   - fraîcheur (nonce client de 32 octets lié dans la preuve CPU et dans l'évidence GPU), selon le profil de l'hébergeur : `direct` (`report_data`) ou `azure-vtpm` (quote vTPM et paravisor mesuré) ;
   - plateforme admise (`allowedPlatforms`), lorsque l'hébergeur fournit des identifiants stables.
3. **Chiffrement E2E par session (HPKE + forward secrecy par session)** : le premier échange (`SESSION_OPEN`, ne contenant aucun audio) utilise HPKE (RFC 9180) vers la clé publique attestée de l'enclave (rotation courte ≤ 6 h) pour négocier des clés symétriques bilatérales de session (`K_c2s`, `K_s2c`, X25519 éphémère client + enclave) qui chiffrent les tranches audio/texte et les réponses, avec compteurs monotones par direction et effacement (`zeroize`) immédiat en fin de session.
4. **Séparation des métadonnées par OHTTP + Privacy Pass (RSA Blind Signatures)** :
   - **Relais OHTTP indépendant** (entité juridique distincte de Synapsr) : masque l'IP client au serveur de calcul. Le relais voit l'IP, les horaires et volumes chiffrés, jamais le contenu ni le compte.
   - **Jetons Privacy Pass publiquement vérifiables (RFC 9578 type `0x0002`, RSA Blind Signatures)** : dissocient facturation et requêtes. Un registre anti-double-dépense minimal et partagé entre enclaves (contenant uniquement `H(nullifier)` + époque, sans contenu ni IP) empêche la double dépense entre nœuds et à travers les redémarrages, avec réservation/validation et remboursement aveugle ou réessai idempotent en cas d'échec serveur ou de découpage `model_limit`.

### 4. Option « Votre machine » (`sondine-compute`)

Le même serveur open source (`sondine-compute`, AGPL-3.0) est livré pour deux usages documentés dans [`docs/cloud/engine-and-protocol.md`](../cloud/engine-and-protocol.md) et [`docs/cloud/fr/utiliser-votre-propre-serveur.md`](../cloud/fr/utiliser-votre-propre-serveur.md) :

1. **Autre Mac Apple Silicon (≥ 32 Go)** (LAN ou Tailscale) :
   - Réutilise l'appairage d'[ADR 008](008-mobile-lan-sync.md) : QR/lien à usage unique (5 min), 6 chiffres de contrôle, TLS 1.3 épinglé (SPKI SHA-256), Bonjour (`_sondine-compute._tcp`) sur LAN, repli optionnel Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, appairage initial sur LAN uniquement).
   - **Chiffrement E2E HPKE + clés de session toujours actif**, même sur LAN et Tailscale.
   - **Absence de conflit avec Sondine.app** : en mode intégré (« Partager ce Mac »), les tâches passent par le superviseur unique de `core` derrière un relais sandboxé dédié (`sondine-compute-lan`, entitlements `network.server` + `network.client`, testé sur deux vrais Mac) ; en mode autonome sur Mac dédié, des noms d'exécutables distincts évitent toute collision avec `findWorkerProcesses` (`scheduler.ts`).
2. **PC, serveur ou VM GPU Linux (Docker NVIDIA)** :
   - Le guide donne la machine qu'il faut : Mac 32 Go, ou NVIDIA 8 Go et plus avec 32 Go de RAM (24 Go de VRAM pour que Nemotron tienne entier sur la carte).
   - Image OCI Vulkan (`speech.cpp` n'est pas publié pour CUDA), téléchargement explicite du modèle par `models pull` (montage `/models` en lecture-écriture le temps du pull uniquement, puis `:ro` au runtime), vérification SHA-256 et affichage des licences.
   - Profils réseau explicites et fonctionnels (bind sur l'IP Tailscale ou `tailscale serve`, ou reverse proxy TLS local sur `127.0.0.1:8443` — HPKE E2E restant chiffré jusqu'au conteneur).
   - Appairage initial par canal hors-bande de l'administrateur (copie du lien contenant `pin` + `computePubKey` + jeton 5 min depuis SSH + validation 6 chiffres).

### 5. Contrat moteur, protocole binaire et surface réseau

Détaillé dans [`docs/cloud/engine-and-protocol.md`](../cloud/engine-and-protocol.md) :

- **`packages/engines`** : `EngineLocality = "device" | "remote-self" | "remote-beta" | "remote-cloud" | "provider"` sur `AsrCapabilities`, codes d'erreur réseau/attestation/quota distincts, `peakBytesBase` reflétant le tampon de transport réel (streaming FLAC par blocs bornés afin d'éviter l'allocation d'un `Int16Array` de 105,6 Mo d'un seul tenant), respect de la concurrence `ResidentEngine` (1 requête à la fois par moteur), et séparation dans le planificateur entre la voie locale légère (dictées Parakeet jamais bloquées par un envoi distant) et la voie lourde/distante.
- **Journal** : inchangé.
- **`packages/protocol`** : module `remote-compute.ts` (schémas Zod + JSON Schemas + fixtures dorées sans audio réel). **Zéro audio en JSON ou base64** : cadrage binaire déterministe `SNDC` chiffré AEAD par direction avec limites de taille strictes (≤ 4 MiB/chunk, ≤ 60 MiB compressés, ≤ 120 MiB décompressés anti-bombe FLAC) et TTL par état.
- **Durcissement macOS (amendement prévu à ADR 010)** : `sondine-audio`, `Sondine Speech.app` et `Sondine Text.app` gardent **zéro droit réseau**. Le test no-WAN soak d'ADR 002 reste inchangé lorsque le calcul distant est désactivé (état par défaut).

### 6. Amendements prévus lors de l'acceptation (Passe 2)

Si Téo accepte cet ADR 040, la passe 2 appliquera les amendements documentaires suivants :

- **`docs/decisions/002-local-only.md`** : ajout d'un alinéa « Amended by ADR 040 » (calcul distant opt-in, désactivé par défaut, no-WAN soak maintenu par défaut).
- **`docs/decisions/010-build-signing-hardening.md`** : ajout de `sondine-compute-lan` (entitlements `network.server` + `network.client`, si mode Mac serveur intégré retenu) et politique réseau sortante bornée pour le client distant.
- **`docs/decisions/029-private-zones.md`** : confirmation explicite avant envoi distant sur « Transcrire maintenant » en zone « Audio uniquement » et option de zone « Calcul local uniquement ».
- **`AGENTS.md`** et **`docs/product-vision.md`** : mise à jour de la priorité 1 (« Local only ») et des prérequis matériels (Mac ≥ 32 Go en local, ou Mac ≥ 8 Go avec serveur distant / Cloud Sondine).
- **`docs/decisions/037-ux-redesign.md`** : évolution de la carte cloud une fois le service livré.

## Conséquences

- Les utilisateurs de Mac 8 Go / 16 Go / 24 Go accèdent à la transcription finale Nemotron 30B, tout en conservant le modèle local par défaut et la biométrie 100 % sur le Mac.
- Le coût de conception et d'exploitation d'un cloud réellement confidentiel (quorum de signature, journal de transparence, OCSP/TCB datés, registre anti-double-dépense minimal, relais OHTTP indépendant, GPU CC en UE) est assumé explicitement plutôt que masqué derrière des promesses vagues.
- L'attestation sur l'hébergeur retenu, le débit sur GPU et le coût restent à **prouver par un essai réel** avant toute promesse publique.
- La bêta est techniquement « Votre machine » opérée par Synapsr : les deux sortent ensemble sans code de plus, ne coûtent aucune location, et donnent les mesures sur NVIDIA avant tout engagement financier sur un parc TEE.
- **La bêta ne tient pas la demande d'origine** (des données inaccessibles à notre cloud). Elle est limitée à 10 personnes informées ; l'ouverture publique attend le cloud confidentiel.

## Revue Codex Astra (2026-11-24)

Codex Astra (`codex exec -m gpt-6-astra -s read-only`) a relu l'ensemble des 15 documents de la passe 1 contre le code et les ADR existants et a émis **25 remarques** (2 critiques, 15 hautes, 8 moyennes). Toutes ont été retenues et intégrées par Gemini 4 Neon :

- **Critiques (2/2 retenues et corrigées)** :

  1. _Rekor ≠ autorisation d'exécuter_ → ajout d'une politique signée par quorum (2/3 mainteneurs) + checkpoints/témoins + `policyVersion` anti-retour + procédure d'urgence.
  2. _« Pas de réseau sortant » n'empêche pas l'exfiltration sur la réponse d'une requête attaquante après RCE_ → retrait de « sans exfil », documentation de la portée inter-sessions/futures, isolation du processus frontal détenteur de clé vs moteur d'inférence, ajout de la limite RCE dans les textes `sondine.app`.

- **Hautes (15/15 retenues et corrigées)** :

  3. _HPKE sous-spécifié_ → machine à états complète, clés bilatérales de session `K_c2s`/`K_s2c`, compteurs par direction, retransmission idempotente, `POLL`/`CANCEL` authentifiés.
  4. _Exposition rétrospective d'une clé HPKE de 24 h_ → rotation courte de la clé d'enclave + établissement de clé de session éphémère par requête (forward secrecy de l'audio/texte), limite explicitée pour le message initial.
  5. _Vérification « hors ligne » vs révocation_ → preuves OCSP/CRL et TCB agrafées datées (≤ 24 h) + politique signée à TTL court rafraîchie via OHTTP + refus dur si expiré ou retour arrière.
  6. _HBM non chiffrée sur H100_ → distinction exacte entre RAM CPU chiffrée, PCIe chiffré (SPDM) et HBM isolée matériellement (non chiffrée sur H100), ajustement du modèle d'attaque physique.
  7. _Contradiction O3 vs relais OHTTP_ → O3 reformulé en séparation stricte identité/IP vs contenu ; métadonnées vues par le relais explicitées partout.
  8. _Privacy Pass incohérent (VOPRF, double dépense RAM, 11 jetons, `model_limit`)_ → choix tranché pour RSA Blind Signatures (RFC 9578 type `0x0002`), registre anti-double-dépense partagé minimal (`H(nullifier)` seul), réservation/engagement + remboursement aveugle ou bon de réessai sur échec/`model_limit`.
  9. _`P1`/`P2` ≠ anonymisation_ → retrait de toute mention « anonymisé » ; précision explicite que les noms prononcés dans la conversation et les voix dans l'audio sont transmis (chiffrés vers le TEE).
  10. _Zones privées ADR 029 et exception iPhone ADR 032_ → distinction auto vs « Transcrire maintenant » (confirmation explicite en mode distant), rappel de l'exception iPhone et amendement prévu à ADR 029.
  11. _Raccordement annulation sur suppression_ → ajout spécifié de `cancelEpisode`/`cancelAllRemote` relié au coordinateur de suppression, aux suppressions iPhone et aux changements de réglage, plus contrôle avant chaque chunk/fenêtre.
  12. _Promesse « jamais retranscrites deux fois » > `carried`_ → retrait de la promesse absolue, explication fidèle de `carried` + récupération de résultat `SESSION_POLL` avant ACK et non-refacturation sur erreur serveur.
  13. _Journal distant (`journal-work.ts`)_ → spécification séparée des nouveaux `JournalWriter`, gestion des erreurs réseau sans consommer les 3 échecs de la file dérivée ADR 028.
  14. _« Rien n'est perdu » vs rétention ADR 015/029_ → échéances exactes documentées (types + 7 j, plafond 20 Go, zones 7 j), mise en avant de « Garder l'audio », sort `audio_unavailable`.
  15. _Coût local non nul (`Int16Array` 105,6 Mo)_ → distinction mémoire poids vs transport, streaming FLAC par blocs bornés, maintien du garde-fou pression mémoire `critical`, mesure requise sur Mac 8 Go.
  16. _« Zéro stockage » en auto-hébergement_ → distinction « aucun archivage applicatif » vs swap/dumps/OS, recommandations `ulimit -c 0`/no-swap, clarification que l'hébergeur d'une VM GPU standard garde accès à la RAM.
  17. _Erreur arithmétique coût du journal_ → recalcul exact (0,17–0,60 $/jour à 25 % util., ~0,07–0,25 $/jour à 60 % util.), harmonisation 1,5–3 s/fenêtre et retrait de « coût quasi nul ».

- **Moyennes (8/8 retenues et corrigées)** :

  18. _TTL 15 min vs deadlines 112–222 min & limites totales_ → TTL par état (`uploading`/`computing`/`completed`), plafonds 60 MiB compressés / 120 MiB décompressés (anti-bombe FLAC), auth avant allocation.
  19. _Conflit workers Mac serveur_ → superviseur partagé `core` + relais `sondine-compute-lan` (testé sur 2 vrais Mac) ou binaires dédiés en mode autonome.
  20. _Scheduler sérialisé (`scheduler.ts:788`) & concurrence `ResidentEngine`_ → 1 requête distante à la fois en v1 (conforme à `ResidentEngine`), séparation voie locale légère (Parakeet dictées) vs voie lourde/distante.
  21. _`same_moment` ne supprime pas la double transcription ASR & déclenchement indirect iPhone_ → nuance corrigée dans ADR 040 §1.
  22. _Performances CUDA, seuil Qwen 32 Go & 180 s Compose_ → séparation politique catalogue vs limite physique, `SONDINE_COMPUTE_IDLE_UNLOAD_SEC=0` sur GPU ≥ 48 Go, mesure `sondine-bench` CUDA exigée avant promesses.
  23. _GCP `a3-highgpu-1g` Spot/Flex-start_ → Azure `NCCads H100 v5` UE placé en recommandation principale, limite Spot/Flex-start de GCP signalée.
  24. _Docker `127.0.0.1:8443` vs `100.x.y.z` & `models pull`_ → deux profils Compose complets et distincts (Tailscale vs reverse proxy), commandes `models pull` harmonisées, appairage hors-bande Linux explicité.
  25. _Périmètre des textes publics FR/EN_ → nuance Claude/iPhone, description exacte des `extents` (pré/post-roll + silences courts), harmonisation FR/EN sur effacement immédiat après réponse/annulation vs TTL d'inactivité.

## Relecture de Claude Opus 5.5 (2026-11-24)

Gemini 4 Neon a atteint son quota avant le commit. Claude a comparé les 25 remarques d'origine à ce tri, puis a corrigé ce que ni Gemini ni Codex n'avait relevé :

1. **TEE.fail absent** : la RAM chiffrée était dite protégée contre l'écoute de la DRAM. Ajout au modèle de menace, à la matrice, aux limites publiques, et liste de plateformes admises.
2. **Attestation irréalisable sur Azure telle qu'écrite** : le matériel y mesure le paravisor de Microsoft, pas notre image. Ajout du profil `azure-vtpm` et de la limite sur Microsoft.
3. **Cercle vicieux au premier contact et marquage par la passerelle** : OHTTP s'arrête à la passerelle, HPKE va à l'enclave ; la configuration OHTTP vient de la politique signée, la même pour tous.
4. **Prix faux** : 10,74 $ et 8,82 $ étaient des prix Windows, 3,84 à 5,23 $ des réservations aux États-Unis. Prix Linux `westeurope` lus dans l'API d'Azure ; coûts et quota recalculés.
5. **Dérivation des IV et du secret de session** non définie ; précisée.
6. **« 100 % open source »** retiré : les micrologiciels, CUDA et le paravisor ne le sont pas.
7. **Quorum 2 sur 3** : pas réel avec un seul mainteneur ; devenu un prérequis.

Codex Astra a relu ces ajouts le même jour : **7 remarques, toutes retenues et intégrées** (2 hautes, 5 moyennes). `SESSION_OPENED` authentifié par l'exporter HPKE ; PCR reliés au condensé racine du rootfs ; portée exacte de TEE.fail ; politique récupérable sans ancienne clé OHTTP ; Rekor détecte sans empêcher ; guides opérateur alignés ; matrice de menace corrigée. Il n'a pas trouvé d'erreur de calcul et n'a pas pu revérifier les prix d'Azure.

## Réponses de Téo et corrections (2026-11-24)

Téo : héberger d'abord sur nos serveurs, sans coût ; proposer dès le départ le cloud **ou** sa propre machine avec un guide ; le vrai Nemotron sur 32 Go ou plus ; journal pas forcément dans le cloud ; l'iPhone synchronise avec le Mac, qui parle seul au serveur.

Vérifications faites pour intégrer ces réponses :

1. **Pas d'attestation sur nos serveurs** : d'où la bêta sans promesse de confidentialité, et la destination `remote-beta` séparée.
2. **CUDA supposé à tort** : `speech.cpp` est publié pour Linux x86_64 en Vulkan ou sur processeur, pas en CUDA ni sur arm64. Le moteur du cloud confidentiel reste à choisir.
3. **Débits surestimés** : 40 à 60 × supposés sur H100, 13 à 26 × publiés sur phrases courtes. Coûts recalculés à 7–25 ×.
4. **Moins de 24 Go de VRAM suffisent** : `speech.cpp` met en RAM les couches d'experts que la carte ne peut pas garder.
5. **Journal retiré** de la v1 distante : aucun texte du Mac n'est envoyé. Les remarques 9, 13 et 17 de la revue de Codex portaient sur ce journal distant et ne s'appliquent plus.

Codex Astra a relu ces changements : **10 remarques, toutes retenues** (3 hautes, 5 moyennes, 2 faibles). Swap et archivage distingués ; zones privées nommées exactement ; bêta présentée comme une proposition et non comme acquise ; 24 Go « non validé » ; portée exacte de l'attestation, d'OHTTP et des mesures de qualité ; Claude distingué du local ; inventaire des serveurs retiré. Il n'a pas trouvé d'erreur de calcul.

## Construction (2026-11-24)

Codex Astra a relu le code : **11 remarques, toutes retenues et corrigées**, chacune avec un test (4 bloquantes, 7 moyennes). Marges audio près d'une zone privée ; réponse tardive d'un serveur qui écrasait un choix plus récent ; commandes de session non authentifiées ; faux accusés de réception qui bloquaient la file ; arrêt et publication au changement de destination ; texte d'un serveur dans les journaux ; sessions d'un Mac retiré ; mémoire prise par des inconnus ; dictées bloquées à tort ; modèle local gardé en mémoire ; modèle et version non vérifiés à la connexion.

Mesuré de bout en bout, d'un Mac à la RTX 5080 par Tailscale, sur une conversation de synthèse de 10 minutes : 75 s, dont 2,9 s d'envoi ; même texte qu'en direct sur la machine ; 121 Mo de mémoire sur le Mac.

## Mise en service (2026-11-25)

Téo : journal sur les petits Mac, et bêta joignable tout de suite pour essayer le parcours entier. Le serveur tourne en service `systemd` d'utilisateur, hors du swap (`MemorySwapMax=0`) et sans dump (`LimitCORE=1` : à 0, apport écrit quand même le dump, constaté sur la machine). Le tunnel Cloudflare tourne à côté, en service séparé.

Mesuré par l'adresse publique, même conversation de synthèse de 10 minutes : 89 s, chargement du modèle compris. Par Tailscale, version finale : 69 s.

Téo, le même jour : les dictées ne doivent pas attendre une longue demande. Le planificateur a maintenant deux boucles, une pour le serveur et une pour ce que le Mac calcule (dictées, journal). Codex Astra a relu ce changement : une remarque, corrigée avec un test. Cinq places, pour l'équipe.
