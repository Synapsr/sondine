# iPhone app: screens and journeys

In words. Decisions are in ADR 008, 031 and 032, the system in
architecture §12, the order in plan.md § M5. Since U9 (2026-11-23) the
screens wear the Mac's look (ADR 037, `docs/ux-redesign.md` « iPhone »);
a debug build launched with `-SondineDemo` shows them on invented data. Each screen says the
step that brings it. Interface words are French here, as Téo reads them;
the app ships in French and English. GUI.md applies when the screens are
drawn.

The app has one main screen and few others. No tabs: recording is the
first thing, everything else is one touch away.

## Screens on the phone

### 1. Première ouverture (M5.1)

Three short pages, once, as the Mac's first run: the steps as a bar across
the top, each page centered, a title and one sentence, « Retour » on the
left:

- What Sondine does on the phone: it records when asked, and the Mac
  transcribes.
- What is recorded: every voice nearby, not only the user's; asking people
  is the user's responsibility where the law requires it. Nothing leaves
  the phone except to the user's own Mac.
- « Autoriser le micro »: iOS asks for the microphone here, not before.

### 2. Accueil (M5.1)

- « Enregistrer », floating at the bottom of the list. Why it did nothing
  shows above it.
- The list of recordings, newest first, grouped by day (« Aujourd'hui »,
  « Hier », « Vendredi 20 novembre »). A row, as on the Mac's Today: the
  hour, a tile, the name (else whom the Mac heard), the length, and one
  line: the first journal line once transcribed, else one state:
  « Sur le téléphone », « Envoi… 40 % », « En attente du Mac »,
  « Transcription… », « Interrompu ». The tile moves while it is sent or
  transcribed.
- While paired, « Journal du jour » on top, with the day's first journal
  line from the Mac; it opens « Aujourd'hui ».
- From M5.2, a small mark for the Mac: reachable or not, touched to open
  « Mac ». From M5.4, a search field and « Aujourd'hui ».
- In the last 14 days of a build: « Cette version expire dans 9 jours ».
- A gear opens « Réglages ».

### 3. Enregistrement en cours (M5.1)

- The elapsed time, large; the last seconds' level as bars, which freeze
  and fade at an interruption;
  the microphone in use when it is not the phone's own (« AirPods »).
- « Arrêter », round, which needs no confirmation: the recording is kept.
- No pause button: stopping and starting again makes a second recording of
  the same session, which is what an interruption makes too.
- After an interruption: « Interrompu à 14:32 par un appel » and
  « Reprendre ».
- Low space: « Plus que 400 Mo libres », then the recording stops cleanly
  and says why.

### 4. Un enregistrement (M5.1, then M5.3)

- M5.1: the name as the page's title (typed in place), then one line:
  the day, hour and length, and the state until transcribed. « ··· »
  holds « Partager… » (the share sheet: AirDrop, Fichiers),
  « Ajouter une note… », « Renommer » and « Supprimer… ». Playback, with
  its progress, from the phone's own file while it still has it.
- M5.3, once « Transcrit »: the transcript by sentences with the voices as
  the Mac names them (« Marie ? » stays a question: it is answered on the
  Mac); the journal lines and commitments that cite it, each opening its
  sentence; « Ajouter une note »; playback streamed from the Mac, and
  « Le Mac n'est pas joignable » instead when it is not.
- « Supprimer… » asks once and says where it deletes. Before pairing
  (M5.1): « Supprimé de ce téléphone. Si vous l'avez déjà envoyé au Mac,
  supprimez-le aussi là-bas. » Once paired (M5.2): « Supprimé du téléphone
  maintenant, et du Mac à la prochaine synchro. »
- « Conflit » (M5.2), rare: the Mac holds another recording under this
  id. The phone keeps its file and offers « Partager… ».
- From M5.7: « Aussi enregistré par le Mac ».

### 5. Mac (M5.2)

- Not paired: what pairing is, then « Scanner le code » (the camera is
  asked for here). Before the scan, one screen explains that iOS will ask
  for the local network and why.
- Pairing: the six digits to compare with the Mac's, then « En attente de
  la confirmation sur le Mac ».
- Paired: the Mac's name, « Joignable » or « Vu pour la dernière fois
  hier à 19:04 », the last sync, what waits, « Synchroniser maintenant »,
  and « Oublier ce Mac… », which says what it erases (the results fetched,
  and the deletions, names and notes not yet sent) and what it keeps
  (recordings not sent).
- A version the Mac does not know: « Mettez à jour Sondine sur le Mac »
  or « … sur l'iPhone », with both versions.
