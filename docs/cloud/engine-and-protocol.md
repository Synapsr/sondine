# Contrat moteur distant, protocole binaire et option « Votre machine »

Statut : associé à [ADR 040](../decisions/040-remote-compute.md). La section 0 décrit ce qui est construit (2026-11-24) et fait foi. Les suivantes sont la conception du **cloud confidentiel**, dont plusieurs choix ont été simplifiés pour « Votre machine » et la bêta.

## 0. Ce qui est construit

- **Canal** (`packages/engines/src/remote/noise.ts`) : `Noise_NK_25519_AESGCM_SHA256`, vérifié contre le vecteur public de cacophony, au lieu du HPKE décrit plus bas. Le Mac connaît d'avance la clé du serveur (lien collé, ou clé inscrite dans l'app pour la bêta). Le premier message est protégé par cette seule clé ; l'audio et le texte le sont par des clés oubliées avec la session.
- **Protocole** (`wire.ts`) : `POST /v1/open` (premier message, refusé s'il est rejoué ou vieux de plus de dix minutes), `PUT /v1/s/<id>/<n>` (morceaux scellés de 2 MiB de PCM16), `POST /v1/s/<id>` (commande scellée à compteur croissant : attendre un état, ou oublier). Rien hors des messages scellés ne compte : un intermédiaire ne peut ni lire, ni prolonger, ni supprimer une session, ni faire croire qu'un morceau est arrivé (l'état liste ceux qui manquent). HTTP simple, sans TLS propre.
- **Moteur** (`remote-asr.ts`) : le contrat `AsrEngine`, `locality: "remote"`. Mêmes poids (SHA-256) et même version d'adaptateur, sinon refus. Les temps reçus doivent tomber dans l'audio envoyé.
- **Serveur** (`apps/compute`) : réutilise l'adaptateur `speech.cpp` de l'app. Une demande à la fois, à tour de rôle ; audio en mémoire seulement ; 10 minutes d'inactivité, 10 minutes pour un résultat, 6 h en tout au plus, quoi que demande le client ; un Mac retiré perd ses sessions ; places de bêta et heures du mois.
- **File** (`scheduler.ts`) : un serveur n'attend ni le secteur, ni l'inactivité, ni la mémoire (sauf chaleur ou pression critiques). Injoignable, occupé, refusé ou quota épuisé : pause sans échec compté, dictées et journal continuent. Deux boucles : une demande à la fois chez le serveur, et à côté ce que le Mac calcule (dictées, journal) ; ni l'une ni l'autre n'attend (2026-11-25). Chaque seconde et avant chaque morceau : épisode inchangé, hors zone sans texte, destination inchangée, sinon l'envoi s'arrête ; vérifié encore avant de publier. Près d'une zone sans texte, aucune marge autour de la parole ne part. Sans changement pendant 30 minutes, la demande est abandonnée et reprise plus tard. Les traces suivent un autre travail, dans les 90 s, ou partent ensemble dès que 30 attendent. À côté, les dictées n'attendent ni secteur ni inactivité.
- **Réglages** (`packages/db/src/compute-settings.ts`) : le jeton est dans la base locale, à côté des transcriptions. Illisible vaut « Ce Mac ».
- **Docker** (`apps/compute/Dockerfile`, `compose.yaml`) : image construite sur place, speech.cpp Vulkan vérifié par sa somme, modèle en lecture seule, état dans `state/`. L'image publiée de la section 3.2 reste à faire.
- **Pas construit** : TLS propre, Bonjour, appairage à six chiffres, image Docker publiée, « Partager ce Mac », FLAC.

---

Dans ce document, « Cloud Sondine » sans précision désigne le **cloud confidentiel**, qui suit une bêta sur un serveur ordinaire de Synapsr.

Ce document spécifie :

1. l'intégration d'un moteur distant dans `packages/engines` ([ADR 005](../decisions/005-swappable-engines.md)) et les évolutions exactes nécessaires dans le planificateur ASR et le coordinateur de suppression ;
2. le format réseau binaire, la machine à états cryptographique (HPKE + clés de session), la vérification d'attestation avec preuves datées et les fixtures dorées dans `packages/protocol` ;
3. le serveur open source unique `sondine-compute` pour « Votre machine » (autre Mac LAN/Tailscale ou PC Linux Docker NVIDIA), pour la bêta sur un serveur de Synapsr et pour le cloud confidentiel ;
4. la reprise, les files d'attente, la rétention, la latence, le hors-ligne et l'annulation.

---

## 1. Contrat moteur dans `packages/engines` et intégration dans `core`

### 1.1 Un adaptateur derrière `AsrEngine` (ADR 005)

Le code d'analyse (`apps/desktop/src/core/analysis/scheduler.ts`, `requests.ts`) consomme `AsrEngine` (`packages/engines/src/contract.ts`, étend `ResidentEngine`) : `manifest`, `capabilities`, `resources`, `state()`, `pid()`, `load()`, `unload()`, `transcribe(request, options)`.

Un adaptateur distant l'implémente : `createRemoteAsrEngine(options)`. Le journal (`TextEngine`) reste local ou chez Claude en v1.

Les règles métier de segmentation (`planRequests`, `mapResult`, `splitRequest`, `repairWordTimes`), la publication transactionnelle (`publishAnalysis`), les voix locales (`voice-pass.ts`) et la recherche restent inchangées. En revanche, l'intégration distante nécessite des **évolutions explicites et bornées** dans `contract.ts`, `scheduler.ts` et le coordinateur de suppression, spécifiées ci-dessous.

### 1.2 Extensions à `packages/engines/src/contract.ts`

1. **Localité** sur `AsrCapabilities` (`TextCapabilities` garde la sienne) :

```ts
export type EngineLocality =
  | "device" // calcul sur ce Mac ; zéro octet ne sort
  | "remote-self" // serveur sondine-compute de l'utilisateur (autre Mac ou PC Linux)
  | "remote-beta" // serveur ordinaire de Synapsr, 10 places, sans attestation
  | "remote-cloud" // cloud confidentiel attesté (TEE + OHTTP + Privacy Pass)
  | "provider"; // abonnement tiers via CLI (Claude, ADR 027/028)
```

Les moteurs locaux existants portent `locality: "device"`. `remote-beta` et `remote-cloud` sont deux destinations séparées, avec deux accords séparés : l'accord donné à l'une ne vaut jamais pour l'autre, et un échec d'attestation du cloud confidentiel ne se replie **jamais** sur la bêta.

2. **Ressources locales réalistes (poids ≠ mémoire de transport)** :

Un moteur distant ne charge aucun poids localement (0 Go vs 19 Go), mais il n'a **pas** un coût local nul : `scheduler.ts:1750` (`assemble`) construit actuellement un `Int16Array` de 105,6 Mo pour 55 minutes d'audio avant encodage et transport.

- **Évolution passe 2 (streaming par blocs)** : pour les moteurs distants (ou via une méthode d'entrée par flux d'extents dans `AsrRequest` / `RemoteAsrEngine`), encoder directement les `extents` en FLAC par morceaux bornés de ≤ 4 MiB avec contre-pression afin de limiter le pic mémoire local à **~32–64 Mo** (à mesurer sur un Mac 8 Go), sans jamais allouer 105,6 Mo d'un seul tenant.
- `EngineResources` du moteur distant déclare ce budget réel de transport (`peakBytesBase: 64_000_000`, `peakBytesPerAudioHour: 0`, `coldLoadMs: 0`, `unloadLatencyMs: 1_000`, `computeUnits: ["cpu"]`).
- `pid()` retourne `undefined` (aucun processus enfant local à tuer au redémarrage).
- `load()` vérifie la disponibilité du transport (cloud confidentiel : politique signée valide + attestation fraîche ; « Votre machine » et bêta : `hello` épinglé) et passe `state()` à `"ready"`.
- `unload()` ferme les connexions, efface (`zeroize`) les clés de session et repasse `state()` à `"absent"`.

3. **Codes d'erreur moteur (`EngineErrorCode`)** :

| Code ajouté           | Signification                                                                                                                                          | Effet dans le planificateur                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `network_unavailable` | Pas de réseau, serveur injoignable, coupure TCP/TLS ou timeout relais                                                                                  | Annule la tentative **sans** incrémenter `jobs.attempts` ; backoff exponentiel + réveil sur retour réseau. |
| `attestation_failed`  | Échec cryptographique TEE, preuve OCSP/TCB expirée, politique expirée/retour arrière, mesure absente du quorum ou de Rekor, ou clé épinglée différente | **Blocage dur** (zéro octet audio envoyé) ; problème visible dans l'UI ; jamais contourné automatiquement. |
| `unauthorized`        | Jeton d'appairage ou place révoqué, ou émetteur refusé                                                                                                 | Met la file distante en pause jusqu'à ré-appairage / reconnexion ; ne compte pas comme échec de l'épisode. |
| `quota_exhausted`     | Plus de jetons Privacy Pass disponibles / quota mensuel atteint                                                                                        | Met en pause la file cloud avec message clair et action dans l'UI ; conserve la file intacte.              |
| `server_overloaded`   | `429` ou `503` du serveur distant (`Retry-After` respecté)                                                                                             | Annule sans compter d'échec ; réessaie après `Retry-After` + jitter.                                       |
| `server_mismatch`     | Version de protocole ou modèle distant incompatible                                                                                                    | Met en pause avec message d'action (mise à jour Sondine ou serveur).                                       |

4. **Provenance (`EngineProvenance`)** :
   - `engineId` : `remote:nemotron-3.5-transcribe-iq4nl` ;
   - `runtime` : protocole + runtime déclaré par le serveur (ex. `sondine-compute/1 speech.cpp 0.9.3`) ;
   - `modelSha256` : SHA-256 des poids vérifié par le serveur (et couvert par la mesure TEE sur le cloud) ;
   - `config` : `locality` (`remote-self` | `remote-beta` | `remote-cloud`), et pour le cloud confidentiel `policyVersion` et `rekorLogIndex` (sans aucune donnée utilisateur).

### 1.3 Évolutions du planificateur ASR (`scheduler.ts` et `admission.ts`)

1. **Séparation des files : ne jamais bloquer les dictées Parakeet locales**
   - Construit le 2026-11-25 : la **voie locale** (dictées Parakeet, journal, et toute transcription tant que le Mac a le modèle) et la **voie distante** tournent chacune dans leur boucle, avec 1 requête distante à la fois (le contrat « 1 requête à la fois » de `ResidentEngine`). Une indisponibilité du serveur ou un long envoi ne retient ni une dictée ni le journal, et une dictée qui attend le secteur ne retient pas le serveur.
2. **Admission distante (`admitRemote`)** :
   - Ne requiert ni secteur (`on-battery` optionnel, désactivé par défaut), ni inactivité (`not-idle`), ni marge swap de 10 Go, ni exclusion des modèles ≥ 4 Go.
   - **Conserve** un garde-fou local : refuse si `memoryPressure === "critical"` (pour ne jamais aggraver une saturation mémoire sur un Mac 8 Go) ou `thermalState === "critical"`.
   - Vérifie en plus : consentement actif pour l'étape, connectivité réseau, option « pause sur connexion limitée / partage de connexion » (**activée par défaut**), absence de blocage (`attestation_failed`, `unauthorized`, `quota_exhausted`), et absence de fenêtre backoff `retryAtMs`.
3. **Zones privées (ADR 029) et confirmation sur geste manuel** :
   - En automatique : un épisode en zone « Rien » ou « Audio uniquement » n'est jamais envoyé. Un épisode en zone « Texte uniquement » suit le moteur configuré.
   - Sur clic « Transcrire maintenant » pour un épisode en zone « Audio uniquement » : si le moteur actif est distant, `core` exige une confirmation explicite (`allowRemoteOverride: true`, validée dans une boîte de dialogue) avant tout envoi réseau.
   - Les enregistrements iPhone restent exclus des zones du Mac (ADR 032) et suivent la politique de calcul configurée sur le Mac.
4. **Raccordement explicite de l'annulation (suppression, changement de réglage, iPhone)** :
   - Ajout de `cancelEpisode(episodeId)` et `cancelAllRemote()` sur `AnalysisQueueService`, appelés par :
     - le coordinateur de suppression (`episodes.delete`, `episodes.forget`, expiration rétention, suppression initiée par l'iPhone) ;
     - tout changement de destination ou retrait de consentement dans _Réglages ▸ Transcription_.
   - L'adaptateur distant revérifie une fonction `canStillSend()` (épisode non supprimé, génération inchangée, consentement toujours actif) **avant chaque `AUDIO_CHUNK`**, en plus de la vérification atomique dans la transaction SQLite de publication.

### 1.4 Journal : hors de la v1

Le journal n'est envoyé à aucun serveur de calcul (réponse de Téo, 2026-11-24). `journal-work.ts` ne change pas et aucun texte du Mac n'est envoyé. Par le protocole `sondine-compute`, s'entend : choisir Claude pour écrire le journal (ADR 028) envoie toujours le texte à Anthropic. Qwen3.5 9B (pic de 6,3 Go) se télécharge dès 16 Go de mémoire ; il reste à le mesurer sur 16 et 24 Go. Le protocole garde les types de trame `0x0007` et `0x0084` réservés.

### 1.5 Voix et diarisation : 100 % local sur le Mac

Nemotron distant renvoie des segments avec `speaker: 0 | 1 | 2…` (locaux à la requête) et les temps de chaque mot (`AsrToken`). Après publication dans SQLite sur le Mac, `onPublished(episodeId)` lance `voice-pass.ts` **localement sur le Mac** : WeSpeaker ResNet34-LM (~25 Mo sur Core ML) lit l'archive locale, calcule les embeddings et propose « Marie ? ». Aucune empreinte biométrique ne transite jamais sur le réseau.

---

## 2. Protocole réseau dans `packages/protocol`

### 2.1 Règles invariantes

1. **Zéro audio en JSON ou base64.** L'audio transite en octets bruts **FLAC 16 kHz mono 16 bits sans perte** par défaut (repli `pcm16-16k-mono`), dans des trames binaires chiffrées. Sur la parole 16 kHz mono, FLAC réduit le volume de 115,2 Mo/h à ~35–50 Mo/h sans perte (ADR 015).
2. **Schémas Zod et fixtures dorées** : `packages/protocol/src/remote-compute.ts` définit les messages de contrôle, les codes d'erreur, l'enveloppe d'attestation, les limites et les en-têtes binaires ; schémas JSON générés dans `packages/protocol/schemas/` et fixtures dans `packages/protocol/fixtures/remote-compute/` testés en TypeScript et côté serveur `sondine-compute`.
3. **Chiffrement applicatif E2E identique partout** (cloud confidentiel via OHTTP, bêta, autre Mac sur LAN/Tailscale, PC Linux).

### 2.2 Architecture de transport

```text
Mode « Votre machine » (LAN / Tailscale / Linux) et bêta Synapsr (HTTPS) :
  Mac (core) ──► TLS 1.3 (SPKI épinglé ou HTTPS) ──► HPKE + session AEAD E2E ──► sondine-compute

Mode « Cloud confidentiel » :
  Mac (core) ──► TLS 1.3 ──► Relais OHTTP tiers indépendant (voit IP + volume chiffré)
                                  │ (paquet opaque)
                                  ▼
                       Passerelle Synapsr (termine OHTTP, route sans IP client,
                                  │         ne voit que le chiffré HPKE)
                                  │
                                  ▼
                       Enclave TEE (SEV-SNP/TDX + NVIDIA CC)
                       ├─ Frontal minimal (détient clé d'enclave, termine HPKE,
                       │    vérifie Privacy Pass via registre minimal partagé)
                       └─ Worker GPU isolé (zéro accès clé d'enclave)
```

### 2.3 Machine à états cryptographique et format binaire des trames

HPKE (RFC 9180) est unidirectionnel et OHTTP (RFC 9458 §6.5) laisse la reprise/idempotence à l'application. Nous spécifions donc explicitement la couche session.

Deux couches distinctes, pour éviter un cercle vicieux au premier contact : **OHTTP** s'arrête à la passerelle (hors TEE) et ne sert qu'à cacher l'IP ; **HPKE** va du Mac à l'enclave attestée et protège le contenu. La configuration de clé OHTTP vient de `CloudTrustPolicy`. Cette politique est un **fichier statique signé, le même pour tous**, que le relais sert en HTTPS ordinaire à une adresse fixe : un Mac longtemps hors ligne peut donc la renouveler sans ancienne clé OHTTP. Le relais voit déjà l'IP et n'apprend rien de plus. Le Mac vérifie signature, Rekor, fraîcheur et anti-retour avant de s'en servir. La demande d'attestation passe ensuite par OHTTP. Ni l'une ni l'autre ne portent d'audio, de texte ou de jeton.

1. **Établissement de session avec forward secrecy (`SESSION_OPEN`)** :
   - Le client génère une paire éphémère `clientEphemeralX25519` et chiffre `SESSION_OPEN` (aucun audio, uniquement `{ protocolVersion, stage, modelId, modelSha256, clientEphemeralPubKey, privacyPassOrAuth }`) via **HPKE Base (`DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, `AES-256-GCM`)** vers la clé publique de l'enclave (ou la clé épinglée du serveur « Votre machine »).
   - Le frontal génère sa propre paire éphémère `serverEphemeralX25519` et un `sessionId` aléatoire (128 bits), calcule le secret partagé `DH(serverEphemeral, clientEphemeral)` combiné à `hpkeContext.Export("sondine-session-v1", 32)` (RFC 9180 §5.3), et dérive deux clés symétriques directionnelles indépendantes :
     - `K_c2s = HKDF-Expand(secret, "sondine-c2s-v1" || sessionId, 32)` (client → serveur) ;
     - `K_s2c = HKDF-Expand(secret, "sondine-s2c-v1" || sessionId, 32)` (serveur → client) ;
   - `IV_c2s` et `IV_s2c`, 12 octets chacun, dérivés de la même façon avec les étiquettes `sondine-c2s-iv-v1` et `sondine-s2c-iv-v1`.
   - `secret = HKDF-Extract(salt = exporter HPKE, ikm = DH)`, avec le condensé de la transcription (`SESSION_OPEN`, `sessionId`, les deux clés éphémères) ajouté à chaque `info`. Le client rejette un secret DH nul.
   - Les jetons et l'autorisation contenus dans `SESSION_OPEN` n'ont pas la confidentialité persistante des données de session : ils sont protégés par la seule clé d'enclave (≤ 6 h). Un `SESSION_OPEN` rejoué ouvre une session que l'attaquant ne peut pas utiliser et ne réserve pas les jetons une seconde fois.
   - Le serveur efface immédiatement `serverEphemeralPriv` après dérivation et renvoie `SESSION_OPENED` (`sessionId`, `serverEphemeralPubKey`, limites) chiffré et authentifié sous `K_resp` et `N_resp`, dérivés de l'exporter du contexte HPKE Mac–enclave (`hpkeContext.Export("sondine-response-v1", 44)`, [RFC 9180 §9.8](https://www.rfc-editor.org/rfc/rfc9180.html#section-9.8)). Le Mac vérifie ce message **avant** de dériver les clés de session : la passerelle ne peut ni le lire ni le modifier.
   - Les clés `K_c2s` et `K_s2c` sont effacées (`zeroize`) dès `SESSION_ACK`, `SESSION_CANCEL` ou expiration du TTL.
2. **Séparation des directions, compteurs et anti-rejeu** :
   - Chaque direction maintient un compteur strictement monotone de 64 bits (`seq_c2s` à partir de 1, `seq_s2c` à partir de 1) utilisé pour dériver le nonce AES-256-GCM (`IV_dir XOR seq`) et inclus dans `AAD = ("SNDC" || protocolVersion || sessionId || direction || seq || frameType)`.
   - Le serveur conserve dans l'état de session en RAM : `lastAcceptedSeqC2S`, `receivedChunks` (ensemble des `(chunkIndex, byteOffset, byteLength)` validés) et le dernier résultat de chaque `chunkIndex`.
   - Tout message portant `seq_c2s <= lastAcceptedSeqC2S` est **rejeté** (anti-rejeu strict).
   - **Gestion d'un ACK perdu (retransmission propre)** : si le client n'a pas reçu l'ACK d'un `AUDIO_CHUNK` (coupure réseau), il ré-envoie le même `chunkIndex` avec un **nouveau `seq_c2s` strictement supérieur**. Le serveur vérifie que `byteOffset` et le SHA-256 du morceau correspondent au morceau déjà reçu et renvoie un `CHUNK_ACK` idempotent (chiffré sous un nouveau `seq_s2c`), sans ré-écrire les octets ni facturer quoi que ce soit. En cas de divergence d'octets pour un même `chunkIndex` → erreur `protocol` et destruction de la session.
   - `SESSION_POLL`, `SESSION_ACK` et `SESSION_CANCEL` sont tous chiffrés et authentifiés sous `K_c2s` : aucun tiers ne peut sonder, récupérer ou annuler la session d'un autre client.
3. **Cadrage binaire à l'intérieur du chiffrement AEAD** (`Content-Type: application/octet-stream` ou `message/ohttp-req`) :

```text
+-----------------------------------------------------------------------+
| Magic: 4 octets "SNDC" (0x53 0x4E 0x44 0x43)                          |
| Version: uint16 BE (1)                                                |
| FrameType: uint16 BE                                                  |
|   0x0001 = SESSION_OPEN    (JSON : stage, model, pubkey éphémère)     |
|   0x0002 = AUDIO_CHUNK     (JSON : chunkIndex, offset, sha256 + FLAC) |
|   0x0003 = SESSION_COMMIT  (JSON : totalBytes, totalSha256, tokens)   |
|   0x0004 = SESSION_POLL    (JSON : demande état / résultat)           |
|   0x0005 = SESSION_ACK     (JSON : confirmation réception → purge)    |
|   0x0006 = SESSION_CANCEL  (JSON : annulation immédiate → purge)      |
|   0x0080 = SESSION_OPENED  (JSON : sessionId, pubkey serveur, caps)   |
|   0x0081 = CHUNK_ACK       (JSON : ackedBytes, nextChunkIndex)        |
|   0x0082 = PROGRESS_EVENT  (JSON : avancement 0..1, phase)            |
|   0x0083 = ASR_RESULT      (JSON : segments, tokens, provenance)      |
|   0x008F = ERROR_EVENT     (JSON : code, retryAfterMs, refundVoucher) |
| HeaderLen: uint32 BE (≤ 1 MiB)                                        |
| PayloadLen: uint32 BE (≤ 4 MiB)                                       |
| HeaderJSON: <HeaderLen octets UTF-8>                                  |
| BinaryPayload: <PayloadLen octets bruts FLAC/PCM, zéro base64>        |
+-----------------------------------------------------------------------+
```

4. **Limites strictes et admission avant allocation (anti-DoS / anti-bombe FLAC)** :
   - **Authentification avant allocation** : le serveur n'alloue aucun tampon audio tant que `SESSION_OPEN` n'est pas authentifié (jeton client `sdc_…` en mode _Votre machine_ et en bêta, ou preuve d'un jeton Privacy Pass valide / réservation de slot en mode _Cloud Sondine_).
   - **Plafonds par session ASR** :
     - taille max d'un `AUDIO_CHUNK` : **4 MiB** ;
     - nombre max de chunks : **20** ;
     - taille totale compressée max : **60 MiB** (55 min de parole FLAC ≈ 35–50 MiB) ;
     - taille totale décompressée max : **120 MiB** (55 min PCM16 16 kHz mono = 105,6 Mo ; le décodeur FLAC en streaming coupe immédiatement au-delà de 120 MiB pour bloquer toute bombe de décompression).
   - **TTL distincts par état de session** :
     - `uploading` : TTL d'**inactivité** de **10 min** (réarmé à chaque `AUDIO_CHUNK` valide), plafond absolu d'upload **60 min** ;
     - `computing` : vivant pendant toute la durée du calcul jusqu'à la deadline (`120 s + 2 × audio` sur GPU cloud, `120 s + 4 × audio` sur Mac distant — soit jusqu'à ~112 min / ~222 min pour 55 min d'audio), maintenu par les heartbeats `SESSION_POLL` ;
     - `completed` (résultat prêt en RAM en attente de `SESSION_ACK`) : **5 min** max après fin du calcul, puis purge irréversible (`zeroize`).

### 2.4 Vérification d'attestation avec preuves datées et anti-rollback (Cloud Sondine)

Avant la première requête (puis à expiration du cache d'attestation ≤ 15 min ou changement de nœud) :

1. **Rafraîchissement de la politique signée (fichier statique servi par le relais)** :
   - Le Mac récupère périodiquement (TTL max **24 h**) la politique signée `CloudTrustPolicy` (quorum multi-signatures indépendantes, ex. 2-sur-3 clés matérielles de mainteneurs dont les clés publiques sont embarquées dans l'app signée).
   - La politique porte un entier strictement monotone `policyVersion` (mémorisé en base locale : tout recul est rejeté comme tentative de rollback), la liste des mesures logicielles autorisées (`allowedMeasurements`), la liste des mesures révoquées (`revokedMeasurements`), les niveaux TCB minimaux CPU/GPU, la configuration de clé OHTTP, les plateformes admises (`allowedPlatforms` : `chip_id` AMD ou PPID Intel, si l'hébergeur fournit des identifiants stables), les paravisors admis sur Azure, les clés publiques Privacy Pass par époque et un `expiresAtMs`. Une seule politique est canonique par époque ; deux au plus sont valides pendant un recouvrement de 2 h. Une politique absente de Rekor est refusée. Rekor rend détectable une politique concurrente, il ne l'empêche pas : des observateurs indépendants doivent signaler deux politiques pour une même époque.
   - Si la politique est expirée et non rafraîchissable → `EngineError("attestation_failed")`.
2. **Demande d'attestation (`GET /v1/attestation?nonce=<32 octets aléatoires>` via OHTTP)** :
   - Le nœud TEE renvoie `AttestationBundle` contenant :
     - `enclavePublicKey` (HPKE X25519, durée de vie ≤ 6 h) et `nodeKeyId` ;
     - `cpuEvidence`, selon l'un des deux profils ci-dessous, + **chaîne de certificats et preuves TCB/CRL agrafées datées (≤ 24 h)**. On note `binding = SHA-512(nonce || enclavePublicKey || sha256(gpuEvidence))` :
       - **profil `direct`** (VM dont l'invité choisit `report_data`, par exemple TDX chez GCP ou SEV-SNP sans paravisor) : `report_data = binding` et la mesure matérielle couvre notre image ;
       - **profil `azure-vtpm`** : `report_data` contient le condensé des _runtime claims_ de Microsoft (clé d'attestation du vTPM `HCLAkPub`, `user-data`). Le Mac vérifie le rapport SNP, ce condensé, la mesure du paravisor contre la politique, `user-data = binding`, puis un **quote vTPM signé par cette clé**, avec le nonce frais, sur les PCR (banque SHA-256) qui mesurent une chaîne complète : noyau, ligne de commande et initrd, avec le **condensé racine `dm-verity` du rootfs** inscrit dans l'initrd mesuré. La politique liste les registres et leurs valeurs : des PCR de démarrage seuls ne prouvent pas quelle application tourne. La mesure calculée hors ligne par `sev-snp-measure` ne s'applique pas à ce profil : les mesures publiées sont les valeurs de PCR. **À prouver par un essai réel** sur `NCC40ads_H100_v5` avant de retenir Azure ;
     - `gpuEvidence` (rapport NVIDIA CC `cc_mode=ON`, niveau firmware/driver, liaison SPDM, même nonce) + **réponses OCSP/RIM agrafées datées (≤ 24 h)** ;
     - `rekorProof` (preuve d'inclusion Merkle Sigstore Rekor + checkpoint signé par témoins indépendants pour cette mesure logicielle).
3. **Vérification locale sur le Mac** :
   - Vérifie signatures CPU/GPU jusqu'aux racines AMD/Intel/NVIDIA embarquées dans l'app ;
   - Vérifie fraîcheur du nonce ET non-expiration des preuves OCSP/CRL/TCB agrafées (≤ 24 h) ;
   - Vérifie que la plateforme figure dans `allowedPlatforms` lorsque la politique en liste ;
   - Vérifie que la mesure figure dans `CloudTrustPolicy.allowedMeasurements`, n'est pas révoquée, respecte le TCB minimal ET possède une preuve Rekor valide avec checkpoint témoin ;
   - Tout échec bloque l'envoi (`attestation_failed`).

### 2.5 Fixtures dorées à produire (Passe 2)

Dans `packages/protocol/fixtures/remote-compute/` (zéro voix réelle, zéro audio utilisateur) :

- `frame-session-open.bin` + `.json`, `frame-audio-chunk.bin` (sinusoïde synthétique générée) ;
- vecteurs cryptographiques complets : dérivation `K_c2s`/`K_s2c`, tests de rejeu (`seq` répété), test de retransmission idempotente après ACK perdu, test de rejet sur modification de `BinaryPayload` ;
- `attestation-bundle-valid.json` et cas d'échec (`invalid-ocsp-expired`, `invalid-policy-rollback`, `invalid-measurement-not-in-quorum`, `invalid-rekor-missing`, `invalid-gpu-cc-off`, `invalid-platform-not-allowed`, `invalid-vtpm-quote-nonce`, `invalid-paravisor`, `invalid-rootfs-same-boot`) ;
- `asr-result-nemotron.json`, `errors.jsonl` ;
- un cas qui prouve qu'un échec d'attestation ne mène jamais à `remote-beta`.

---

## 3. Option « Votre machine » : le serveur open source `sondine-compute`

Un seul serveur open source (AGPL-3.0) sert tous les déploiements :

| Cible                           | Où il tourne                                          | Runtimes pilotés                                                    | Découverte & appairage                                                                                                                                                                                                                                | Sécurité                                                                                    |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Autre Mac ≥ 32 Go**           | macOS Apple Silicon (ex. Mac Studio / Mac mini)       | `speech.cpp` (Metal)                                                | ADR 008 : QR/lien (5 min) + 6 chiffres, Bonjour `_sondine-compute._tcp` sur LAN, repli optionnel Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Appairage initial sur LAN uniquement.                                                            | TLS 1.3 épinglé (SPKI SHA-256) **+ HPKE + clés de session E2E** + jeton révocable (`sdc_…`) |
| **PC / serveur / VM GPU Linux** | Linux x86_64 + NVIDIA ≥ 8 Go et 32 Go de RAM (Docker) | `speech.cpp` (Vulkan ; CPU en dernier recours)                      | Appairage hors-bande : `sondine-compute pair` en SSH génère un lien `sondine-compute://pair?…` (5 min, `pin` + `computePubKey` + jeton) + confirmation 6 chiffres. _(Exception assumée au LAN obligatoire du Mac, puisque la VM Linux est distante.)_ | TLS 1.3 (épinglé ou HTTPS) **+ HPKE + clés de session E2E** + jeton révocable (`sdc_…`)     |
| **Bêta Synapsr**                | Serveur ordinaire de Synapsr (NVIDIA 12 Go ou plus)   | `speech.cpp` (Vulkan)                                               | En un clic : `POST /v1/beta/claim` via Cloudflare Tunnel, place et jeton ; clé publique du serveur inscrite dans l'app                                                                                                                                | Identique au PC Linux ; **aucune attestation, les administrateurs peuvent lire la mémoire** |
| **Cloud confidentiel (TEE)**    | VM confidentielle SEV-SNP/TDX + NVIDIA CC GPU         | À choisir : `speech.cpp` (CUDA, non vérifié par son auteur) ou vLLM | Automatique via relais OHTTP + politique signée à quorum + attestation matérielle + Rekor                                                                                                                                                             | Attestation CPU+GPU + **HPKE + clés de session E2E** + OHTTP + Privacy Pass RSA (`0x0002`)  |

### 3.1 Cohabitation propre sur un Mac serveur (pas de conflit de workers)

Dans Sondine aujourd'hui, `scheduler.ts:373–379` tue au démarrage tout processus utilisant les binaires `speech` / `llama-server` de l'app, et `journal-model.ts:55` interdit deux instances du même exécutable (`worker_running`). Pour éviter tout conflit :

- **Mode intégré dans Sondine.app (« Partager ce Mac »)** : aucun second worker n'est lancé. Un relais natif sandboxé dédié **`sondine-compute-lan`** (même modèle qu'`sondine-lan` d'ADR 008/010 : App Sandbox, entitlements `network.server` + `network.client` + groupe applicatif, testé sur deux vrais Mac — pas uniquement loopback) relaie les connexions épinglées vers `core` sur un socket privé `<data>/run/compute.sock`. `core` arbitre les requêtes distantes dans **son propre superviseur unique** (priorité aux tâches locales du Mac serveur, zéro double chargement de 19 Go, zéro conflit de PID). Les données reçues ne touchent jamais la base SQLite du Mac serveur.
- **Mode autonome (`sondine-compute` sur un Mac mini dédié sans Sondine.app)** : utilise son propre exécutable (`sondine-compute-speech`) afin de ne jamais entrer en collision avec `findWorkerProcesses` d'un éventuel Sondine.app.

### 3.2 Serveur / VM GPU Linux (Docker NVIDIA)

- **Image OCI** : `ghcr.io/synapsr/sondine-compute:v1-vulkan` (épinglée par digest SHA-256). `speech.cpp` est publié sous Linux pour Vulkan et pour le processeur ; CUDA se compile mais n'est pas vérifié par son auteur.
- **Téléchargement explicite des modèles** (volume `/models` monté en écriture uniquement pour la commande `pull`, puis `:ro` au runtime) :
  ```bash
  docker compose run --rm -v ./models:/models:rw sondine-compute \
    models pull nemotron-3.5-transcribe-30b-iq4nl
  ```
- **Absence d'archivage applicatif (et nuance honnête sur l'OS)** : `sondine-compute` n'écrit jamais l'audio ni les transcriptions dans `/state` ou sur disque persistant (`/state` contient uniquement la clé serveur et les SHA-256 des jetons clients). Toutefois, un `tmpfs` Docker peut être paginé vers le swap Linux si le swap hôte est actif, et un crash peut écrire un core dump : la documentation opérateur/utilisateur recommande donc `LimitCORE=1` (à 0, apport d'Ubuntu écrit quand même le dump) et `MemorySwapMax=0` pour le service, ou la désactivation (ou le chiffrement) du swap sur l'hôte Linux. Enfin, sur une **VM GPU Linux standard (non TEE)**, l'hébergeur technique conserve l'accès hyperviseur à la mémoire malgré TLS et HPKE.
- **Mémoire de la carte** : ~3,7 Go libres obligatoires, plus 0,72 Go par couche d'experts gardée sur la carte (23 couches) ; le reste en RAM. `SONDINE_COMPUTE_IDLE_UNLOAD_SEC=180` libère la carte, `0` garde le modèle chargé.

---

## 4. Reprise, files d'attente, rétention, latence et hors-ligne

| Situation                                                        | Comportement spécifié                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mac hors-ligne (avion, métro, Wi-Fi coupé)**                   | Capture, VAD, Parakeet en direct/dictée, recherche, lecture et suppressions fonctionnent normalement. Les épisodes clos restent en file locale (`jobs`) en statut `offline`, sans incrémenter les compteurs d'échec. Reprise automatique dès le retour du réseau dans l'ordre de priorité (demandes → conversations → moments → médias ; traces exclues par défaut sur cloud payant).                                                                                                                                                                                       |
| **Serveur « Votre machine » éteint ou en veille**                | Sonde LAN (2 s) puis Tailscale si autorisé (4 s), comme ADR 008. Sans réponse : statut discret « Serveur injoignable — N conversations en attente », backoff (30 s → 1 min → 5 min → 15 min) et réveil sur action utilisateur ou événement réseau.                                                                                                                                                                                                                                                                                                                          |
| **Coupure réseau en plein envoi**                                | **Reprise par morceau / offset** : chaque `AUDIO_CHUNK` (≤ 4 MiB) confirmé par `CHUNK_ACK` avance l'offset. Sur coupure, le client reprend au premier morceau non confirmé tant que la session `uploading` est vivante (TTL d'inactivité 10 min). Si l'ACK a été perdu, le client ré-envoie avec un nouveau `seq_c2s` et le serveur renvoie un `CHUNK_ACK` idempotent. Si la session a expiré (`404 session_expired`), une nouvelle session repart proprement.                                                                                                              |
| **Coupure réseau après calcul, avant réception du résultat**     | Le résultat chiffré reste en RAM serveur jusqu'à `SESSION_ACK` ou expiration du TTL `completed` (5 min) : le client le récupère via `SESSION_POLL` sans relancer le calcul ni repayer.                                                                                                                                                                                                                                                                                                                                                                                      |
| **Redémarrage de `core` ou perte de `carried`**                  | `recoverInterruptedJobs` remet les tentatives en `abandoned` et le job en `queued` (sans échec). `carried` (`scheduler.ts:294`, en RAM, max 4 jobs) est perdu au redémarrage : un épisode multi-requêtes partiellement fini peut donc être **recalculé**. Sur le Cloud Sondine, seuls les calculs menés à terme consomment des jetons (réservation/engagement) ; des checkpoints locaux persistants (purgés à la suppression) pourront être ajoutés ultérieurement si les mesures terrain le justifient.                                                                    |
| **Indisponibilité prolongée et rétention locale (ADR 015, 029)** | **Attention : l'audio n'attend pas indéfiniment.** Les règles locales de `privacy-policy.ts` continuent de s'appliquer : expiration par type + 7 jours de grâce, plafond disque de 20 Go (qui expire les plus anciens enregistrements même non transcrits), 7 jours pour les zones « Texte uniquement », et suppression entière pour « Effacé après ». La file signale clairement les épisodes proches d'expiration et propose **« Garder l'audio »** pour les protéger. Si la source expire avant transcription, le job passe en `audio_unavailable` sans retry (ADR 016). |
| **Troncature `model_limit` ou `untimed` (ADR 016)**              | `splitRequest` coupe au silence le plus long de la moitié centrale et renvoie les deux moitiés (max 3 niveaux, ≥ 60 s). Sur le Cloud Sondine, l'enclave joint un bon de remboursement aveuglé / `retryVoucher` pour ne pas facturer deux fois le même audio.                                                                                                                                                                                                                                                                                                                |
| **Suppression ou « Oublier » en cours d'envoi / calcul**         | Le coordinateur de suppression appelle `cancelEpisode(episodeId)` : `AbortSignal` coupe la requête locale, un `SESSION_CANCEL` authentifié (best-effort) demande la purge RAM immédiate côté serveur, aucun chunk supplémentaire n'est envoyé, et la transaction SQLite de publication rejette tout résultat tardif.                                                                                                                                                                                                                                                        |
