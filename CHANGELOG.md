# Changelog

## 0.11.0 — 2026-11-28

Back up all of Sondine in one file, and transcribe in the Sondine Cloud: 60 free minutes, then a plan paid in your browser.

### New

#### Back up all of Sondine in one file, and get it all back at once

Settings ▸ Data saves your conversations, transcripts, voices, people, journal, context and settings to one `.sondine` file, protected by a passphrase unless you choose otherwise. After a reinstall or on another Mac, choose « Restaurer une sauvegarde… » and everything comes back. The data it replaces is kept aside, and listening stays paused until you resume it.

#### Try the Sondine Cloud for free, then subscribe from Sondine

Places are limited: Wave 1 opens with 10. Choosing Sondine Cloud shows how full the current wave is and offers 60 free minutes in one click, with no card and no account. In Settings ▸ Transcription you can then subscribe to the Founder plan (19 € a month for 40 hours), add 10 hours for 10 €, and manage your card, invoices or cancellation: each opens Stripe's secure page in your browser, Sondine never talks to Stripe itself, and it updates by itself once you have paid. Transcriptions that waited for hours start again on their own.

#### Join Sondine Cloud with an invite link, and see your remaining hours

If you have a Sondine Cloud invite link or code, paste it during the first run or in Settings ▸ Transcription ▸ Cloud to activate your trial or plan, even when the wave is full. Settings shows how much of your trial or monthly hours (and any top-up hours) remains, and disconnecting a Mac from an invited plan leaves your plan and top-ups intact on the server.

## 0.10.0 — 2026-11-27

Sondine takes the look of its site, shows the logo of the video you heard, and Search gets tighter.

### Improved

#### A new look, as on the site

Sondine takes the look of its site, on the Mac and the iPhone: a sharper Allo, firmer titles, the sky's colors, and a dark mode that is softer, with quieter edges.

#### The logos of YouTube, Vimeo and Twitch

A video heard on YouTube, Vimeo or Twitch shows that site's logo, in its colors, and its name, in Today, in Search and at the top of the recording, instead of your browser's.

#### A tighter search

In Search, the number of recordings found now sits at the end of the search field, and the results start right under the filters.

### Fixed

#### The word you jump to stays readable

In a recording opened from Search, the match you are on was black on black in light mode; it now reads in white on black, and dark on white in dark mode.

#### The chosen option shows in dark mode

In dark mode, the circle of the option you chose shows its dot again, as in light mode.

## 0.9.0 — 2026-11-26

Sondine learns your words, the first run lets you pick the cloud, and your own transcription server runs in Docker.

### New

#### Teach Sondine your words

Add your words in Réglages ▸ Vocabulaire, with a short note if you like (« le nom de mon app »); your People's names are in it already. Sondine writes them your way when a transcript hears a name that sounds the same, and with the journal's model it also catches one that only looks close, like « Sandrine » for « Sondine ». After « Corriger ce passage », it says what it learned, or offers to add a name it could not learn. « Rétablir l'original » always brings back what was heard.

#### Your own server in Docker

On a Linux machine with an NVIDIA card, the server now comes with a Dockerfile and a compose file: speech.cpp and the card in one container, the model read-only, out of swap. Its README gives the commands.

### Improved

#### Choose the cloud from the first run

The first run now asks where to transcribe on every Mac: this Mac, your machine, or Cloud (beta). Then it shows what that choice needs: the model download for this Mac, or what leaves and who could read it for a server, with nothing sent before you agree.

### Fixed

#### Fewer failed recordings on very short noises

A noise of less than a second no longer leaves a recording marked as failed: Sondine now treats it as having no speech. A short recording whose words the model could not place gets a second try, and its transcript comes back with a single voice.

#### Your own server keeps the model as long as you say

`SONDINE_COMPUTE_IDLE_UNLOAD_SEC` now sets how long your transcription server keeps the model after its last request, and `0` keeps it loaded, so a conversation starts at once. The server used to let go of it after three minutes, whatever the setting said. Its README also shows how to bound its memory on a machine that does other work.

## 0.8.0 — 2026-11-25

Sondine's source code is public; it keeps itself up to date when you say yes, and its icon is in the Dock.

### New

#### Sondine keeps itself up to date

Say yes once and Sondine looks for a new version every other day at most, downloads it, checks who signed it, and restarts when nothing is going on and the Mac is idle: never during a call, a recording, a dictation, a transcription or a sync with your iPhone, and it listens again exactly as before. « Redémarrer et mettre à jour » does it sooner, and a note says what is new. Without your yes, nothing is downloaded: check from Réglages ▸ Général. If you had turned on the daily check, Sondine asks you first.

#### Find Sondine in the Dock

Sondine’s icon stays in the Dock and in ⌘Tab while it runs. Click it to open the window; close the window and Sondine keeps listening. Opening Sondine from the Dock, Finder or Spotlight shows its window at once, and opening it at login still shows nothing.

### Improved

#### Updates come from Sondine's public source

Sondine's code is now open to read, build and improve, at github.com/Synapsr/sondine, and its new versions are published there. Install this one to keep hearing about them.

### Fixed

#### New versions are found again

The check for new versions could fail for a whole day behind an address shared with other apps or people, because GitHub limits how often that address may ask. Sondine now reads a public file without that limit, and tells you whether GitHub refused, did not answer, or said something it cannot read.