- From M5.5: whether the Mac was reached at home or through Tailscale.
- Revoked from the Mac: « Ce Mac a retiré l'accès de ce téléphone », with
  what was erased.

### 6. Chercher (M5.4)

- A field; results as on the Mac: the sentence, who said it, the day, the
  kind of conversation, a phone mark on phone recordings.
- A result opens the conversation's text at that sentence. Read only.
- Without the Mac: « Le Mac n'est pas joignable. La recherche lit sa
  mémoire en direct. »

### 7. Aujourd'hui (M5.4)

- As the Mac's Today: the day's conversations with their journal lines,
  then the open commitments (late first), each opening the sentence it
  cites; previous and next day by the arrows or a sideways swipe.
- Read only in M5: marking a commitment done stays on the Mac.

### 8. Réglages (M5.1)

Rows with an icon and their state, as the Mac's settings:

- The version, its build, and when it expires.
- Room taken by recordings that wait.
- From M5.2: the Mac (a shortcut to screen 5).
- « À propos »: licences, what the app sends and to whom (nothing but to
  the user's Mac).

### Outside the app

- **Notification** (M5.1, local, no push service): « Enregistrement
  interrompu à 14:32 », which opens the app on « Reprendre »; from M5.6
  its own « Reprendre » opens the app and resumes at once.
- **Live Activity** (M5.6): the elapsed time on the Lock Screen and in the
  Dynamic Island, « Arrêter », and the interrupted state (« Interrompu à
  14:32 », the counter stopped, « Reprendre »). With no news from the app
  for 5 minutes while recording (it was killed): « Sondine ne répond
  plus ». Near iOS's 8 hour limit a new one takes over; when iOS refuses
  it, a notification says « Sondine enregistre toujours » once the
  recording is seen to go on.
- **Control** (M5.6): « Enregistrer » for the Lock Screen, Control Center
  and the Action button, a toggle: on starts (or resumes an interrupted
  recording), off stops. If iOS refuses to start the microphone from
  there, it opens the app, which starts the recording; if the app cannot
  open, a notification says why.

## Screens on the Mac

- **Réglages ▸ Téléphone** (M5.2): « Synchronisation avec l'iPhone »;
  « Appairer un iPhone… » (the QR, the six digits, « Appairer »); each
  phone with its name, last contact, what it did (counts) and
  « Révoquer »; « Réinitialiser l'appairage »; from M5.5 « Autoriser par
  Tailscale », with what then leaves the house.
- **Aujourd'hui, a conversation, search**: a phone mark on phone
  recordings (M5.1); « Aussi enregistré par le téléphone » (M5.7).
- **Importés**: unchanged; phone recordings are not listed there.

## Journeys

1. **First recording, no Mac nearby** (M5.1). First run, microphone
   allowed, « Enregistrer », lock the phone, an hour later « Arrêter ».
   The row says « Sur le téléphone ».
2. **Handing it over by AirDrop** (M5.1). « Partager… », AirDrop to the
   Mac, drop the file on Sondine. It appears in Today at the hour it was
   recorded. Sent a second time, nothing new appears.
3. **Pairing** (M5.2). On the Mac, « Appairer un iPhone… »; on the phone,
   « Scanner le code », allow the local network, compare six digits,
   « Appairer » on the Mac. The recordings that waited start to go.
4. **An ordinary day** (M5.2, M5.3). Record a meeting outside. At home,
   open the app: « Envoi… », « Transcription… », « Transcrit »; the audio
   leaves the phone. From M5.3, read it and rename it there.
5. **A call during a recording** (M5.1). The call is answered: the
   recording stops there. After the call, a notification; a touch opens
   « Reprendre ». On the Mac: two recordings of one session, nothing
   missing but the call.
6. **The Mac is off** (M5.2). Record as usual; rows say « En attente du
   Mac ». From M5.3, what was fetched before reads fine; from M5.4,
   search says it needs the Mac.
7. **Deleting on the phone** (M5.2). « Supprimer… », confirm: gone from
   the phone; the Mac deletes it at the next contact, as its own
   « Supprimer » does.
8. **Deleting on the Mac** (M5.2). The phone removes its copy the next
   time the app is open near the Mac.
9. **Away, with Tailscale** (M5.5). On cellular, open the app: it reaches
   the Mac through the tunnel, sends, and shows the transcript minutes
   later.
10. **A lost phone**. On the Mac, « Révoquer ». The phone can read and
    send nothing more. What it had fetched (30 days of its own recordings
    at most) stays on it, behind its passcode: the Mac cannot erase a
    phone it does not meet.
11. **The build is about to expire**. The home screen says so 14 days
    before; installing the next build keeps every recording.
