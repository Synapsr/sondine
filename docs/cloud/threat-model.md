# Modèle de menace — Calcul hors du Mac (Cloud Sondine & auto-hébergement)

Statut : Brouillon de conception révisé après revue Codex Astra (passe 1, associé à [ADR 040](../decisions/040-remote-compute.md)).

Dans ce document, « Cloud Sondine » sans précision désigne le **cloud confidentiel**, qui suit une bêta sur un serveur ordinaire de Synapsr.

Ce document analyse rigoureusement qui pourrait compromettre les données envoyées hors du Mac, quels objectifs de sécurité Sondine vise, ce que chaque approche technique protège réellement (et ne protège pas), puis formule une recommandation claire avec ses limites résiduelles.

---

## 1. Actifs à protéger et frontière de données

Sondine enregistre en continu les conversations professionnelles, médicales, familiales et privées de l'utilisateur et de tiers qui n'ont pas forcément choisi l'outil ([ADR 012](../decisions/012-third-parties-and-biometrics.md)). Une fuite d'audio ou de transcriptions est irréversible et d'une sensibilité maximale.

**Actifs transitant potentiellement hors du Mac (uniquement si l'utilisateur active l'étape) :**

- **Pour la transcription finale (`final-asr`)** : les `extents` audio planifiés (`requests.ts`) d'un épisode clos (16 kHz mono FLAC sans perte : régions de parole élargies de 1,5 s pré-roll / 0,8 s post-roll et fusionnées quand l'écart est inférieur au seuil de regroupement, après suppression des `deleted_ranges` et des zones interdites), jusqu'à 55 minutes par requête ; plus la transcription horodatée renvoyée avec des indices de locuteurs locaux (`0, 1, 2…`). **Attention :** cet audio contient les voix réelles des participants (dont des caractéristiques vocales identifiables pourraient être extraites côté serveur si le serveur était compromis).
- **Le journal** : rien. En v1 il n'est envoyé à aucun serveur de calcul.
- **Métadonnées réseau et de facturation** : adresse IP d'origine, horaires d'envoi, tailles/durées des requêtes, preuve de paiement / droit d'accès.