## 0.7.0 — 2026-11-25

Transcription for Macs too small for the model, on another machine of yours or in a small cloud beta; your calls in the notch; and dictations in the exact words you typed.

### New

#### Transcribe on another machine

A Mac without enough memory for the transcription model can now use another computer of yours: in Réglages ▸ Transcription, choose « Votre machine » and paste the link that machine shows. The audio of finished conversations goes there encrypted and the text comes back; voice profiles, people and your library stay on this Mac, where dictations go on meanwhile. It is off until you turn it on, recordings in private zones that keep no text are never sent (zones do not cover iPhone recordings and imports), and « Ce Mac » stops anything still leaving. A small cloud beta, with a few places taken in one click, is offered in the same place; Sondine says first who could reach the audio there. The daily journal still writes on this Mac, unless you chose Claude, and its model now asks for 16 GB of memory instead of 32.

#### Your calls, in the notch

When a call starts, the notch shows it with a switch: on, Sondine listens to this call; off, it does not, and what you had before comes back when the call ends. The switch stays there for the whole call, so you can change your mind, next to the person Sondine recognizes and your last conversations. Opened, the notch also opens the recording or ends it with « Terminer ». When the call ends, the notch says what was recorded, and when a pause has lasted three hours it reminds you once. On a Mac without a notch, or with a second display, notifications say the same. A call is now announced once, even when the app drops its microphone for a moment.

#### End a recording when you are done talking

A recording in progress now has an « End » button, on its page, on its card in the sidebar and in ⇧⌘P. It ends at once, even if the call goes on, and what is said next starts a new recording. Sondine keeps listening, and ⌘Z takes it back.

#### Check the names that sound wrong

Named the wrong voice? People now has a “To check” list: voices you named that sound much more like someone else. Listen, then keep the name or correct it in one click.

#### Help improve Sondine, only if you want to

Sondine now asks once whether to share anonymous statistics: one report a day, made of counts, such as the features you used, the setup step you reached and errors by code. It never holds a conversation, a name, an identifier or a time. Nothing is counted before you say yes, and « Voir ce qui est envoyé » in Réglages ▸ Confidentialité shows the exact report; turning it off deletes it at once. If something goes wrong, Réglages ▸ Avancé ▸ « Envoyer un diagnostic » shows a short text you can read, then mail or copy yourself.

### Improved

#### Dictations keep the words your dictation app typed

When you dictate with Hex, VoiceInk, Parler or Handy, Sondine now keeps exactly the text the app wrote instead of transcribing it again, for past dictations too. It reads the app's history on this Mac, without changing it, and only for dictations it heard from start to end; the others are transcribed as before. Turn it off for an app in Réglages ▸ Dictées. Superwhisper, Wispr Flow, Aqua Voice, Spokenly, OpenWhispr, FluidVoice and Willow Voice now count as dictation apps without being added.

#### See who it is before you confirm

When Sondine is 99% sure of a voice, its name now shows everywhere, on calls too: “Marie*”. The asterisk means you have not confirmed it yet. One click on ✓ does.

#### Sondine says more exactly what can leave your devices

macOS's permission windows, the iPhone's privacy page and the cloud beta's dialog now say it as it is: audio stays on your Mac unless you choose to send it elsewhere, the iPhone also sends names, tags, notes and searches to your Mac, and the beta's server keeps when your place was last used and how long it transcribed in the month. Models come from Hugging Face.

## 0.6.0 — 2026-11-24

Your own tags on recordings, a notification when a call starts, every voice of a conversation one click away, and a Today that keeps still. The Mac side of the iPhone app ships too, for the testers of its private beta.

### New

#### Tag your recordings

Give any recording your own words to find it again: the tag button in a conversation's header shows your tags, most recent first, and a field to type a new one. Tags show as chips under the title; click one to see every recording with it. In Recherche, the tag chip narrows a search, or lists a tag's recordings on its own, across all days. « Gérer les tags… » at the end of that menu renames, merges and deletes them. Agents connected to Sondine see your tags and can gather every recording with one, for example the notes you tagged « idées ».

#### Hear a voice from its badge, and merge two voices that are one person

A conversation's header now shows one badge per person, with their total speaking time, even when the transcript heard them as two voices. Click a badge to hear the voice right away, jump to any of its passages, and say who it is. A voice nobody knows yet can be merged with another one that is the same person, in two clicks, and ⌘Z undoes it.

#### A notification when a call starts, even while Sondine listens

When a call starts and Sondine is listening, a notification says « Sondine écoute cet appel » with « Ne pas écouter cet appel », which pauses Sondine for that call only: listening comes back on its own once the call ends, even after a restart, unless you paused or resumed yourself meanwhile. « Pas pour <app> » stops these notifications for an app. During a pause, the offer to listen to the call stays as before. The menu bar offers the same thing, and reads « En pause le temps de l'appel <app> » while it lasts. Settings ▸ Écoute has one switch, « Prévenir quand un appel commence », and says when macOS blocks Sondine's notifications or keeps them off the screen, with « Ouvrir les réglages » to allow them.

### Improved

#### Today keeps still, and remembers how you like it

