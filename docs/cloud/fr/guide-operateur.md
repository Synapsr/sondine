# Guide opérateur — Déployer, mesurer et vérifier le Cloud Sondine (TEE)

_Document de conception révisé après revue critique (passe 1, [ADR 040](../../decisions/040-remote-compute.md), [modèle de menace](../threat-model.md))._

Ce guide s'adresse à l'équipe Synapsr (et à tout opérateur ou auditeur indépendant) souhaitant déployer une instance confidentielle vérifiable de `sondine-compute`, publier ses mesures dans le journal de transparence, signer la politique d'autorisation par quorum et auditer l'attestation.

---

## 0. La bêta, sur un serveur ordinaire

L'équipe commence par Tailscale, sans port public ([« Votre machine »](utiliser-votre-propre-serveur.md)). Ce qui suit vaut pour les testeurs extérieurs.

La bêta est le même `sondine-compute` que [« Votre machine »](utiliser-votre-propre-serveur.md), opéré par Synapsr. Les sections 1 à 6 décrivent le cloud confidentiel et ne s'y appliquent pas.

- **Serveur :** carte NVIDIA de 12 Go ou plus, 32 Go de RAM, aucun autre service qui occupe la carte en permanence.
- **Déploiement :** un service `systemd` d'utilisateur ([`apps/compute/README.md`](../../../apps/compute/README.md)), hors du swap (`MemorySwapMax=0`) et sans dump (`LimitCORE=1`). Le tunnel ne voit que du chiffré. `SONDINE_COMPUTE_BETA_PLACES` ouvre la bêta : 5 aujourd'hui, 10 prévues.
- **Journaux :** une ligne par événement, son heure et un mot (`beta-claimed`, `transcribed`, `failed` avec un code, `expired`). Ni contenu, ni durée, ni place, ni adresse. Aucun journal d'accès devant le service non plus. Le journal de la machine garde ces lignes selon son réglage : fixez une limite.
- **État sur disque :** par place, `clients/` garde une empreinte du jeton et la date de création, `usage/` la date de la dernière transcription comptée et **les secondes transcrites dans ce mois-là**. C'est bien une durée par place : la limite mensuelle en a besoin, et `sondine-compute list` l'affiche. Elle reste jusqu'à ce que la place soit rendue (le Mac le demande une fois), retirée (`remove`) ou, dans une bêta pleine, prise par un nouveau venu après 14 jours sans usage. Dites-le aux testeurs, et rien de plus fort que cette liste.
- **Pas une ZDR :** le programme ne garde rien du contenu, mais ce n'est pas du zéro rétention vis-à-vis de vous, les administrateurs. Ne l'annoncez jamais ainsi.
- **Administrateurs :** quiconque a un accès root ou Docker peut lire la mémoire du programme, **y compris un agent IA installé sur la machine**. Lui retirer ces droits, ou le déplacer. Tenir la liste à jour, la réduire, activer l'authentification à deux facteurs. L'app dit aux testeurs que les personnes et les programmes qui administrent le serveur pourraient y accéder.
- **Accès :** Cloudflare Tunnel (`cloudflared`) vers `cloud.sondine.app`, sans port ouvert. Le service distribue ses places (`POST /v1/open`, un `claim`), jetons révocables, trois par jour et par adresse au plus (une empreinte salée, en mémoire). Aucun compte, aucun paiement. Remettre les places à 0 ferme la bêta.
- **Limites :** une requête à la fois, deux par client et trente en tout, 1,5 Go d'audio en mémoire, 40 heures par mois et par place ; le reste attend.
- **Sortie :** à l'ouverture du cloud confidentiel, révoquer les places et détruire l'instance. Chaque Mac redemande l'accord de la personne.

---

## 1. Vue d'ensemble de l'infrastructure

Le Cloud Sondine sépare **cinq rôles distincts** afin qu'aucun composant ne rassemble identité client, IP et contenu :

