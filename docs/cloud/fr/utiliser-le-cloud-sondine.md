# Utiliser le Cloud Sondine

_Ce qui est construit ([ADR 040](../../decisions/040-remote-compute.md), 2026-11-25 ; [ADR 047](../../decisions/047-cloud-billing.md), 2026-11-27). [docs/network.md](../../network.md) donne la liste complète de ce qui sort et de ce que chacun garde._

Le Cloud Sondine fait la **transcription finale** pour un Mac qui ne peut pas faire tourner Nemotron 3.5 Transcribe 30B. Il est désactivé tant que vous ne l'activez pas, et sans compte. Il ouvre par vagues : la première a dix places, et l'app montre la part des places déjà prises. Chaque place commence par **60 minutes gratuites**, sans carte ; ensuite, le forfait Fondateur coûte 19 € TTC par mois pour 40 heures, et 10 heures de plus coûtent 10 €. C'est un serveur ordinaire de Synapsr, qui fait aussi tourner d'autres services. Il a été mesuré depuis un Mac de 32 Go ; il n'a pas encore été essayé sur un Mac plus petit.

> **Ce n'est pas une ZDR (zéro rétention) vis-à-vis de ceux qui administrent le serveur.** Votre audio est scellé jusqu'au programme, qui le garde en mémoire seulement et l'oublie quand votre Mac a le texte. Mais toute personne ou tout programme qui administre le serveur peut techniquement lire l'audio et le texte pendant le calcul, et rien ne prouve à votre Mac ce que le serveur exécute. Des agents logiciels de Synapsr ont un accès administrateur à ce serveur. Nous nous engageons sur l'honneur à ne pas lire ni écouter vos données, et elles n'entraînent aucun modèle. Si cela ne vous suffit pas, utilisez [votre propre machine](utiliser-votre-propre-serveur.md) ou restez sur votre Mac.

## Ce qui quitte votre Mac

L'audio des conversations terminées : la parole, jusqu'à 1,5 s avant et 0,8 s après, et les courts silences entre les deux. Il contient la voix de vos interlocuteurs et les noms qu'ils prononcent. Les enregistrements de l'iPhone et les fichiers importés partent aussi : les zones privées du Mac ne les couvrent pas.

## Ce qui ne part pas vers le serveur

- Aucun texte, ni votre journal du jour (qui part chez Anthropic si vous avez choisi Claude pour l'écrire ou le relire), ni vos dictées, ni le texte en direct.
- Les empreintes de voix, les noms donnés aux voix, vos personnes, votre base, vos notes et fichiers.
- Ce que vous avez supprimé avant l'envoi.
- Les enregistrements d'une zone privée qui ne garde pas de texte (« Rien », « Audio uniquement »), même avec « Transcrire maintenant ». Une zone « Texte uniquement » est transcrite, donc envoyée.

## Ce que les autres gardent

- **Le programme du serveur, en mémoire :** l'audio jusqu'à la transcription, le texte jusqu'à ce que votre Mac l'ait, dix minutes au plus.
- **Le programme du serveur, sur disque, pour votre place :** une empreinte de son jeton, sa date de création, la date de la dernière transcription comptée, les secondes transcrites dans la période (le cumul pour l'essai). Si vous vous abonnez : une référence aléatoire de la place chez Stripe et vos identifiants de client et d'abonnement Stripe, avec lesquels Synapsr peut retrouver dans Stripe qui a payé. Un essai jamais utilisé, rendu, est effacé ; sinon la place reste jusqu'à ce que l'opérateur la retire, à votre demande.
- **Le journal du serveur :** l'heure et la nature de chaque événement. Ni contenu, ni durée, ni place, ni adresse.
- **Cloudflare**, qui transporte la connexion : votre adresse IP, les horaires et les volumes, jamais le contenu. Il transmet l'adresse au serveur, qui en garde une empreinte salée en mémoire pour limiter le nombre d'essais par adresse.
- **Stripe**, si vous payez, dans votre navigateur : votre e-mail, votre adresse de facturation, votre carte et, si vous le donnez, votre numéro de TVA. Sondine ne parle jamais à Stripe.

## Activer et désactiver

1. **Réglages ▸ Transcription ▸ Cloud Sondine**, ou le même choix au premier lancement d'un Mac de moins de 32 Go. L'écran montre la part des places prises : pour cela, l'app pose la question au serveur, sans rien envoyer d'autre.
2. Lisez ce qui part, puis **Essayer 60 min gratuites**. Sondine prend une place pour vous ; s'il n'en reste pas, l'app le dit et propose d'être prévenu de la vague suivante.
3. Dans **Réglages ▸ Transcription**, la carte du Cloud montre vos minutes ou vos heures. **S'abonner**, **Ajouter 10 h** et **Gérer l'abonnement** (carte, factures, résiliation) ouvrent la page de Stripe dans votre navigateur ; Sondine se met à jour seul une fois le paiement fait.

**Ce Mac** arrête ce qui part et garde votre place. Un abonnement se résilie dans le portail Stripe, en fin de période ; vos heures de recharge restent ensuite utilisables. Une place correspond à une personne : un second Mac restauré depuis votre sauvegarde partage les mêmes heures.

## Au quotidien

- **Hors ligne, ou serveur occupé :** les conversations attendent sur le Mac et Sondine réessaie de plus en plus rarement (30 secondes à 15 minutes). « Transcrire maintenant » réessaie tout de suite. Les durées de conservation continuent de courir : « Garder l'audio » protège une conversation.
- **Limites :** une demande à la fois pour tout le monde, chacun son tour ; 60 minutes pour l'essai, puis 40 heures par période payée, plus vos recharges. Quand elles sont épuisées, les conversations attendent sur le Mac et partent dès que des heures reviennent.
- **Réseau :** environ 115 Mo par heure d'audio, sur toute connexion, partage de connexion compris.
- **Suppression :** ce qui part s'arrête en une seconde environ. Ce qui est déjà parti ne se rappelle pas ; le serveur l'oublie quand votre Mac le dit, ou dix minutes après avoir entendu votre Mac ou fini de transcrire.
- **Les dictées** continuent sur votre Mac pendant ce temps, et le journal là où vous l'avez choisi.

## Plus tard

Un cloud confidentiel, où le matériel prouverait à votre Mac ce que le serveur exécute, est **conçu, pas construit** ([modèle de menace](../threat-model.md)). L'ouverture publique l'attend. Rien de cette conception ne décrit la bêta.