Going to yesterday or an older day no longer moves anything: each day, week and month has the same header, a title with its date under it (« Mercredi », « 18 novembre »), and the controls stay where they are, « Aujourd'hui » included. The floating bar at the bottom is gone: Recherche (⌘K) and a new « Demander » (⌘J) entry live in the sidebar, and « Demander » stays lit while the agent panel is open. Click « Engagements » on Today to fold them to one line with their count. Sondine remembers that, and the Médias and Dictées choices of the day's menu, across launches, for Today and the calendar's day. Médias now shows until you turn it off.

#### Long conversations scroll smoothly, and confirming a voice is instant

A two-hour call now opens about twice as fast and scrolls without freezing, and « ✓ » or « Oui » on a suggested voice shows the name at once instead of after a pause.

### iPhone (private beta)

The iPhone app is in a private beta through TestFlight, by invitation only, and is not on the App Store. What follows is for its testers; the Mac side of each feature is in this version.

#### Record a conversation on your iPhone, and find it on your Mac at the hour it happened

The Sondine iPhone app records when you tap « Enregistrer », for hours with the screen locked. A call or another app taking the microphone closes the file and tells you, and « Reprendre » goes on in a new one; if the app is closed or the battery dies, the recording is kept up to its last seconds. Send it to your Mac with AirDrop or Files and drop it on Sondine: it appears in Today at the hour it was recorded, marked « iPhone », transcribed, in the journal, with voices suggested. Sent twice, it stays one recording; deleted on the Mac, it never comes back. « Oublier les N dernières minutes » and private zones leave it alone, since you started it by hand.

#### Pair your iPhone with your Mac, and your recordings go to it by themselves

On the Mac, Settings ▸ Téléphone ▸ « Appairer un iPhone… » shows a code; on the iPhone, « Mac » scans it, and both screens show the same six digits to compare before you press « Appairer ». Once paired, opening the app at home sends each finished recording to the Mac over your Wi-Fi, picking up where a cut transfer stopped; its row says « En attente du Mac », « Envoi… 40 % », « Sur le Mac », « Transcription… », then « Transcrit », and the iPhone erases the audio only once the Mac holds it. A recording deleted on one side leaves the other at the next sync, and a small Mac mark on the home screen says whether the Mac answers. The Mac lists each paired iPhone with its last contact and what it did; « Révoquer » cuts one off, « Oublier ce Mac… » on the iPhone ends the pairing while keeping what was not sent, and « Autoriser par Tailscale » lets the iPhone reach the Mac away from home. With « Synchronisation avec l’iPhone » off, nothing listens on the network.

#### Sync the iPhone with the Mac from anywhere, through Tailscale

With Tailscale on the Mac and the iPhone, turn on « Autoriser par Tailscale » in Settings ▸ Téléphone and open Sondine once at home: away from home, on cellular or another Wi-Fi, the iPhone now reaches the Mac through Tailscale when it cannot find it at home. Recordings go to the Mac and come back transcribed, as at home. The iPhone's « Mac » screen says « À la maison » or « Par Tailscale », and Settings ▸ Téléphone shows which way each phone came last. Pairing still happens at home only, and turning the switch off cuts the Tailscale path at once.

#### Start and stop an iPhone recording from the Lock Screen or the Action button

Add Sondine's « Enregistrer » control to the Lock Screen, to Control Center or to the Action button: one press starts recording without opening the app, and the next press stops it. While it records, the Lock Screen and the Dynamic Island show the elapsed time with « Arrêter ». After a call they show « Interrompu à 14:32 » with « Reprendre », which the interruption's notification now offers too. If iOS will not start the microphone from there, or Live Activities are off for Sondine, Sondine opens to start it, or a notification says why. Past 8 hours a fresh Lock Screen display takes over when iOS allows it; otherwise a notification says the recording goes on.

#### Read a recording on the iPhone once the Mac has transcribed it

When a recording you made on the iPhone turns « Transcrit », its screen on the iPhone shows the transcript sentence by sentence, with the voices named as on the Mac. A voice Sondine only guesses reads « Marie ? », and an unnamed one reads « Voix 2 ». Below that come the journal lines and commitments that cite the recording; tapping one jumps to its sentence. « Écouter » plays the recording from the Mac over your Wi-Fi without storing the audio on the iPhone, and tapping a sentence plays from there. A name you give the recording on the iPhone and a note you add there reach the Mac at the next sync: the name shows next to the iPhone mark in Today and on the conversation, and the note sits with the conversation's other notes. When the Mac is off, the iPhone still shows what it already fetched, and names and notes wait to be sent. The iPhone keeps these transcripts for recordings from the last 30 days only, and corrections or deletions made on the Mac reach it at the next sync.

#### Search your Mac's memory and read today's journal on the iPhone

At home, with the Mac paired, the iPhone's home screen has a search field: type a word and the iPhone searches everything the Mac transcribed, not only the iPhone's own recordings. Each result shows the sentence with the word in bold, who said it, the day and the kind of conversation, with the iPhone mark on recordings made by a phone; tapping it opens the conversation's text at that sentence, read only. « Aujourd'hui » shows the day's journal lines and the open commitments, late ones first, each with the hour of the sentence it cites, then the day's conversations; the arrows go to previous days. Nothing of this is stored on the iPhone: it is read from the Mac while you look at it and forgotten when you leave the screen or the app. When the Mac cannot be reached, the iPhone says so. Settings ▸ Téléphone on the Mac counts these reads with the others, never what was searched.

#### A meeting your Mac and your iPhone both recorded shows once in your journal

