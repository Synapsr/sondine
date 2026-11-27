# 047 — Payer le Cloud Sondine depuis l'app

Statut : **Accepted — 2026-11-27.** Téo veut que la 0.11 ouvre le Cloud « clean, comme Granola ou les autres apps du genre » : une personne installe Sondine, prend 60 minutes gratuites en un clic, s'abonne et gère tout depuis l'app. La conception a été validée le même jour par le fil de coordination, puis construite par Claude Opus 5.5.
Amende : [ADR 040](040-remote-compute.md) (la place de bêta devient une place de vague, avec un essai) et [ADR 002](002-local-only.md) (une question de plus au serveur choisi). Ne change rien à l'[ADR 042](042-usage-statistics.md) : aucun champ nouveau dans le rapport anonyme.

## Contexte

L'ADR 040 a ouvert une bêta gratuite de quelques places sur une machine de Synapsr. La PR n°10 de Loan Talvat y a ajouté des forfaits donnés par l'opérateur à la main (`trial`, `cloud`, recharges). La PR n°1 du site, aussi de Loan, a créé chez Stripe le produit, les prix et le portail client, et un démon de webhook qui appelait la CLI du serveur. Il manquait le parcours dans l'app : voir les places, prendre l'essai, payer, recharger, gérer son abonnement, sans compte et sans que le Mac parle à Stripe.

## Décision

### 1. Une vague, un essai, un forfait

- **La vague.** L'opérateur fixe un nombre de places (`sondine-compute places 10`, sans redémarrer). La Vague 1 commence à 10. Une place est prise par un abonnement en cours, ou un forfait donné par l'opérateur, ou un essai ou un abonnement terminé qui a servi dans les 14 derniers jours. Une place qui n'a pas servi depuis 14 jours ne compte plus, mais n'est pas effacée : son lien, son forfait et ses recharges restent valables.
- **La jauge dit vrai.** L'app montre « Vague 1 : 70 % des places prises », c'est-à-dire `⌊prises × 100 / places⌋` sur les vraies places. Le serveur ne donne aucun nombre. Afficher plus de places qu'il n'y en a, pour faire croire à une rareté, a été refusé, sous toutes ses formes.
- **L'essai : 60 minutes cumulées, en un clic.** Pas de carte, pas de compte. Trois essais par jour au plus depuis une même adresse, et une vague pleine refuse sans en consommer un. Un essai jamais utilisé peut être rendu par le Mac, et il est alors effacé.
- **Le forfait Fondateur.** 19 € TTC par mois pour 40 h ; le tarif normal est de 29 €, et le prix reste à 19 € tant que l'abonnement dure. Les 40 h reviennent à chaque période payée, à la date anniversaire de Stripe et non le 1er du mois. Les heures non utilisées ne se reportent pas.
- **La recharge : 10 h pour 10 € TTC,** réservée aux abonnés, une par achat. Elle ne sert qu'au-delà des 40 h et n'expire pas : après la fin d'un abonnement, la place passe au plan `ended`, 0 h incluse, et garde ses recharges.
- **Un paiement refusé** laisse le service ouvert pendant que Stripe réessaie (`past_due`). Si toutes les tentatives échouent, l'abonnement se termine.
- **Une résiliation** se fait dans le portail Stripe, en fin de période.

### 2. La facturation vit dans `sondine-compute`

- **Même serveur, même tunnel.** Le module de facturation (`apps/compute/src/billing.ts`) ne s'active que si l'opérateur donne une clé Stripe restreinte, le secret du webhook et l'adresse publique. Une machine « Votre machine » ne change pas.
- **Des messages scellés, pas une API REST.** L'app demande par `POST /v1/open`, scellé en Noise NK pour la clé du serveur :
  - `wave` : sans jeton, la part des places prises ;
  - `trial` : sans jeton, une place et son essai ;
  - `quota` : le forfait, les heures et l'abonnement ;
  - `checkout` : la page Stripe d'un abonnement ou d'une recharge ;
  - `portal` : le portail client.

  Le jeton ne quitte jamais le canal chiffré, et l'anti-rejeu, l'horloge et la limite de débit déjà en place s'appliquent.

