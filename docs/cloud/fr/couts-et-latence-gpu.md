# Coût par heure d'audio et latence selon la machine

_Document de conception ([ADR 040](../../decisions/040-remote-compute.md)), révisé le 2026-11-24. Transcription finale seulement : le journal ne part pas vers un serveur en v1. **Une seule machine NVIDIA a été mesurée par Sondine (RTX 5080, §2).** Les prix Azure viennent de l'API publique d'Azure (Linux, `westeurope`, 24/11/2026) ; le prix du néo-cloud n'est pas vérifié. Rien n'est à annoncer avant un passage de `sondine-bench` sur la machine retenue._

---

## 1. Ce qui est mesuré

Tout porte sur Nemotron 3.5 Transcribe 30B en IQ4_NL (fichier de 19,0 Go).

| Machine                              | Vitesse (× temps réel) | Mémoire                        | Source                                                                     |
| ------------------------------------ | ---------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| Mac M5 32 Go, `speech.cpp` 0.9.3     | **2,7 à 4,3**          | pic 17,1 à 19 Go               | nos mesures (ADR 016, ADR 018), conversations avec locuteurs et horodatage |
| Mac M5 32 Go                         | 5,4 à 8,5              | 17,2 Gio                       | [auteur de `speech.cpp`][page], phrases courtes                            |
| NVIDIA H100 80 Go, Vulkan            | 13 à 26                | 18,4 Gio de VRAM               | [auteur de `speech.cpp`][page], phrases courtes                            |
| NVIDIA RTX 2080 8 Go + Core i9-9900K | 2,1 à 2,8              | 6,1 Gio de VRAM + 13 Go de RAM | [auteur de `speech.cpp`][page]                                             |

Sur M5, nos conversations vont environ deux fois moins vite que les phrases courtes de l'auteur. Nous prenons donc **7 à 25 × pour un H100**, un seul flux.

L'ancienne version de ce document supposait 40 à 60 × par flux et 75 × au total. Les mesures publiées la contredisent : **les coûts du cloud confidentiel sont plus élevés qu'annoncé**.

Deux voies pourraient les réduire, à mesurer :

- **Plusieurs requêtes à la fois** : `speech.cpp` n'a pas été mesuré ainsi.
- **vLLM 0.32 et le module NeMo Speech de NVIDIA**, le service officiel du modèle, prévu pour un GPU de 80 Go.

Une version plus grosse n'est pas prévue. Sur 100 phrases en anglais (FLEURS), l'auteur mesure 8,77 % d'erreurs en IQ4_NL (19 Go), 8,64 % en Q8_0 (35,8 Go) et 8,73 % en F16 (67,4 Go). Le français et la séparation des voix n'y sont pas mesurés.

**Réseau :** 35 à 50 Mo par heure de parole en FLAC, soit 3 à 5 s d'envoi à 100 Mbit/s, 30 à 40 s à 10 Mbit/s.

---

## 2. Bêta sur un serveur de Synapsr

Machine mesurée le 2026-11-24 : une **RTX 5080 (16 Go)** et 32 Go de RAM, sous Linux, avec 13,5 Go libres sur la carte. `speech.cpp` 0.9.3 en Vulkan garde 13 couches d'experts sur 23 sur la carte, et le processeur calcule les 10 autres.

- **Vitesse mesurée : 6,6 × le temps réel sur 45 minutes** (412 s), 8,4 × sur 10 minutes (71 s), 4,1 × sur 1 minute, avec locuteurs et horodatage. Une heure d'audio prend donc environ **9 minutes**, plus 19 à 21 s de chargement si le modèle n'est pas déjà prêt. `speech.cpp` 0.11.2 fait 8,8 × sur 10 minutes.
- **Conditions :** conversation française de synthèse à deux voix, une seule passe par durée, sans enregistrement réel. Les deux voix sont bien séparées. Des conversations réelles peuvent aller moins vite.
- **Mémoire :** au pic, 15,4 Gio sur les 15,9 Gio de la carte (autres programmes compris), et 9,2 Go de RAM. Il ne reste presque rien pour un autre usage du GPU pendant le calcul.
- **Capacité :** 10 personnes à 1,6 h par jour ouvré demandent ~2 h 25 de calcul par jour. En gardant la machine libre les trois quarts du temps, elle en servirait environ 25. La file reste le point faible : une requête à la fois.
- **Partage :** si d'autres services occupent la carte, le moteur met plus d'experts en RAM et ralentit.
- **Processeur seul :** les serveurs sans GPU peuvent faire tourner la version Linux pour processeur. Vitesse inconnue.
- **Coût :** rien à louer. Il reste l'électricité et le temps d'exploitation. Ni redondance, ni garantie : pendant une coupure, les conversations attendent sur le Mac.

---

## 3. Cloud confidentiel (GPU H100 attesté), plus tard

| Offre (H100 confidentiel)   | Prix      | Coût par heure d'audio à 60 % d'utilisation | À 25 %        |
| --------------------------- | --------- | ------------------------------------------- | ------------- |
| Néo-cloud TEE (non vérifié) | ~3,08 $/h | 0,21 à 0,73 $                               | 0,49 à 1,76 $ |
| Azure UE, réservé 3 ans     | 4,90 $/h  | 0,33 à 1,17 $                               | 0,78 à 2,80 $ |
| Azure UE, réservé 1 an      | 6,67 $/h  | 0,44 à 1,59 $                               | 1,07 à 3,81 $ |
| Azure UE, à la demande      | 8,90 $/h  | 0,59 à 2,12 $                               | 1,42 à 5,09 $ |

Coût = prix horaire ÷ (vitesse × utilisation), vitesse de 7 à 25 ×, un flux, sans le surcoût du mode confidentiel de NVIDIA. Il faut deux nœuds pour la redondance.

**Le moteur n'est pas acquis en mode confidentiel.** `speech.cpp` est publié pour Vulkan et pour le processeur sous Linux ; sa version CUDA se compile, mais [son auteur ne la vérifie pas][install]. NVIDIA liste l'interopérabilité CUDA/Vulkan parmi les fonctions [incompatibles avec le mode confidentiel][cc] et nous n'avons trouvé aucune prise en charge de Vulkan dans ce mode. À essayer : `speech.cpp` compilé pour CUDA, puis vLLM.

[page]: https://github.com/nyosegawa/speech.cpp/blob/v0.11.2/docs/models/nemotron-transcribe.md
[install]: https://github.com/nyosegawa/speech.cpp/blob/v0.11.2/docs/install.md
[cc]: https://docs.nvidia.com/confidential-computing/release-notes/r570-trd1.md