When the iPhone's recording reaches the Mac, Sondine compares its sound with what the Mac heard at the same time and links the two when they are the same meeting, never two rooms at the same hour. Each recording then says « Aussi enregistré par le Mac » or « … par l'iPhone » and opens the other at the same second, and lists and search mark it « aussi sur le Mac ». The journal writes the shared time once, from the clearer recording; « Lire celui-ci au journal » switches to the other. Both recordings stay as they were, and deleting one leaves the other to the journal.

#### Tags and « C'est moi » on the iPhone

When you stop a recording, your recent tags line up under it on the home screen: tap one and it is on. A recording's page shows its tags and « + » to add one, and when Sondine takes its voice for yours, « C'est moi » says so in one tap. Both wait for the Mac when it cannot be reached, and the iPhone needs this version of Sondine on the Mac. A recording made with the iPhone app where the only voice is yours, once you said it is you (« Moi ? » ▸ Oui), now reads « Note » instead of « En personne ».

#### The iPhone app looks and moves like the Mac

The iPhone app now wears the Mac's look: black and white, the same typeface, the same quiet rows. Home lists your recordings by day as Today does on the Mac, each with its first journal line once transcribed, and the day's journal from the Mac sits on top. « Enregistrer » floats at the bottom and opens a calmer recording screen with a large timer, a live level and a round stop button. A recording's page leads with its name and a player; share, note, rename and delete wait in « ··· ». « Aujourd'hui » reads like the Mac's Today and changes day with a swipe, and the first run and Settings are shorter.

## 0.5.0 — 2026-11-19

A new, quieter Sondine: one thread for each day, a calendar you can zoom and swipe through, a page for your commitments, the agent one click away on every screen, and a simpler look in black and white.

### New

#### A calendar

Calendar has its own entry in the sidebar. A week shows your conversations at their hour, with their app's icon, and a small book beside each day opens, in a drawer, what mattered that day. A month shows how long people spoke each day, with that day's journal when you hover it. Zoom between a day, a week and a month with the switch at the top, ⌘− and ⌘+, or by pinching the trackpad, and swipe with two fingers to the day, week or month before or after: the page follows your fingers and the next one springs into place when you let go.

#### Today, in one thread

Today is one thread: each conversation reads its journal line, and media and dictations, when you show them, take their place in it on one line, with their app's icon. Beside it, a month takes you to any day in one click, your open commitments show when there are some, and so do the people of the day. What is being said now sits in the sidebar, on every screen. The Journal screen is gone; its links open Today on the same day.

#### A page for commitments

Commitments has its own entry in the sidebar: every commitment of the last 90 days, the open ones sorted by when they are due (late, in the next 7 days, later, without a date), the done ones a click away to undo one, and a menu to keep those naming one person. Checking one draws its check and strikes its words through before it leaves.

#### Ask the agent from any screen

« Demander » at the bottom of the window, or ⌘J, opens the discussion with your agent beside the screen you are on. It starts from that conversation, day or person and still reads everything else; turn on « Limiter » on its chip to keep it to that one, and Sondine refuses every answer that would show the agent anything outside it. Past discussions are in the panel's « ⋯ ».

#### Teach Sondine your voice by reading a short text

The first run offers « Apprendre ma voix »: read a short text aloud, about half a minute, and Sondine suggests « Moi ? » on your voice from the first day. The same read is in Settings ▸ Voix. Only the voice print is kept, on this Mac: the recording is deleted at once, and « Oublier ma voix lue » erases it.

#### Listen to a call that starts while Sondine is paused

When a Discord, Zoom, FaceTime or Meet call starts and Sondine has been paused for more than a minute, a notification offers to listen to it. « Listen to this call » records that call only and pauses again when it ends; « Resume listening » resumes for good, and « Not for Discord » stops offering that app.

#### Statistics

Settings ▸ Statistiques shows how much speech Sondine heard each of the last 7 days, the week's conversations, where the last 30 days' speech came from, who you talked with most, the words transcribed and how often agents read Sondine. Everything is computed on this Mac.

### Improved

#### A simpler look, in black and white

Sondine uses the Allo typeface on a white window, or black in dark mode, and the main button of a screen is black instead of orange. The title bar is gone: the screen is a rounded card on the sidebar's grey, with back and forward arrows above it and, on the right, listening as a small wave, grey while nobody speaks and light red while speech is heard; a click pauses, its arrow opens the timed pauses and « Garder les 2 dernières minutes ». Search and « Demander » float at the bottom. Spacing, alignment and hover states are tidier everywhere.

#### A first run that starts from what you want to find again

The first run asks what you want to find again (meetings and calls, the whole day, or everything), which sets what Today shows first, never what Sondine records. Its steps rise in one after the other. On a Mac without enough memory for the local transcription model, it says so and offers to be told by e-mail when a cloud transcription is ready, on a page that opens in your browser; Sondine itself sends nothing.

#### Settings, simpler

Settings is a short list of sections, each opening its own page, with the current language, appearance and journal state at a glance. The explanations are shorter and still say what stays on your Mac and what leaves it. « Avancé » holds what the Status screen showed.

#### A conversation's page starts with who and what was decided

A conversation is titled by the people in it (« Avec Camille »), with the day's journal lines about it first. Copy, export and sharing are in « Partager », the conversation's own actions in « ⋯ ». A sentence shows a paperclip and one « ⋯ » when you point at it, and a voice Sondine thinks it knows (« Camille ? ») has a ✓ to confirm it in one click.