**Actifs qui ne sortent jamais du Mac (hors surface d'attaque cloud) :**

- Empreintes vocales WeSpeaker stockées (données biométriques, RGPD art. 9), exemplaires vocaux, lecture de voix (ADR 034).
- Carnet « Personnes », noms enregistrés sur le Mac, associations voix ↔ identité.
- Base SQLite complète, index de recherche FTS5, contexte ajouté (notes, images, PDF — ADR 024), configuration des zones privées (ADR 029), applications frontales (ADR 022), historique de navigation (ADR 023).

---

## 2. Modèle d'adversaires

Nous évaluons l'architecture face à cinq adversaires concrets :

| #      | Adversaire                                                                                                         | Capacités réalistes                                                                                                                                                                                                                                                                                                                                                       | Ce qu'il cherche                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | **L'opérateur Synapsr et ses employés** (y compris un administrateur malveillant ou un compte CI/CD compromis)     | Accès root à l'infrastructure de déploiement, tableaux de bord cloud, logs de passerelle, base de facturation Stripe/clients, accès dépôt Git et CI/CD (hors compromission simultanée du quorum de clés matérielles de signature de politique).                                                                                                                           | Lire l'audio/texte de clients, activer une journalisation cachée, pousser une image serveur backdoorée, relier un client payant à ses requêtes.          |
| **A2** | **L'hébergeur / fournisseur d'infrastructure** (Azure, GCP, néo-cloud GPU, datacenter)                             | Contrôle total de l'hyperviseur, de l'OS hôte, du stockage réseau, du réseau interne du datacenter et accès physique standard au rack (sniffer réseau/PCIe, snapshots RAM hôte/disque). _Deux attaques physiques ne sont pas couvertes :_ le sondage de la HBM d'un GPU H100, et l'espionnage du bus mémoire DDR5 du processeur par un interposeur (TEE.fail). Voir §4.2. | Inspecter la RAM d'une VM GPU, copier un snapshot de disque ou d'hyperviseur, intercepter le trafic sur le bus PCIe entre CPU et GPU.                    |
| **A3** | **L'observateur réseau** (FAI, Wi-Fi public, opérateur BGP, relais OHTTP seul, relais Tailscale DERP)              | Écoute passive ou attaque active (MitM) sur les liens internet, observation des IP, horaires et volumes de trafic.                                                                                                                                                                                                                                                        | Lire les octets en transit, identifier l'usage et le rythme d'un utilisateur, ou usurper le serveur.                                                     |
| **A4** | **Une réquisition légale** (mandat judiciaire, subpoena, ordre secret avec obligation de silence)                  | Peut contraindre légalement Synapsr, l'hébergeur, le prestataire de paiement ou le relais OHTTP à livrer toute donnée détenue, voire tenter d'imposer une écoute silencieuse.                                                                                                                                                                                             | Obtenir des enregistrements passés, des logs reliant un utilisateur à ses requêtes, ou intercepter secrètement les requêtes futures d'un individu ciblé. |
| **A5** | **Un serveur compromis** (vulnérabilité 0-day dans `sondine-compute`, le moteur, le pilote GPU ou le noyau invité) | Exécution de code arbitraire (RCE) dans le processus d'inférence ou la VM invitée. Peut lire la mémoire de son processus et **exfiltrer des données via la réponse d'une requête légitime qu'il envoie lui-même au même worker** (même sans connexion réseau sortante !).                                                                                                 | Voler des clés, exfiltrer l'audio/texte des sessions en cours ou suivantes jusqu'au recyclage de l'instance.                                             |

---

## 3. Objectifs de sécurité

1. **O1 — Confidentialité du contenu** : ni l'opérateur (A1), ni l'hébergeur logiciel/réseau (A2), ni l'observateur réseau (A3), ni une réquisition portant sur le passé ou exigeant une écoute secrète sans changement d'image approuvée publiquement (A4) ne peuvent lire l'audio envoyé ni le texte renvoyé.
2. **O2 — Zéro rétention applicative vérifiable** : aucun audio ni texte n'est écrit sur un stockage persistant ; la mémoire d'une session est effacée (`zeroize`) dès l'acquittement de la réponse, l'annulation confirmée ou l'expiration d'un TTL d'inactivité court. Cette propriété est vérifiable dans le code source ouvert et mesuré qui tourne effectivement sur le serveur.
3. **O3 — Séparation stricte identité / IP / contenu (non-corrélation inter-acteurs)** : aucun acteur pris isolément ne dispose à la fois de l'identité (compte payeur ou adresse IP) et du contenu des conversations :
   - la **facturation / émetteur** connaît le paiement et le nombre de crédits retirés, jamais le contenu ni le calendrier d'usage ;
   - le **relais OHTTP tiers** connaît l'adresse IP, les horaires et les volumes chiffrés des connexions (ce qu'aucun relais ne peut cacher seul), mais jamais le contenu ni le compte client ;
   - le **TEE de calcul** traite le contenu en mémoire protégée le temps de la requête, mais ne connaît ni l'adresse IP client ni le compte payeur.

---

## 4. Comparaison honnête des approches

### 4.1 TLS + promesse contractuelle « zéro rétention »

_Principe_ : le Mac envoie l'audio en HTTPS (TLS 1.3) vers une API GPU classique (H100/L40S standard) opérée par Synapsr, qui s'engage contractuellement à ne rien conserver.

- **Ce que ça protège** : uniquement l'observateur réseau passif (A3) sur le contenu.
- **Où ça échoue** :
  - **A1 (Synapsr)** : un administrateur peut `ssh` sur la machine ou activer des logs à tout moment sans que le client ne le détecte.
  - **A2 (Hébergeur)** : l'hyperviseur peut lire la RAM de la VM et la mémoire GPU à tout moment.
  - **A4 (Réquisition légale)** : une injonction peut forcer Synapsr ou l'hébergeur à enregistrer silencieusement les futures requêtes d'un utilisateur ciblé.
  - **O3 (Séparation)** : le serveur voit à la fois l'IP, le compte utilisateur et le contenu.
- **Verdict** : **insuffisant pour le Cloud Sondine**. Acceptable si l'utilisateur opère lui-même un serveur qui lui appartient (mode _Votre machine_), avec l'épinglage de clé et le chiffrement E2E HPKE. Acceptable aussi pour la **bêta à 10 places** (§4.7), à condition de le dire.