1. **Facturation et émetteur Privacy Pass (hors TEE)** : gère les abonnements/packs (ex. Stripe) et signe à l'aveugle les jetons **RSA Blind Signatures (RFC 9578 type `0x0002`, publiquement vérifiables)**. Ne reçoit jamais d'audio ni de requêtes de calcul.
2. **Relais OHTTP (opéré par un tiers juridiquement indépendant)** : reçoit les paquets OHTTP des Mac, retire l'IP cliente et relaie vers la passerelle Synapsr. Voit l'IP et le trafic chiffré ; ne possède jamais les clés HPKE.
3. **Passerelle de routage Synapsr (hors TEE, sans état)** : termine OHTTP et détient sa clé, route vers les enclaves TEE actives et relaie `/v1/attestation` ainsi que la politique signée `CloudTrustPolicy`. Ne voit jamais l'IP cliente ni le contenu en clair.
4. **Registre anti-double-dépense partagé minimal (hors contenu)** : stocke uniquement `{ epochId, SHA256(token_authenticator), state: "reserved" | "spent", expiresAt }` afin d'empêcher la double dépense entre plusieurs enclaves TEE et à travers les redémarrages. **Ne reçoit ni contenu, ni IP, ni identifiant d'utilisateur.** Interrogé par les enclaves via un lien privé dédié (mTLS) strictement limité à cet hôte.
5. **Nœuds de calcul TEE (`sondine-compute` en VM confidentielle)** :
   - CPU : **AMD SEV-SNP** (ex. Azure `Standard_NCC40ads_H100_v5` en `westeurope`) ou **Intel TDX** (néo-cloud TEE ; _note :_ sur GCP, `a3-highgpu-1g` confidentiel est actuellement documenté en Spot/Flex-start et nécessite validation contractuelle avant usage permanent).
   - GPU : **NVIDIA H100 / H200 / B200** en mode **Confidential Computing (`cc_mode=ON`)**. _(Rappel matériel : sur H100, la RAM CPU et les transferts PCIe sont chiffrés ; la HBM embarquée est protégée par isolation matérielle et non chiffrée.)_
   - À l'intérieur de l'enclave : **séparation stricte entre le processus frontal** (détenteur de la clé d'enclave HPKE, parsing du protocole et Privacy Pass ; OHTTP s'arrête à la passerelle, aucun code GPU) **et le processus worker GPU** (moteur à choisir, voir les [coûts](couts-et-latence-gpu.md) §3 ; zéro accès à la clé d'enclave, `seccomp`, rootfs `dm-verity` lecture seule).

---

## 2. Construction d'une image serveur reproductible

- **Chaîne de compilation épinglée** : Nix / Bazel ou Dockerfile avec digests SHA-256 épinglés, noyau minimal durci, `initramfs` déterministe (`SOURCE_DATE_EPOCH=0`).
- **Rootfs immuable (`dm-verity`)** : lecture seule, arbre de Merkle vérifié par l'initrd mesuré.
- **Poids des modèles vérifiés** : Nemotron 30B monté depuis un volume `dm-verity` mesuré ou vérifié par SHA-256 au boot avant toute acceptation de trafic.
- **Surface minimale** : aucun `sshd`, aucun shell interactif, aucun `gdb`/`strace`/`ptrace` (`kernel.yama.ptrace_scope=3`), console série désactivée ou limitée aux compteurs agrégés, pare-feu invité `nftables` n'autorisant en sortie que le lien privé mTLS vers le registre anti-double-dépense (et les réponses sur la connexion entrante).

La CI génère un manifeste `release-measurements.json` :

- `gitCommit`, tag et `imageSha256` ;
- profil `direct` : `sevSnpMeasurement` (calculé hors ligne par `sev-snp-measure` pour la topologie vCPU exacte) et/ou `tdxMrtd` + `tdxRtmr0..3` ;
- profil `azure-vtpm` : valeurs de PCR (SHA-256 ; noyau, ligne de commande, initrd portant le condensé racine `dm-verity`) et mesures de paravisor Microsoft admises (`sev-snp-measure` ne s'applique pas) ;
- `minCpuTcb`, `minGpuDriverVersion`, `gpuRimHashes` ;
- `models`: `{ artifactId, version, sha256 }` alignés sur `packages/engines/src/models/catalog.ts`.

---

## 3. Transparence (Rekor) ET autorisation par quorum

> **Principe fondamental :** inscrire une mesure dans Sigstore Rekor la rend **publiquement observable**, mais **ne suffit pas à l'autoriser** (une CI compromise pourrait inscrire une image backdoorée). L'application Sondine exige **les deux** : la preuve Rekor **et** une politique signée par quorum indépendant.

1. **Enregistrement dans Sigstore Rekor (auditabilité publique)** :
   ```bash
   cosign sign-blob \
     --bundle release-measurements.sigstore.json \
     release-measurements.json
   ```
   Publier le commit Git, les instructions de build reproductible et l'index Rekor (avec checkpoint signé par témoins indépendants) dans les notes de release publiques.
2. **Délai d'audit (mises à jour ordinaires)** : respecter 24 h entre la publication Rekor et l'ajout dans la politique de production afin que des tiers puissent recompiler l'image.
3. **Signature de `CloudTrustPolicy` par quorum hors CI (autorisation)** :
   - Au moins **2 mainteneurs sur 3** (clés matérielles distinctes, hors CI automatisée) reproduisent ou vérifient la mesure et cosignent le fichier `CloudTrustPolicy` :
     - `policyVersion` : entier strictement monotone (anti-rollback vérifié par chaque Mac) ;
     - `issuedAtMs` / `expiresAtMs` : durée de validité courte (**24 h** max, rafraîchie automatiquement par quorum ou sous-clé opérationnelle de renouvellement à portée limitée qui ne peut _jamais_ ajouter de nouvelles mesures, seulement ré-horodater la même liste approuvée ou en révoquer une) ;
     - `allowedMeasurements`, `revokedMeasurements`, `minCpuTcb`, `minGpuTcb`, `allowedPlatforms`, paravisors admis, configuration de clé OHTTP, clés publiques Privacy Pass actives par époque ;
     - la politique signée est elle-même **inscrite dans Rekor**, puis publiée en fichier statique sur le relais, une seule par époque (recouvrement de 2 h au plus).
4. **Règle d'urgence (faille critique 0-day)** : le quorum peut immédiatement incrémenter `policyVersion`, placer l'ancienne mesure dans `revokedMeasurements`, inscrire l'image corrigée dans Rekor et la signer sans attendre 24 h.

---

## 4. Déploiement d'un nœud TEE

1. **Provisionnement recommandé (UE)** :
   - **Azure `Standard_NCC40ads_H100_v5`** (AMD SEV-SNP + 1× H100 NVL 94 Go, `westeurope`, disponible à la demande et réservé 1–3 ans), disque OS immuable, aucun disque de données persistant, GPU `cc_mode=ON`. Profil d'attestation `azure-vtpm`, **à valider par un essai réel avant toute réservation**.
   - **Sécurité physique :** exiger de l'hébergeur ses engagements d'accès aux machines. TEE.fail montre qu'un accès physique suffit à lire les sessions (modèle de menace §4.2).
   - _(Note GCP : `a3-highgpu-1g` confidentiel en `europe-west4` est actuellement en Spot/Flex-start — ne pas l'utiliser pour un service interactif permanent sans garantie contractuelle de capacité non-interruptible.)_
2. **Séquence de démarrage (`sondine-compute --mode=tee`)** :
   - Vérifie `/dev/sev-guest` ou `/dev/tdx_guest` (profil `direct`), ou le vTPM (profil `azure-vtpm`), et NVIDIA CC (`nvidia-smi conf-compute -f` → `ON`, session SPDM établie). Échec → `exit 1`.
   - Vérifie le SHA-256 des poids Nemotron et les charge dans le processus worker GPU isolé.
   - Le processus frontal génère une paire **HPKE X25519** éphémère en RAM protégée (rotation toutes les **6 h** max, jamais écrite sur disque) et obtient les preuves OCSP/CRL/TCB agrafées datées (renouvelées toutes les ≤ 12 h, valides ≤ 24 h).
   - Charge la clé publique RSA de l'émetteur Privacy Pass (RFC 9578 `0x0002`).
3. **Recyclage fréquent** : chaque nœud TEE est détruit et recréé automatiquement toutes les **6 à 24 h** (ou sur rotation de clé), limitant la fenêtre d'une éventuelle RCE et effaçant toute mémoire RAM/HBM.

---

## 5. Vérifier l'attestation (opérateur et auditeur externe)

```bash
sondine-compute verify-attestation \
  --relay https://ohttp-relay.example.net/sondine \
  --gateway https://cloud.sondine.app \
  --trust-roots embedded
```

Contrôles exécutés localement (identiques à ceux de l'app macOS) :

1. **Politique signée** : vérification du quorum 2/3, non-expiration (`expiresAtMs`) et absence de recul (`policyVersion >= lastSeen`).
2. **Fraîcheur** : le nonce client de 32 octets figure dans la preuve CPU (`report_data` en profil `direct`, quote vTPM et `user-data` en profil `azure-vtpm`) et dans l'évidence GPU.
3. **Chaînes matérielles et révocation datée** : AMD ARK/ASK/VCEK (ou Intel Root CA/PCK) et NVIDIA RIM/OCSP vérifiés, `debug_enabled == false`, `cc_mode == ON`, liaison SPDM valide, preuves OCSP/CRL/TCB agrafées non expirées (≤ 24 h) et TCB ≥ minimum de la politique.
4. **Liaison clé HPKE** : `binding = SHA-512(nonce || enclavePublicKey || sha256(gpuEvidence))`. Profil `direct` : `report_data == binding`. Profil `azure-vtpm` : `report_data` est le condensé des _runtime claims_, `user-data == binding`, la mesure du paravisor est admise, et le quote vTPM (signé par `HCLAkPub`) porte le nonce et les PCR de notre image. Dans les deux cas, la plateforme doit figurer dans `allowedPlatforms` si la politique en liste.
5. **Double verrou logiciel** : la mesure figure dans `CloudTrustPolicy.allowedMeasurements` (et non dans `revokedMeasurements`) **ET** possède une preuve d'inclusion Rekor avec checkpoint témoin valide.

---

## 6. Exploitation Privacy Pass, observabilité et incidents

- **Métriques autorisées** (agrégées uniquement) : requêtes/min, latence p50/p95, occupation GPU/VRAM, erreurs par code (`4xx`/`5xx`), sessions expirées, état du registre anti-double-dépense.
- **Strictement interdit** : contenu audio ou texte, durées individuelles corrélables, IP clientes, identifiants de jetons en clair dans les logs.
- **Rotation des clés Privacy Pass** : 1 paire de clés RSA par époque mensuelle (recouvrement de 7 jours en fin de mois).
- **Procédure d'incident et délai réel de révocation** :
  1. Le quorum publie immédiatement un nouveau `CloudTrustPolicy` révoquant la mesure compromise : les Mac en ligne refusent les anciens nœuds dès le prochain rafraîchissement (et au plus tard à l'expiration du TTL de **24 h** de leur politique en cache).
  2. Les anciennes instances TEE sont terminées immédiatement côté infrastructure (coupant l'accès en quelques secondes indépendamment du cache client).
  3. L'image corrigée est publiée sur Rekor, validée par le quorum et déployée.
  4. Un post-mortem public est publié sur le dépôt.