#### A quieter People screen

People are listed in one card with their initial, the unnamed voices to name behind « Voix sans nom (n) », and a person's own actions in their page's « ⋯ ».

#### Search and imports

The search's date, filters and app menus are chips under the field. Imported recordings no longer have their own screen: Search's « Importé » filter lists them, with « Importer un audio… » beside them. Drop an audio file anywhere on the window to import it, or use the day's « ⋯ » or the command palette (⇧⌘P).

#### Talk over a recording you play back

When you replay a recording on the Mac's speakers, what you say over it is now kept as a conversation, while the recording heard again by the microphone still stays out.

### Fixed

- Transcription no longer stops for good until a restart, and long calls are transcribed in shorter parts instead of failing; a request now says why it waits or what failed.

## 0.4.0 — 2026-11-14

A journal of each day with the commitments you heard, private zones for what Sondine keeps, a discussion with your own Claude about your conversations, and one gesture to keep the last two minutes.

### New

#### A daily journal and the commitments you heard

A new Journal view, in the sidebar, shows « Engagements », what someone owes someone else (« je t'envoie le devis demain », « on se rappelle jeudi »), with who, to whom and by when, and « Ce qui s'est passé », a few lines per conversation on what was discussed and decided, one day at a time. Questions, requests, ideas, plans of your own and things done on the spot are left out. On today's page, the Journal lists first what you promised and what you were promised in the last week; other people's promises and older ones wait behind one line each. The Today screen says how many of yours are still open, and which are late, in one line that leads there. A small language model writes both on your Mac, after transcription, on power and while the Mac is idle, never at the same time; you download it from Settings ▸ Journal du jour (Qwen3.5 9B, 5.7 GB), and nothing leaves the Mac. If you use Claude Code, you can choose there to have your own Claude read each commitment again, or write the journal itself, once you have agreed to what it sends; « Réécrire ce jour » writes a day again, to compare. Every line ends with the time of the sentence it comes from: hover to read it, click to hear it. Tick a commitment when it is done, say it is not one, or correct a line: your word holds when the journal is written again. « Écrire maintenant » writes a day without waiting. Deleting a passage or a recording deletes what was written from it, and agents can read the journal and the commitments.

#### Private zones: one place for what Sondine keeps

Settings ▸ Confidentialité gathers everything that decides what Sondine keeps. By default it keeps everything; each private zone takes something away: « Rien » (nothing is recorded, or it is deleted when it ends, before any transcription), « Texte seul » (the audio goes once transcribed), « Audio seul » (never transcribed), or « Effacé après » a day or a week. A zone can be an app (its sound, its calls and dictations, your microphone included), a site, the network you are on (without asking for your location), hours such as « La nuit », every call, or the screen locked. Films, series and music sites are a zone from the start, as before. The audio of each recording now stays 90 days for calls and conversations, 30 days for moments, and 7 days for media, traces and dictations, counted from this update; the text stays. « Garder l'audio » in a recording's « ⋯ » keeps it past every duration.

#### Ask an agent about your conversations, in Sondine

« Discussion » lets you ask Claude about what was said: « quand doit-on rappeler pour le devis ? », « qu'a dit Marie jeudi ? ». It uses your own Claude subscription through the Claude Code installed on your Mac: no API key to paste. Pick the model and how hard it thinks under the box. The agent searches and reads your conversations with the same read-only tools as outside agents, shows each read it made, and links every conversation it cites so one click opens it at that moment. It is off until you turn it on in Settings, which says what leaves the Mac: what you write and what the agent reads go to Anthropic, and nothing is sent before you send a message. Discussions stay on your Mac from one launch to the next, each one deletable; deleting a conversation, a passage, a person or a note erases the discussions whose agent read it.

#### Keep the last 2 minutes

Something worth keeping was just said? « Garder les 2 dernières minutes » in the menu bar, or ⌃⌥⌘K from any app, keeps everything Sondine heard in the last two minutes, and the menu bar says so for a moment. The audio stays past every duration, the disk limit and the private zones that would take it away, as « Garder l'audio » does for a whole recording, even when the conversation is still going on or no one spoke. The recording shows « Gardé à 14:32 » in Today and on its page; « Ne plus garder » in its « ⋯ » lets it go. When Sondine was paused, or a private zone kept it from recording, there is nothing to keep, and the menu bar says that too. The same item is in the sidebar's pause menu.

#### Add notes, links, images and files to a conversation

Paste (⌘V) or drop anything on a conversation, or use the paperclip beside its title: Sondine tells a link from a note, an image from a file, and shows them in a « Contexte » strip at the top. Drop on a sentence, or use its paperclip, to pin it there with a small pin in the transcript. From any other app, ⌃⌥⌘V adds what you copied to the conversation going on, and the menu bar says where it went. An audio file gets « Transcrire », which transcribes it with its voices in « Importés ». Sondine keeps its own copy of each file, never loads anything from a link, finds the conversation by its notes, links and file names, and puts the context in Markdown and JSON exports; agents see it too, images and PDFs included. Deleting the conversation or the pinned passage deletes what was attached, transcriptions included, and ⌘Z brings back an item you removed.

#### See which web page a video or a song came from

Turn on « Savoir quelle page joue le son » in Settings ▸ Navigateurs and add Sondine's extension to your browser: a recording of anything a web page played then reads the site and its title (« YouTube · its title »), with a link that opens the page, and on YouTube each sentence opens the video at the moment it was said. On a page that plays sound, the extension reads only its address, its title and whether the sound can be heard. Films, series and music (Netflix, Spotify…) are not kept by default: their recordings are deleted when they end, audio included, before being transcribed. Every site has its « Garder » switch, and you can add any other; from a recording's « ⋯ » menu, « Ne plus garder <site> » leaves that site out from now on. Settings ▸ Navigateurs shows whether each browser's extension is linked and when it last spoke, and says when it needs reloading. Nothing leaves your Mac.

#### See which app you were in when something was said

A transcript now shows the icon of the app you had in front, Sondine included, wherever it changes, and search can keep only what was said while you were in one app: « Pendant que j'étais dans… ». Sondine notes the app only, never a window or what is on screen, only while someone speaks, and needs no new permission; it goes when you delete the recording. Agents see the app beside each sentence too.

#### See your last conversations with someone while you call them

During a call, when Sondine recognizes the voice on the other end, the menu bar reads « Marie ? » next to its icon, and its menu lists your last three conversations with her: click one to open it. On a Mac with a notch, the notch shows it too: her initial on one side, « ? » on the other, « Marie ? » just below the notch when she is recognized, and her conversations when your pointer rests on the notch. If you would rather click, turn off « Ouvrir l’encoche au survol » in Settings ▸ Voix. It is a guess from her voice, never stored, and gone when the call ends. The notch never shows in a screen share or a recording; the menu bar's name does if you share your whole screen. « Masquer pour cet appel » hides it, and « Reconnaître les voix » turns it off.

#### Connect Grok, Claude or Cursor to Sondine in one click

Settings ▸ Agents now lists the agent apps found on your Mac (Grok, the Claude app, Cursor): « Connecter » adds Sondine to the app's own settings, with a key of its own, says what it wrote and where, and keeps a copy of the file as it was. Revoking the key takes Sondine back out of that file. Claude Code and Codex still get their command, and any other app gets the settings to paste, in JSON or TOML. Before anything is set up, the screen says what the agent will read and that it goes to the company behind its model.

#### Merge two people who are the same person

On a person's page, « Fusionner avec… » takes someone named twice (« Marie » and « Marie D. ») and makes them one: their conversations and their voice come together under the name of the page you are on, and Sondine's « Marie ? » suggestions use both voices at once. ⌘Z undoes it.

#### Let Sondine learn your voice from your dictations

Turn on « Apprendre ma voix depuis mes dictées » in Settings ▸ Voix: the dictations where you speak alone join the voices you named « Moi », so Sondine recognizes you more surely in your conversations. Only dictations that sound like you count, they never name anyone, and turning it off erases what Sondine kept from them.

### Improved

#### Each app keeps its own sound

When two apps play at once, Sondine records each on its own: a call with a YouTube video behind it stays a call, and the video becomes its own media recording, named after its app and its page. During a call on a headset, Sondine also records the headset's microphone, the one you speak into. When nothing plays, Sondine no longer listens to the Mac's sound at all, which saves some battery.

#### See how sure Sondine is of a voice, and let it recognize the voices it knows well

Hover a voice it guessed to see how confident Sondine is, and from how many named voices: « Moi ? · 98 % de confiance, d'après 5 voix nommées ». The more voices you name for someone, the closer Sondine gets to their voice, so voices it used to leave unnamed, yours first, now come with a suggestion. When it is all but certain (99 %, from voices named on two days or more), it shows the name directly with a small ✦, and « Oui », « Non » or « Modifier » confirms or corrects it in one click. A recognized voice stays a guess: people's pages list those conversations apart, and exports and the journal keep only the names you gave.

#### See how much a voice sounds like each person when you name it

« Qui est-ce ? » now shows, beside each name and on « C'est moi », how much the voice sounds like that person, the likeliest first: even at 34 %, you see that Sondine leans toward you, and naming takes one click.

#### See who probably spoke in your journal, and check it in one click

When Sondine is fairly sure who an unnamed voice is (80 % or more), the journal now shows « Marie ? » instead of « Voix 2 », marked so you know it is still to confirm. Hover to see how sure it is; click to hear that person speak in the conversation, then confirm or correct the name there.

#### Delete a passage by selecting its text

Select text over several sentences of a recording, as anywhere else, and the bar offers to delete them, with how many and from when to when. « Jusqu'à la fin » and « Depuis le début » take the passage to an edge of the recording, for a radio or a video that kept playing after a conversation; ⌫ also opens the bar, on a selection or the sentence you clicked. One confirmation erases the text and the audio for good, the whole recording when every sentence is chosen. A selection within one sentence is left alone for copying, and no longer starts playback.

#### People opens faster

The list of people, a person's page and Sondine's « Marie ? » suggestions no longer wait while Sondine looks for everyone's conversations: under a tenth of a second instead of most of a second once many voices are named.

### Fixed

- **Agents are no longer turned away when several are open.** Sondine used to refuse a fifth agent session with « too many agents are connected ». Every agent you connected can now read Sondine at the same time, however many sessions it opens.
- **Name a voice that says only a word or two.** A voice that spoke less than a second, such as a single « Ouais, d'accord. », now takes the name you give it, where clicking « C'est moi » used to do nothing. A name that cannot hold on a voice now says so instead of doing nothing, and naming a voice again as who it already is changes nothing.

## 0.3.1 — 2026-11-09

### Improved

#### Long calls split where nobody talks

A call left open for hours, such as a Discord channel you sit in quietly, becomes one conversation per exchange: 5 minutes without anyone talking closes it. What you say to a dictation app during a call stays in « Dictées ».

## 0.3.0 — 2026-11-09

The first release of the new Sondine, rebuilt from scratch: it listens all day, transcribes what was said with the voices apart, and keeps everything on this Mac.

### New

#### Start listening when you are ready

On a new Mac, Sondine records nothing until the first run's last step, when you choose Start listening. Before that it explains what it does, asks for the microphone and system audio, and offers the transcription model. If macOS restarts Sondine after you grant the microphone, the first run picks up where you left it.

#### Let Sondine listen from the menu bar

Sondine runs in the menu bar and listens to your microphone and to the audio your apps play, such as calls and videos. The audio stays on this Mac.

#### See your day in Today

Today lists the day's conversations with their time, length, call app, voices and first words, and folds the shorter moments into one row per hour that opens to list them. Videos and music sit apart behind Media, which shows a dot while one is being recorded, and you can go back day by day. An ongoing conversation shows as such, and one being transcribed shows its progress.

#### Read and replay a conversation

A conversation opens with its transcript in speaker turns. Click a sentence to hear it, and follow along as the sentence playing lights up. The player shows where each voice speaks, and plays at 1×, 1.5× or 2×. Space plays or pauses, the arrows move 5 s or to the previous and next sentence.

#### Search what was said

Sondine groups what it hears into episodes and turns each finished one into text while the Mac is plugged in and idle, so your work is never slowed. Press ⌘K from anywhere to search every transcript in French or English, accents and filler words ignored, and narrow it to a period, a size, or calls, in-person talks and media. Transcribe now puts any episode first. The bottom of the sidebar says what is waiting and why.

#### Follow a conversation as it happens

Turn on live text in Settings: a small model transcribes each sentence seconds after it is said, while the Mac is plugged in. Today opens with what is being said now, and the final transcript replaces the live one later.

#### Name the voices in your recordings

Each person keeps one voice from the start to the end of a recording, even one several hours long that the model hears in pieces. Click a voice to say who it is, or that it is you: the name follows every sentence they said, in the transcript, search and exports. People lists everyone you named and asks « Qui est-ce ? » for the voices heard often, and Sondine suggests a name it recognises, which you confirm in one click.

#### Import an audio file

Bring in a recording made elsewhere from « Importés »: pick it, drop it on the page, or copy it in Finder and paste it, Voice Memos' files included. Sondine keeps it and transcribes it with the voices apart, so you can read, search, name and export it like your own recordings. A long recording that stops because the Mac runs short of memory resumes after the parts already transcribed, and Sondine says when it tries again.

#### Keep what you dictate apart

What you say to a dictation app (Hex, VoiceInk, Parler, or any app you add in Settings) gets its own lane in Today, behind « Dictées », with the app's icon. It is transcribed quickly as your voice alone, and stays searchable.

#### Let your AI agents read what Sondine heard

Turn on agent access in Settings and connect Claude Code or another MCP client: it can search what was said, read a day or a conversation, and look up the people you named. Nothing leaves your Mac, and you can turn access off at any time.

#### Correct a transcript

Fix a word or a sentence with the pen next to it: search, exports and agents read your version, and you can go back to the original. Names you correct are spelled your way in later transcripts too.

#### Transcribe a recording again

A transcribed recording's « ⋯ » menu offers « Retranscrire »: Sondine transcribes it again before anything else, and the new transcript replaces the old one. The names you gave and your corrections stay.

#### Copy, export or share a transcript

Copy a conversation's text, export it as Markdown, subtitles (SRT, WebVTT) or JSON, or share it from the menu. A whole day can be copied or exported from Today.

#### Export a recording's audio

A conversation's « ⋯ » menu now offers « Exporter l'audio… »: choose where to save it, and Sondine writes the recording as a WAV file there, then shows it in the Finder. The audio leaves Sondine only this way, by your hand.

#### Split or merge recordings

Cut a recording in two at any sentence with the scissors, or join it to the one before or after from its menu. Each part keeps its transcript and voices.

#### Say what a recording is

From a recording's menu, mark it as a conversation, a moment or media when Sondine got it wrong.

#### Undo your last edit

⌘Z undoes a correction, a name, a split or a merge, and ⇧⌘Z does it again.

#### Delete a recording

A conversation's « ⋯ » menu now offers « Supprimer l'enregistrement… ». After you confirm, its audio and its text are erased for good, with no trash: the text leaves the database at once, the audio is overwritten on disk, within about 20 minutes for the part still being written.

#### Delete a passage of a recording

Choose « Supprimer… » on a sentence, extend the selection with ⇧-click, and confirm: the audio and the text of that passage are gone, the rest stays.

#### Erase the last minutes

From the menu bar (« Effacer ») or the pause menu at the bottom of the sidebar, you can erase the last 5 minutes, 15 minutes or hour. Sondine first lists the recordings this deletes, whole, including one that started earlier, then erases their audio and text and everything else it heard in that time.

#### Pause and resume listening at any time

Pause from the menu bar or from the bottom of the window's sidebar: nothing is recorded until you resume. If the pause is not confirmed yet, both say so and let you try again.

#### Pause listening for 15 minutes or an hour

The menu bar and the window's sidebar offer a pause of 15 minutes, of an hour, or until you resume. A timed pause shows when it ends and resumes listening on its own, even if the Mac slept or Sondine was closed meanwhile.

#### Find a name even when it was misheard

Search matches words that sound like the one you typed, so « Kamille » finds Camille.

#### Listen to an episode before transcribing it

Every conversation, moment, trace and media episode has a play button, so you can hear it and decide whether it is worth transcribing. Playback starts at once, even for an episode several hours long, in a player at the bottom of the window that stays while you move between screens.

#### See what Sondine hears

The Status screen shows whether Sondine is listening, which permissions it has, with a button to grant the missing ones, and the live level of each audio source.

#### Get the transcription model from Sondine

During the first run, or later in Settings, Sondine offers the copy of its transcription model it finds on your Mac, imported without using more disk space when it can, or lets you choose the file. Otherwise it downloads the model when you ask, from its official source only, after showing its size, your free space and its license, which opens in your browser, and resumes an interrupted download where it stopped. You can continue without it: listening and playback work, and transcription waits for the model.

#### Use Sondine in French or English

Choose the language in Settings. The window follows your Mac's light or dark appearance, and you can choose one yourself there or switch with D.

#### Open Sondine when you log in

Turn it on in Settings so Sondine listens again after a restart.

#### Know when a new version is out

Turn on the update check in Settings: Sondine looks once a day and offers the release page. It downloads nothing by itself.

#### Short noises no longer fill your day

Traces, sounds with under 1.5 s of voice such as a cough or a door, no longer get a row each in Today: one line counts them, and Show lists them when you want to hear one. They are still kept and searchable.

### Improved

#### A banner when listening is paused or audio is not stored

When listening is paused, a line above every screen says until when, with Resume. When the disk is full or audio cannot be written, a red line says so instead of a small dot in the sidebar. Search explains what it does before you type and says up front how many recordings it cannot see yet; the first run offers the model already on your Mac first, with the other options folded; the theme shortcut moves to ⇧⌘D so a stray D no longer flips it.

#### A call is one conversation

A call in Zoom, Teams, FaceTime, WhatsApp, or a browser now becomes one conversation that holds both your voice and the people you talk to, instead of an in-person moment and a separate media episode. Today names the app next to the call, and the voice heard most on your microphone shows as « Moi » (Me), the others as Voice 1, Voice 2. A video playing in another app during the call stays apart.

#### Clearer waiting, and one click to replay a sentence

Clicking a sentence of a conversation now plays it, even when the player was paused. A conversation that is not transcribed yet says why (the Mac on battery or in use, or another transcription running), and while it is transcribed it shows its progress. Today no longer marks every waiting conversation: each row says how much speech it holds and why it waits, with a smaller « Transcrire maintenant ». Coming back from a search keeps its filters, and Sondine now speaks of recordings rather than episodes.

#### Install without a security warning

Sondine is signed and notarized by Apple: the downloaded app opens like any other.

#### Know when Sondine cannot save audio

When the disk is full or audio cannot be written, the menu bar and the window's sidebar say so instead of showing Sondine as listening. They go back to normal on their own once audio can be saved again.

#### Listen all day without filling your disk

Sondine keeps everything it hears for a day, up to 4 GB, then keeps only the moments when someone speaks, with a second or so around each. Silence and background noise no longer pile up on your disk.

#### Search filters in one row

Search keeps its filters in one row: the period, then « Filtres » for sizes and contexts with how many are on, and « Réinitialiser » once one narrows the results. The play button tells the keyboard shortcuts, and a transcript's times show the clock time when you hover them.

#### See where people speak before transcription

Before a conversation is transcribed, the player bar marks where someone speaks, on the microphone and in the Mac's sound, so you can jump to the voices and skip the silences. The conversation's page also says how much speech it holds.

#### See where your search matched

Search results come grouped by day and conversation, newest first, with the words you searched for highlighted, even typed without accents or as digits for a number said aloud. A click opens the conversation playing from that sentence, with every match marked and Previous and Next to step through them. A line says how many episodes are not transcribed yet, so you know what the search cannot see.

#### See at a glance which app you heard

App icons show next to calls, media, dictations and imports, in Today, search, a recording and the player.

#### See why transcription waits, and choose what it waits for

The queue line explains what holds transcription back (power, idle, memory, heat), lists the apps using the most memory, and lets you turn off waiting for power, idle or memory.

#### See why transcription waits from the menu bar

The menu bar menu now says how many conversations and moments wait to be transcribed and why, for example until the Mac is plugged in or left alone, with the same words as the bottom of the sidebar.

#### Short answers are transcribed

Traces, such as a quick « oui » or « non », are now transcribed too, but only while the transcription model is already loaded for something else, so they never cost a load of their own. The Status screen counts the ones still waiting.

#### What the Mac played stays out of your words

When the microphone picks up a call or a video playing on the speakers, those words stay with the call or the video, not in your sentences.

### Fixed

- A cough is no longer a moment.
- The Mac stays awake during a conversation while a dictation app is open.
- Keep the Mac responsive during transcription.
- Open the Sondine window from Finder or Spotlight.
- Replaying a recording on the speakers no longer creates moments.
- Sondine opens again by itself after a crash.