- **Checkout Sessions, pas Payment Links.** Le serveur crée la session pour la place qui la demande. Stripe connaît la place par une référence aléatoire (`client_reference_id` et métadonnées), jamais par le jeton ni par son hash. Une recharge réutilise le client Stripe et sa carte. La clé restreinte n'a que quatre droits : Checkout Sessions en écriture, Customer portal en écriture, Subscriptions en lecture, Prices en lecture.
- **Le webhook est une route du serveur** (`POST /v1/stripe`), et non plus un démon à part. Il vérifie la signature à 300 s près et note chaque événement traité, pour ne jamais le traiter deux fois. Une recharge n'est jamais créditée deux fois pour une même session. L'abonnement est toujours relu chez Stripe, parce que les événements arrivent dans le désordre. Une erreur de Stripe répond 500, pour que Stripe renvoie l'événement.
- **Un seul processus écrit l'état des places.** Le serveur écrit `usage/`, `billing/` et les événements traités. Le forfait payé se déduit de `billing/` : un paiement ne réécrit jamais `clients/`, qui reste à la CLI. Ça supprime l'écriture concurrente que la PR n°10 laissait entre la CLI et le serveur.
- **L'ancien `claim`** est refusé dès qu'une vague est ouverte. Une app 0.10 dit alors « La bêta est fermée », au lieu de prendre une place qu'elle ne saurait pas payer. Les places de bêta déjà prises (l'équipe) continuent, hors de la jauge.

### 3. L'app n'appelle jamais Stripe

- **Le bouton ouvre le navigateur.** « S'abonner », « Ajouter 10 h » ou « Gérer l'abonnement » demandent l'adresse au serveur, et `core` vérifie que c'est `https://checkout.stripe.com` ou `https://billing.stripe.com`. `main` l'ouvre alors dans le navigateur (`shell.openExternal`), jamais dans la fenêtre.
- **Le retour.** Stripe renvoie le navigateur vers `/billing/done` ou `/billing/back` du serveur : une page FR/EN sans script, sous la politique de sécurité `default-src 'none'`.
- **L'app se met à jour seule.** Après l'ouverture d'une page Stripe, la fenêtre relit le forfait toutes les 5 s pendant 15 min au plus, et quand elle revient au premier plan. Dès que le serveur annonce des heures, ce qui attendait parce que le quota était épuisé repart (`scheduler.hoursLeft`).
- **Les textes.** Les cinq procédures sont réservées à la fenêtre (`mcp: null`) : un agent ne peut ni payer ni ouvrir le portail. Leurs événements d'usage valent `never`, comme `compute_beta_joined` : sur dix places, chacun serait reconnaissable.

### 4. Ce que Synapsr sait, et le dit

- **Une place payée n'est pas anonyme pour Synapsr.** Avec ses identifiants Stripe, l'opérateur peut retrouver dans le tableau de bord de Stripe le nom, l'e-mail et l'adresse de l'acheteur. L'essai ne garde rien de Stripe.
- **Des agents logiciels administrent la machine qui transcrit.** C'est la décision de Téo, le 2026-11-27 : OpenBot et 8 agents logiciels de Synapsr gardent `sudo` et Docker sur `synapsr`, qui fait aussi tourner d'autres services. L'app, `/cloud`, `docs/network.md` et les textes du site disent qu'ils pourraient techniquement accéder à l'audio et au texte pendant la transcription. Aucun texte ne dit « dédié ».
- **Une place est une personne, pas un Mac.** La sauvegarde de l'ADR 048 emporte le jeton : deux Mac de la même personne peuvent partager une place, et donc son quota. Le serveur compte ce qu'un Mac a en cours contre l'autre (c'est testé).
- **Un Mac perdu, sans compte.** L'opérateur donne un nouveau lien à la même place (`sondine-compute rekey`), et l'ancien cesse de marcher.

### 5. Le droit de la consommation

- **Rétractation.** Au paiement, la personne demande que le service commence tout de suite. Si elle se rétracte dans les 14 jours, elle paie la part déjà fournie (article L.221-25 du Code de la consommation). Le texte d'acceptation de Checkout le dit, en français et en anglais (`CONSENT`, `billing.ts`).
- **Pas de médiateur de la consommation.** C'est la décision de Téo, le 2026-11-27 : « on oublie, c'est pas important ». Il a entendu le risque : l'article L.612-1 impose à un professionnel qui vend à des particuliers de proposer un médiateur, et l'article L.641-1 prévoit une amende administrative en cas de manquement. Le site retire l'emplacement `MEDIATOR` et son blocage. À revoir si le Cloud s'ouvre au-delà des premières vagues.

## Conséquences

- La 0.11 contient tout le parcours. L'opérateur ouvre la vague avec `places 10`, en donnant au service les trois variables Stripe.
- Mesuré en mode test, avec la clé restreinte (2026-11-27) : essai, Checkout Fondateur, webhook, portail, recharge, résiliation puis fin, sans aucun 403. Un vrai paiement dans une page Checkout reste à faire par une personne, en test, avant le mode live.
- Stripe Tax est actif en test (siège à Brest, enregistrement France). En live, il faut le même réglage, l'URL des conditions dans les informations publiques du compte, et les mêmes droits sur la clé `rk_live`.
- Le cloud confidentiel de l'ADR 040, avec des jetons Privacy Pass qui séparent la facturation des requêtes, reste la condition d'une ouverture publique. Ici, le serveur de calcul connaît les identifiants Stripe d'une place payée.
