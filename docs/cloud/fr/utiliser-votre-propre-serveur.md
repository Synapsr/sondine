# Utiliser votre propre machine (`sondine-compute`)

_Guide de ce qui est construit ([ADR 040](../../decisions/040-remote-compute.md), 2026-11-24)._

Si vous avez un PC Linux avec une carte NVIDIA, ou un autre Mac de 32 Go, il peut transcrire pour un Mac trop petit. C'est gratuit, sans serveur à nous, et désactivé tant que vous ne le choisissez pas.

- **Seul l'audio des conversations terminées part**, voix et noms prononcés compris. Le texte revient sur votre Mac. Les empreintes de voix, vos personnes et votre base restent sur le Mac, et le serveur ne reçoit jamais votre journal, écrit sur le Mac sauf si vous avez choisi Claude.
- **Tout est chiffré jusqu'au programme**, quel que soit le réseau (Noise NK). Le programme n'archive ni audio ni texte.
- **Il garde, par Mac,** une empreinte de son jeton, le nom que vous lui avez donné, la date d'ajout et du dernier usage, et les secondes transcrites dans le dernier mois d'usage, jusqu'à `remove`.
- **Les zones privées qui ne gardent pas de texte ne partent jamais**, même avec « Transcrire maintenant ».
- **Qui administre cette machine peut techniquement lire** ce qu'elle calcule, agents IA avec Docker ou `sudo` compris. Sur une VM louée, l'hébergeur aussi.

---

## Quelle machine pour quel modèle

Sondine utilise **Nemotron 3.5 Transcribe 30B en IQ4_NL** (19,0 Go). Sur 100 phrases en anglais, les versions plus grosses ne font pas mieux (8,64 à 8,77 % d'erreurs pour les trois, [mesures de l'auteur](https://github.com/nyosegawa/speech.cpp/blob/v0.11.2/docs/models/nemotron-transcribe.md)) ; le français et la séparation des voix n'y sont pas mesurés. C'est le compromis retenu.

| Machine                                    | Nemotron 30B                          | Vitesse (× temps réel)                          | Notre avis                      |
| ------------------------------------------ | ------------------------------------- | ----------------------------------------------- | ------------------------------- |
| Mac Apple Silicon 8, 16 ou 24 Go           | Non                                   | —                                               | 32 Go exigés (24 Go non validé) |
| **Mac Apple Silicon 32 Go ou plus**        | Oui, entier sur le GPU                | 2,7 à 4,3 sur M5 _(mesuré)_                     | **Recommandé, le plus simple**  |
| PC Linux, NVIDIA 8 Go + 32 Go de RAM       | Oui, 18 couches sur 23 en RAM (13 Go) | 2,1 à 2,8 sur RTX 2080 _(mesuré par l'auteur)_  | Minimum                         |
| PC Linux, NVIDIA 12 Go + 32 Go de RAM      | Oui, ~12 couches en RAM (~9 Go)       | non mesuré                                      | Correct                         |
| PC Linux, NVIDIA 16 Go + 32 Go de RAM      | Oui, 6 à 10 couches en RAM (4 à 7 Go) | 6,6 à 8,4 sur RTX 5080 _(mesuré, 10 et 45 min)_ | Bon                             |
| **PC Linux, NVIDIA 24 Go ou plus**         | Oui, entier sur la carte (18,4 Gio)   | non mesuré (13 à 26 sur H100)                   | **Le plus rapide chez soi**     |
| PC ou serveur Linux sans GPU, 32 Go de RAM | Possible                              | inconnue                                        | À essayer seulement             |
| Carte AMD ou Intel (Vulkan)                | Possible                              | inconnue                                        | Non vérifié par l'auteur        |

La carte a besoin d'environ 3,7 Go libres, plus 0,72 Go par couche d'experts qu'elle garde ; le reste va en RAM. **Si moins de 3,7 Go sont libres, le chargement est refusé.** Sur un Mac de moins de 32 Go, Sondine garde en local le texte en direct et les dictées (Parakeet).

---

## Installer le serveur (Linux)

Il faut Linux x86-64 (glibc 2.34 ou plus), Node 24, le pilote NVIDIA, `libvulkan1` et 25 Go de disque. Les commandes exactes (moteur, modèle, service au démarrage) sont dans [`apps/compute/README.md`](../../../apps/compute/README.md). Le serveur vérifie l'empreinte du modèle à chaque démarrage et refuse un autre fichier.

Faites-le écouter sur son adresse **Tailscale** (`tailscale ip -4`) : rien n'est exposé sur Internet. Sur un réseau local, son adresse locale convient aussi.

## Connecter un Mac

1. Sur la machine : `node sondine-compute.js add "Mac de Marie" --endpoint http://100.x.y.z:8443`.
2. Copiez la ligne affichée. Elle contient le jeton de ce Mac : envoyez-la comme un mot de passe.
3. Dans Sondine : **Réglages ▸ Transcription ▸ Votre machine**, collez la ligne, **Connecter**.

`list` montre les Mac et leurs heures du mois ; `remove` retire un accès aussitôt. Dans Sondine, **Ce Mac** arrête ce qui part, et **Oublier cette machine** efface le lien.

## Un autre Mac comme serveur

Le même programme, avec l'archive macOS de `speech.cpp` 0.9.3. **Pas encore essayé.** Évitez un Mac dont Sondine transcrit aussi : deux modèles de 19 Go ne tiennent pas ensemble en 32 Go.

## Au quotidien

- **Machine éteinte ou hors ligne :** les conversations attendent sur le Mac, et Sondine réessaie de plus en plus rarement (30 secondes à 15 minutes), sans les compter comme échouées. « Transcrire maintenant » réessaie tout de suite. Les durées de conservation continuent de courir : « Garder l'audio » protège une conversation.
- **Plusieurs Mac :** une demande à la fois, chacun son tour.
- **Suppression :** ce qui part s'arrête en une seconde environ. Ce qui est déjà parti ne se rappelle pas ; le serveur l'oublie à l'annulation, ou dix minutes après avoir entendu votre Mac ou fini de transcrire.
- **Réseau :** l'audio part sans compression, environ 115 Mo par heure (1 min 30 à 10 Mbit/s).
- **Carte :** le modèle la libère après trois minutes sans demande.