### 4.2 Chiffrement E2E vers un TEE attesté (AMD SEV-SNP / Intel TDX + NVIDIA Confidential Computing)

_Principe_ : le calcul tourne dans une VM confidentielle CPU (**AMD SEV-SNP** ou **Intel TDX**) couplée à un GPU **NVIDIA Confidential Computing** (H100, H200 ou Blackwell B200/B300 en mode `cc_mode=ON`), inspiré d'**Apple Private Cloud Compute (PCC)** avec tout notre code ouvert et auditable. Les micrologiciels d'AMD, d'Intel et de NVIDIA, le pilote CUDA et, sur Azure, le paravisor de Microsoft restent hors de notre contrôle.

**Précision matérielle importante (par génération GPU) :**

- **RAM CPU** : chiffrée matériellement (AES-XTS, plus la protection d'intégrité de SEV-SNP ou TDX) contre l'hyperviseur et les instantanés mémoire. **Elle ne résiste pas à un interposeur physique.** [TEE.fail](https://tee.fail) (octobre 2025) lit le bus DDR5 avec un montage à moins de 1 000 $ et, le chiffrement étant déterministe, en déduit des clés :
  - sur Intel, la clé d'attestation elle-même, donc de fausses preuves TDX que le vérificateur officiel accepte ;
  - sur AMD SEV-SNP, une clé ECDSA d'OpenSSL utilisée dans la VM, avec accès physique et contrôle de l'hôte. L'extraction de nos clés (X25519, AES) n'est pas démontrée ; par prudence, nous la tenons pour possible ;
  - sur NVIDIA, l'attestation du GPU n'est pas liée à une VM précise : une fois l'attestation du processeur falsifiée, celle d'un autre GPU peut être relayée.

  Intel et AMD classent cette attaque hors de leur modèle et ne prévoient pas de correctif. Il faut un accès physique au serveur.

- **Transferts CPU ↔ GPU sur PCIe** : chiffrés et authentifiés matériellement via la session SPDM et les _bounce buffers_ chiffrés.
- **Mémoire GPU (HBM)** : sur **NVIDIA H100**, la HBM intégrée au package **n'est pas chiffrée** ; sa protection repose sur les pare-feux matériels mémoire du GPU (interdisant tout accès DMA/hyperviseur/CPU non autorisé) et sur l'hypothèse de sécurité physique du boîtier GPU lui-même. Une attaque physique invasive décapsulant le package GPU reste hors modèle de menace sur H100 (les garanties seront mises à jour par génération si Blackwell ou ultérieur ajoute le chiffrement HBM).

**Chaîne de confiance complète (quatre verrous nécessaires ensemble) :**

1. **Image serveur open source et reproductible** : image immuable (`dm-verity` en lecture seule, pas de `sshd`, pas de shell, poids vérifiés par SHA-256). N'importe qui peut la recompiler et retrouver la même mesure matérielle (`measurement` SEV-SNP / `MRTD`+`RTMR` TDX).
2. **Autorisation par politique signée à quorum + journal de transparence (Rekor)** :
   - Une simple inscription dans Sigstore Rekor **ne constitue pas une autorisation d'exécuter** : un employé malveillant ou une CI compromise (A1) pourrait publier une image backdoorée, reproductible et inscrite dans Rekor.
   - L'application Sondine exige donc **à la fois** : (a) une **politique d'autorisation signée par un quorum indépendant** (ex. 2-sur-3 clés matérielles de mainteneurs distincts, hors CI automatisée) portant un numéro de version monotone anti-retour (`policyVersion`) et un TTL court (≤ 24 h, rafraîchi sous forme de fichier statique servi par le relais) ; et (b) une **preuve d'inclusion Merkle dans Sigstore Rekor** avec checkpoint signé par témoins indépendants (garantissant qu'aucune image secrète ne peut être ciblée sans apparaître publiquement).
   - Un délai d'audit public (ex. 24 h pour les mises à jour ordinaires) permet aux observateurs indépendants de recompiler l'image avant son activation. Pour un correctif de sécurité critique, la politique signée par quorum peut révoquer immédiatement l'ancienne mesure et autoriser la nouvelle dès sa publication dans Rekor.
3. **Vérification locale d'attestation avec preuves de révocation datées** :
   - Avant tout chiffrement, le Mac envoie un nonce frais (32 octets) et vérifie localement : la chaîne matérielle AMD VCEK / Intel PCK, la chaîne NVIDIA RIM, `debug_enabled=false`, `cc_mode=ON`, la liaison SPDM, **les preuves OCSP/CRL et TCB agrafées et non expirées (≤ 24 h)**, la fraîcheur du nonce, la politique signée anti-rollback et la preuve Rekor.
   - Si une preuve de révocation ou la politique est expirée, ou si `policyVersion` recule → **refus dur (`attestation_failed`)**.
4. **Chiffrement E2E par session avec confidentialité persistante (forward secrecy)** :
   - Le processus frontal de terminaison HPKE (minimal, sans parsing audio ni code GPU) est **séparé** du processus d'inférence.
   - La clé publique d'attestation de l'enclave (incluse dans `report_data`) a une rotation courte (≤ 6 h).
   - Chaque session négocie en outre une paire de clés symétriques bilatérales (`K_c2s`, `K_s2c`) par Diffie-Hellman éphémère (X25519) dans `SESSION_OPEN` (qui ne contient **aucun audio**) : ces clés de session sont effacées (`zeroize`) dès la fin ou l'annulation de la session. Ainsi, même si la clé d'enclave est compromise ultérieurement, les tranches audio/texte des sessions terminées enregistrées sur le réseau ne peuvent pas être déchiffrées rétrospectivement.

- **Ce que ça protège** :
  - **A1 (Synapsr seul / CI compromise)** : fort — pas de SSH, pas d'accès RAM, pas d'image backdoorée déployable sans casser le quorum de signature _et_ apparaître publiquement dans Rekor.
  - **A2 (Hébergeur logiciel/réseau/hyperviseur)** : fort — RAM CPU et bus PCIe chiffrés, HBM isolée matériellement contre l'hyperviseur et le DMA.
  - **A4 (Réquisition légale)** : fort contre l'accès rétrospectif (zéro historique) et contre l'écoute secrète silencieuse (toute image acceptée doit passer le quorum et apparaître dans Rekor).
- **Ce que ça ne protège PAS seul** :
  - **A5 (RCE dans le runtime d'inférence)** : une faille mémoire dans le moteur ou le pilote GPU à l'intérieur du TEE pourrait lire les requêtes **en cours ou suivantes sur ce worker jusqu'au recyclage**, et **exfiltrer ces données via la réponse autorisée d'une requête que l'attaquant envoie lui-même au même worker** (même sans accès réseau sortant !).
    _Atténuations réelles (sans prétendre à une protection absolue)_ : séparation du frontal HPKE et du worker GPU, exécution d'un seul slot isolé par processus worker (zéro partage de mémoire applicative entre deux utilisateurs simultanés lorsque le worker est recyclé ou cloisonné par session/container), `seccomp` + rootfs lecture seule, pas de persistance disque, recyclage fréquent des enclaves.
  - **Failles matérielles TEE / attaque physique invasive sur HBM H100** : confiance dans le silicium et le microcode AMD/Intel/NVIDIA.
  - **Attaquant ayant un accès physique au serveur (TEE.fail)** : il peut lire les sessions de la machine qu'il tient. Sur Intel, il peut aussi fabriquer une fausse enclave ailleurs, avec la mesure officielle.
    _Atténuations :_ la politique signée liste les plateformes admises (`allowedPlatforms` : `chip_id` AMD ou PPID Intel des machines de l'hébergeur sous contrat) lorsque l'hébergeur garantit des identifiants stables ; AMD SEV-SNP est préféré à TDX ; l'hébergeur est choisi aussi pour sa sécurité physique ; clés courtes et recyclage des nœuds. Aucune de ces mesures ne protège contre l'hébergeur qui attaque ses propres machines.
  - **Paravisor de l'hébergeur (Azure)** : sur Azure, la mesure matérielle couvre le paravisor et l'UEFI de Microsoft, pas notre image. Notre image est mesurée par le vTPM, qui tourne dans ce paravisor ([documentation Microsoft](https://learn.microsoft.com/en-us/azure/confidential-computing/guest-attestation-confidential-virtual-machines-design)). Microsoft entre donc dans la base de confiance : un paravisor malveillant, mais accepté par notre politique, pourrait mentir sur l'image. La protection reste entière contre Synapsr (A1) et contre un administrateur ordinaire d'Azure. Elle est **partielle contre Microsoft lui-même** (A2).
  - **Métadonnées IP et facturation** : nécessitent OHTTP (§4.3) et Privacy Pass (§4.4).

### 4.3 Relais OHTTP (RFC 9458 / Chunked OHTTP)

_Principe_ : le Mac encapsule ses requêtes HTTP (contenant déjà des trames chiffrées vers le TEE) dans une enveloppe **Oblivious HTTP** envoyée à un **Relais OHTTP** opéré par une **entité juridiquement distincte** de Synapsr (ex. Fastly, Cloudflare ou partenaire européen indépendant).

- **Ce que ça protège** : Synapsr, l'hébergeur et le TEE ne voient **jamais** l'adresse IP du Mac. Le relais ne voit jamais le contenu audio/texte, ni les clés de session, ni les jetons Privacy Pass.
- **Ce que le relais OHTTP voit malgré tout (honnêteté sur O3)** : le relais observe l'adresse IP du Mac, les horaires de connexion, le nombre de requêtes et leur volume approximatif (chiffré). Aucune collusion n'est nécessaire pour que le relais sache _qu'une IP donnée utilise Sondine à telle fréquence_.
- **Gestion de l'audio multi-mégaoctets** : pour rester compatible avec les limites de corps et de timeout des relais OHTTP tiers, chaque requête OHTTP transporte au plus un morceau chiffré de **4 MiB** (`AUDIO_CHUNK`), ou utilise Chunked OHTTP lorsqu'il est disponible, avec bourrage de taille par paliers (ex. multiples de 256 KiB) et léger jitter aléatoire (0–30 s) sur les tâches automatiques en arrière-plan afin d'atténuer la corrélation triviale volume/horaire.
- **Marquage par la passerelle** : une passerelle qui donnerait à chaque Mac une clé OHTTP, une politique ou une clé d'émetteur Privacy Pass différente pourrait le reconnaître d'une requête à l'autre ([RFC 9458 §7](https://www.rfc-editor.org/rfc/rfc9458.html#section-7)). La configuration OHTTP et les clés d'émetteur viennent donc d'un fichier signé par quorum, inscrit dans Rekor et servi à tous par le relais, avec une seule politique canonique par époque. Rekor rend une politique concurrente détectable, il ne prouve pas que tous reçoivent la même : il faut des observateurs indépendants.
- **Limite résiduelle** : en cas de **collusion** (ou double réquisition coordonnée) entre le relais OHTTP _et_ Synapsr, la corrélation temporelle et volumétrique reste possible, surtout si peu d'utilisateurs sont actifs simultanément au lancement.

### 4.4 Crédits anonymes (Privacy Pass — RFC 9578 type `0x0002`, RSA Blind Signatures)

_Principe_ : dissocier le paiement (Stripe / Apple) des requêtes de transcription.

- **Choix cryptographique tranché : RSA Blind Signatures publiquement vérifiables (RFC 9578, Token Type `0x0002`, RFC 9474)** — et **non** VOPRF (`0x0001`), car le mode VOPRF est à vérification privée (il exigerait de partager la clé secrète de l'émetteur avec chaque nœud TEE, augmentant inutilement la surface de compromission). Avec RSA Blind Signatures, chaque nœud TEE ne possède que la **clé publique** de l'émetteur.
- **Cycle de vie et cohérence transactionnelle** :
  1. **Retrait à l'avance** : lors du paiement ou du renouvellement mensuel, le Mac retire un lot de jetons aveuglés d'une **dénomination uniforme** (`asr-5m` = 5 min d'audio) sur une époque mensuelle partagée par tous les utilisateurs. Le retrait a lieu à l'avance (jamais juste avant une transcription) pour briser la corrélation temporelle.
  2. **Registre anti-double-dépense partagé et minimal** : une table en RAM locale sur un seul nœud ne résiste ni aux redémarrages ni aux clusters multi-nœuds. Les enclaves TEE interrogent donc (sur un lien interne authentifié mTLS, distinct du trafic utilisateur) un **registre anti-double-dépense partagé minimal** qui stocke uniquement `{ epochId, SHA256(token_authenticator), state: "reserved" | "spent", expiresAt }` — **zéro contenu, zéro IP, zéro identifiant d'utilisateur**.
  3. **Réservation, engagement et gestion des échecs (y compris 55 min = 11 jetons et `model_limit`)** :
     - Une requête de 55 min nécessite **11 jetons `asr-5m`** présentés à `SESSION_COMMIT`.
     - Les jetons passent en état `reserved` (verrouillés contre une dépense parallèle ailleurs) le temps du calcul, puis en `spent` uniquement quand l'enclave produit un résultat complet (ou `refunded` / libérés si le nœud échoue en `5xx` avant production).
     - Si le modèle s'arrête sur `model_limit` ou `untimed` (ADR 016) et impose au client de couper l'audio en deux moitiés : l'enclave retourne avec la réponse `model_limit` un **jeton de remboursement aveuglé** (ou un `retryVoucher` signé pour la même empreinte audio divisée) permettant de retranscrire les deux moitiés **sans double facturation**.
     - Si la connexion tombe _après_ que le résultat a été produit mais _avant_ que le client ne l'ait reçu, le résultat chiffré reste récupérable par `SESSION_POLL` (authentifié par `K_c2s`) pendant 5 minutes jusqu'à `SESSION_ACK` — évitant toute perte de crédit sur coupure réseau.

### 4.5 FHE et MPC : impraticables en 2026 pour 30B

- **FHE** : Nemotron 30B-A4B (encodeur audio + routage MoE dynamique + décodeur + CTC) enchaîne des dizaines de couches non linéaires (RMSNorm, SiLU, Softmax). Les approximations polynomiales et le _bootstrapping_ imposent un ralentissement de **$10^4\times$ à $10^6\times$** sur GPU actuels, et le routage MoE privé oblige à évaluer l'ensemble des 30B paramètres (perte totale du bénéfice 4B actif). Coût prohibitif (centaines d'euros par heure d'audio, heures/jours de latence).
- **MPC (2PC/3PC)** : exige des dizaines à centaines de Go de bande passante inter-serveurs à très faible latence par seconde d'inférence entre opérateurs indépendants non-collusifs — économiquement et opérationnellement inabordable, tout en restant vulnérable à la collusion entre les serveurs MPC.
- **Verdict** : rejeté pour 2026–2028 ; à réévaluer uniquement si des ASIC FHE dédiés réduisent ce coût d'au moins 3 ordres de grandeur.

### 4.6 Découpage de l'audio en morceaux mélangés (sharding / shuffling)

Rejeté comme protection principale pour trois raisons :

1. **Détruit la diarisation** et fait chuter le tcpWER de Nemotron (qui exploite jusqu'à 55 min de contexte multi-locuteurs, ADR 018).
2. **Ré-assemblage trivial par empreinte vocale** : un serveur malveillant peut calculer des embeddings vocaux sur des fragments de 15 s et reconstituer les conversations et le graphe social.
3. **Un fragment de 15 s suffit déjà à révéler un secret critique.**

Seule la minimisation naturelle d'ADR 016 (envoyer uniquement les `extents` d'un épisode clos, jamais deux épisodes ensemble) est conservée.

### 4.7 La bêta sur un serveur ordinaire de Synapsr

_Choix du 2026-11-24 :_ la bêta tourne d'abord sur un serveur ordinaire de Synapsr.

Ces machines ne fournissent pas la chaîne CPU + GPU confidentielle exigée au §4.2 (ni SEV-SNP ou TDX, ni GPU en mode confidentiel) : **aucune attestation de ce type n'est possible en bêta**. AMD exclut par exemple SEV sur les Ryzen et les EPYC 4004 et 4005 ([AMD](https://www.amd.com/content/dam/amd/en/documents/epyc-business-docs/solution-briefs/amd-confidential-computing-solution-brief.pdf)).

- **Ce que ça protège** : le trajet (A3) et un reverse proxy, par TLS et HPKE jusqu'au programme ; les données au repos, puisque le programme n'archive rien (swap de l'hôte désactivé).
- **Ce que ça ne protège pas** : A1, A2 et A4. Quiconque a un accès root ou Docker (un agent IA compris) peut lire la mémoire, changer le programme, ou y être contraint. Cloudflare voit l'IP, les horaires et les volumes ; le serveur voit le jeton de la place et l'IP transmise : O1, O2 vérifiable et O3 ne sont **pas** atteints.
- **Pas de fausse protection** : OHTTP et Privacy Pass pourraient séparer l'IP et le compte du contenu, mais pas protéger le contenu contre les administrateurs ; le quorum et Rekor n'ont pas de mesure à attester. Ils sont volontairement omis de la bêta.
- **Conditions** : 10 places, gratuit, aucun appel réseau avant le clic, avertissement avant activation (« les personnes qui administrent ce serveur pourraient techniquement y accéder ») avec un engagement sur l'honneur, tenu par l'absence de journaux de contenu, jamais « privé » ni « vérifié », destination séparée (`remote-beta`) sans repli depuis le cloud confidentiel, personnes prévenues qu'il s'agit aussi des voix de tiers (ADR 012).
- **Place sans compte** : une personne peut en prendre plusieurs. Limite par IP et retrait à la main.
- **Clé du serveur inscrite dans l'app** : la changer demande une mise à jour de Sondine, ou une clé de secours inscrite à l'avance.
- **Verdict** : acceptable pour 10 personnes informées. **Insuffisant pour l'ouverture publique**, qui contredirait la demande d'origine.

---

## 5. Matrice de comparaison synthétique

Légende : **Fort** = protégé cryptographiquement ou matériellement · **Partiel** = atténué avec limites explicites · **Faible / Non** = exposé.

| Mécanisme                                                                              | A1 Opérateur Synapsr                                          | A2 Hébergeur (logiciel / réseau)                                                                                                         | A3 Observateur réseau                                      | A4 Réquisition légale                                                                         | A5 Serveur compromis (RCE)                                                                                              | O2 Zéro rétention vérifiable   | O3 Séparation identité/IP/contenu | Viabilité 2026               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------- | ---------------------------- |
| **Bêta : serveur ordinaire + E2E HPKE (§4.7)**                                         | Non                                                           | Non                                                                                                                                      | Fort (contenu)                                             | Non                                                                                           | Non                                                                                                                     | Non (confiance)                | Non                               | **Oui (testeurs informés)**  |
| TLS + promesse « zéro rétention »                                                      | Non                                                           | Non                                                                                                                                      | Fort (contenu)                                             | Non                                                                                           | Non                                                                                                                     | Non (confiance)                | Non                               | Trivial                      |
| **TEE attesté (SEV-SNP/TDX + NVIDIA CC) + quorum politique + Rekor + E2E par session** | **Fort** (hors compromission du quorum ou de l'app elle-même) | **Fort** contre l'hyperviseur ; **Non** contre une attaque physique (TEE.fail, HBM) ; **Partiel** contre Microsoft sur Azure (paravisor) | **Fort** (contenu)                                         | **Fort** (zéro historique) ; **Partiel** si l'ordre vise un hébergeur qui a un accès physique | **Partiel** _(expose sessions en cours et suivantes jusqu'au recyclage ; exfiltration possible via réponse attaquante)_ | **Fort** (image reproductible) | Partiel (IP/compte visibles)      | **Oui (recommandé)**         |
| + **Relais OHTTP indépendant**                                                         | **Fort** (ne voit plus l'IP)                                  | Inchangé pour le contenu ; IP masquée                                                                                                    | **Partiel** _(relais voit IP + horaires/volumes chiffrés)_ | Inchangé pour le contenu ; IP masquée _(sauf double mandat + corrélation)_                    | Inchangé                                                                                                                | Inchangé                       | **Fort (IP ↔ contenu)**           | **Oui (recommandé)**         |
| + **Privacy Pass RSA (`0x0002`) + registre minimal**                                   | **Fort** (facturation dissociée)                              | Inchangé                                                                                                                                 | Inchangé                                                   | Inchangé pour le contenu ; facturation sans lien aux requêtes                                 | Inchangé                                                                                                                | Inchangé                       | **Fort (compte ↔ contenu)**       | **Oui (recommandé)**         |
| FHE / MPC                                                                              | Fort (FHE) / Partiel (MPC)                                    | Fort                                                                                                                                     | Fort                                                       | Fort                                                                                          | Fort (FHE)                                                                                                              | Fort                           | Dépend OHTTP/PP                   | **Non (10⁴–10⁶× trop lent)** |
| Découpage + mélange                                                                    | Faible (ré-assemblable par voix)                              | Faible                                                                                                                                   | Non                                                        | Faible                                                                                        | Faible                                                                                                                  | Non                            | Faible                            | Détruit la diarisation       |

---

## 6. Recommandation claire et limites assumées

### Recommandation

Ouvrir la bêta et « Votre machine » ensemble (§4.7), puis déployer l'architecture **4 couches** avant toute ouverture publique payante :

1. **TEE matériel CPU + GPU attesté** (AMD SEV-SNP ou Intel TDX + NVIDIA CC) exécutant une image reproductible open source, autorisée uniquement par **politique signée à quorum + preuve Rekor + preuves OCSP/TCB datées (≤ 24 h)**.
2. **Chiffrement E2E par session (HPKE + échange éphémère X25519)** avec séparation du frontal de clés et du worker d'inférence, et effacement (`zeroize`) des clés de session.
3. **Relais OHTTP tiers indépendant** (chunks ≤ 4 MiB, bourrage par paliers, jitter sur tâches automatiques).
4. **Privacy Pass RSA Blind Signatures (RFC 9578 `0x0002`)** avec registre anti-double-dépense partagé minimal et réservation/remboursement anti-perte.

### Limites résiduelles communiquées honnêtement

1. **Confiance matérielle et attaques physiques** : l'attestation repose sur les racines matérielles d'AMD, d'Intel et de NVIDIA, et sur Azure en plus sur le paravisor de Microsoft. Sur H100, la HBM est isolée mais non chiffrée. Un attaquant qui a un accès physique au serveur peut, avec un matériel peu coûteux (TEE.fail), lire les sessions de cette machine. C'est la principale différence avec Apple PCC, qui conçoit ses propres serveurs et contrôle leur chaîne physique.
2. **RCE dans le runtime d'inférence (A5)** : une vulnérabilité 0-day dans le moteur ou le pilote GPU permettrait à un attaquant d'accéder aux requêtes en cours et suivantes sur ce worker jusqu'au recyclage et de les exfiltrer via la réponse d'une requête qu'il envoie lui-même. L'isolation du frontal HPKE, le cloisonnement des workers, `seccomp`, l'absence de disque et le recyclage fréquent réduisent l'impact sans l'annuler.
3. **Quorum de signature et chaîne de mise à jour client** : celui qui publie l'app Sondine peut publier une version qui ne vérifie plus rien. L'app est donc, comme chez Apple, dans la base de confiance ; ses versions doivent être reproductibles ou au moins inscrites au journal de transparence. Tant que Téo est seul mainteneur, un quorum de 2 sur 3 n'existe pas vraiment. Plus largement, la sécurité contre une image malveillante repose sur l'indépendance des détenteurs du quorum de signature et sur l'auditabilité publique de l'application Sondine (open source AGPL-3.0, signée Developer ID, ADR 010) et du journal Rekor.
4. **Métadonnées visibles par le relais OHTTP et corrélation à faible trafic** : le relais OHTTP voit l'IP du Mac, les horaires et volumes chiffrés. Une collusion entre le relais et Synapsr (ou une double réquisition coordonnée) pourrait corréler des requêtes, particulièrement au lancement lorsque peu d'utilisateurs sont actifs en même temps.
5. **Voix et noms prononcés dans le contenu transmis** : même si le carnet d'identités et les empreintes vocales stockées ne quittent jamais le Mac, l'audio contient les voix réelles et les noms prononcés.
6. **Mode « Votre machine »** : un autre Mac ou une VM GPU Linux _standard_ n'offre pas d'attestation TEE ; la confiance repose sur l'utilisateur qui administre sa machine (et, sur une VM louée non confidentielle, sur l'hébergeur qui conserve l'accès hyperviseur à la RAM).
7. **Non-révocabilité des octets déjà transmis** : une suppression en cours d'envoi annule aussitôt le job côté Mac et empêche toute écriture en base, mais les octets déjà parvenus au serveur dépendent de l'effacement immédiat sur `SESSION_CANCEL` ou, en cas de perte réseau, de l'expiration du TTL mémoire.
