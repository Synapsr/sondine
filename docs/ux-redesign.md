# UX redesign (M6)

The plan for a more minimal, simpler and coherent Sondine on the Mac, then
on the iPhone. ADR 037 holds the rules. This file holds the screens, the
first run, the action inventory, the word budgets, the motion catalogue,
the steps and the measures. Granola is the reference for tone and
hierarchy. Nothing here changes what Sondine records, keeps or sends
(`docs/product-vision.md`), except where a step names a new contract and
its tests.

Implementation starts only after the Graphical work (ADR 033) has landed
in `main`: every target below is drawn with its tokens and components.

Reviewed on 2026-11-18 by Codex (gpt-6-astra and gpt-6.1-sol). Their
findings and what changed are in §10.

## 1. Evidence

### Téo's use, 2026-11-04 to 2026-11-18

These are read-only aggregates from his database; no transcript, name or
voice was copied. They are counts of stored rows, not of navigation, so
what they say about use is a hypothesis to check after U2.

| What                              | Count                                     | Hypothesis                                                  |
| --------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Episodes                          | 1 374 (154 conversations, about 11 a day) | Today is the main surface                                   |
| Voice namings                     | 33, on 5 days of 14                       | The one frequent edit                                       |
| Deleted ranges                    | 79, 73 of them on one day                 | Erasing is rare and done in bursts                          |
| Journal marks                     | 2, both dismissed                         | The journal is read more than acted on                      |
| Agent discussions in the app      | 1                                         | The in-app chat is rare; agents read through MCP (99 calls) |
| Context items, kept audio, titles | 0, 0, 1                                   | Unused so far                                               |
| Phone recordings                  | 13, 1 named                               | The iPhone records; naming is rare                          |
| Private zones applied             | 1                                         | Set once                                                    |

Searches and playback are not recorded, so how often they happen is
unknown: both stay primary.

### Today's app

Captured on a development build with fake hardware and invented data
(`SONDINE_DATA_DIR` outside the group container).

- **Window.** Eight sidebar entries (Today, Journal, Search, People,
  Imported, Chat, Settings, Status) and a listening panel with a queue
  line. The packaged app opens no window at launch, so the menu bar is
  the entry point.
- **Menu bar.** About a dozen items: state, three pause items, open, add
  the clipboard, keep 2 minutes, an erase submenu of three, update, quit,
  and call context during a call.
- **Notch island.** Shown only during a call with a recognized voice: the
  person, recent conversations, hide for this call.
- **Notification.** The call offer during a pause (ADR 036), with three
  buttons behind « Options ».
- **Settings.** One page of fourteen sections, about 680 visible words,
  with no section navigation.
- **First run.** Five steps, about 310 words.

### Granola

- **First run.** Short (sign-in, calendar, microphone, a demo), and the
  home screen is never empty. On iOS, one « what is your work » choice sets
  the defaults.
- **Home.** A list by day, one line per meeting, attendees collapsed to
  « +N », and one dominant primary button.
- **Meeting.** The notes are the page. The transcript sits behind a pill
  and Share is visible; everything else goes in « ··· ». Chat (⌘J) is
  scoped to where it opens.
- **Rare actions.** Templates and people sit behind a menu or ⌘K. Text is
  a title, chips and the content; explanations appear only when a feature
  is turned on.
- **Motion.** Quiet: a recording pill whose bars freeze on pause, sheets
  that slide over the list, regeneration in place without a spinner.

Limitless adds one idea Granola lacks: a daily question that becomes a
recurring item, which fits Sondine's journal.

Sources: Granola's help center (setup, transcription, people and
companies), its changelog, and its iOS screens on Mobbin. The Mac app is
not on Mobbin.

## 2. Action inventory

ADR 037 defines the counts. **Access** is the clicks to reach the control
that does the action, from the stated start. **Done** is the full cost:
clicks, then typing (⌨), a native dialog (▢) and a confirmation (✓)
written apart. Levels: P primary, S secondary, R rare.

Every row is a capability that exists today. None is dropped; a row whose
place changes names its new home. U-steps (§7) carry each row.

### Window, from Today unless stated

| Action                                                           | Now: where, access         | M6: where                                                                               | Access | Done               | Level | Step |
| ---------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------- | ------ | ------------------ | ----- | ---- |
| Open the day                                                     | Sidebar, 1                 | Landing screen, sidebar                                                                 | 0–1    | same               | P     | U2   |
| Open a conversation                                              | Row, 1                     | Row                                                                                     | 1      | 1                  | P     | U2   |
| Play a conversation                                              | Row button, 1              | Row button (always shown), Space                                                        | 1      | 1                  | P     | U2   |
| Search                                                           | Sidebar or ⌘K, 1           | Sidebar or ⌘K                                                                           | 1      | 1 + ⌨              | P     | U4   |
| Pause until resumed                                              | Panel ▸ menu, 2            | Listening button                                                                        | 1      | 1                  | P     | U1   |
| Resume                                                           | Panel, 1                   | Listening button                                                                        | 1      | 1                  | P     | U1   |
| Confirm a suggested voice (in a conversation)                    | Name ▸ « Oui », 2          | ✓ beside the suggested name                                                             | 1      | 1                  | P     | U3   |
| Open sharing (in a conversation)                                 | « ··· » ▸ Share, 2         | Share button                                                                            | 1      | 2 (+ ▢ for a file) | P     | U3   |
| Open the agent                                                   | Chat screen, 1             | ⌘J or « Demander »                                                                      | 1      | 1 + ⌨              | P     | U5   |
| Undo / redo                                                      | ⌘Z / ⇧⌘Z                   | ⌘Z / ⇧⌘Z                                                                                | 1      | 1                  | P     | —    |
| Timed pause (15 min, 1 h)                                        | Panel ▸ menu, 2            | Listening chevron                                                                       | 2      | 2                  | S     | U1   |
| Keep the last 2 minutes                                          | Panel menu, 2; ⌃⌥⌘K        | Listening chevron; ⌃⌥⌘K                                                                 | 2      | 2                  | S     | U1   |
| Erase the last 5, 15, 60 minutes                                 | Panel menu ▸ dialog, 3     | Listening chevron ▸ range                                                               | 2      | 2 + ✓              | S     | U1   |
| See why transcription waits, permissions, holds                  | Panel line, status screen  | Listening chevron, top of the menu                                                      | 1      | 1                  | S     | U1   |
| Listen anyway during a private-zone hold                         | Menu bar, 2                | Listening button (it reads « Zone privée ») and menu bar                                | 1      | 1                  | S     | U1   |
| Change the day                                                   | Arrows, 1                  | Arrows beside the date                                                                  | 1      | 1                  | S     | U2   |
| Show media, dictations, imported                                 | Lane toggles, 1            | « Tout ▾ » filter                                                                       | 2      | 2                  | S     | U2   |
| Copy, export or share the day                                    | Day « ··· », 2–3           | Day « ··· »                                                                             | 2      | 2–3 (+ ▢)          | S     | U2   |
| Mark a commitment done                                           | Journal ▸ checkbox, 2      | Today, checkbox                                                                         | 1      | 1                  | S     | U2   |
| Edit a journal line, change a due date                           | Journal ▸ hover, 2         | Line « ··· »                                                                            | 2      | 2 + ⌨              | S     | U2   |
| « Pas juste », « Pas un engagement »                             | Journal ▸ hover, 2         | Line « ··· »                                                                            | 2      | 2                  | S     | U2   |
| Restore the text Sondine wrote                                   | Journal, 3                 | Line « ··· »                                                                            | 2      | 2                  | R     | U2   |
| Open a cited sentence                                            | Journal, 2                 | The line's time                                                                         | 1      | 1                  | S     | U2   |
| Write the journal now, write the day again                       | Journal, 2                 | Day « ··· »                                                                             | 2      | 2                  | R     | U2   |
| Overdue and older commitments                                    | Today reminder, Journal    | Top of Today, any day                                                                   | 0      | —                  | S     | U2   |
| Name a new voice                                                 | Name ▸ field, 2–3          | Voice popover (click the name)                                                          | 1      | 1 + ⌨              | S     | U3   |
| Reject a suggestion (« Pas Camille »)                            | Name ▸ « Non », 2          | Voice popover                                                                           | 2      | 2                  | S     | U3   |
| « C'est moi », remove a name                                     | Name popover, 2–3          | Voice popover                                                                           | 2      | 2                  | S     | U3   |
| Why this voice was suggested                                     | Name popover               | Voice popover, « ⓘ »                                                                    | 2      | 2                  | R     | U3   |
| Open the person                                                  | Name popover ▸ « Voir », 3 | Voice popover ▸ « Voir Camille »                                                        | 2      | 2                  | S     | U3   |
| Copy a conversation                                              | « ··· », 2                 | Share popover ▸ Copier                                                                  | 2      | 2                  | S     | U3   |
| Export transcript (MD, SRT, VTT, JSON) or audio                  | « ··· » ▸ submenu, 3       | Share popover ▸ format                                                                  | 2      | 2 + ▢              | S     | U3   |
| Keep the audio                                                   | « ··· » checkbox, 2        | « ··· »                                                                                 | 2      | 2                  | S     | U3   |
| Merge with the previous or next                                  | « ··· », 2                 | « ··· »                                                                                 | 2      | 2                  | S     | U3   |
| Play from a sentence                                             | Sentence time, 1           | Sentence time                                                                           | 1      | 1                  | S     | U3   |
| Correct, split, delete a passage                                 | Hover on a sentence, 1–3   | Sentence menu (« ··· » at the line's end, shown on focus and hover, and by right-click) | 2      | 2 + ⌨ / ✓          | S     | U3   |
| Restore an edited passage                                        | Editor, 2                  | Sentence menu                                                                           | 2      | 2                  | R     | U3   |
| Transcribe now (waiting)                                         | Row or header, 1           | Header button while waiting                                                             | 1      | 1                  | S     | U3   |
| Install the model (none)                                         | Header, 1                  | Header button while no model                                                            | 1      | 1                  | S     | U3   |
| Add context (note, link, file)                                   | Paperclip popover, 2–3     | « ··· » ▸ Ajouter du contexte; drop on the transcript                                   | 2      | 2 + ⌨ / ▢          | S     | U3   |
| Open, edit, transcribe, detach, remove a context item            | Context strip, 1–2         | Context chip ▸ menu                                                                     | 2      | 2 (+ ⌨)            | S     | U3   |
| Open the page the sound came from                                | Header link, 1             | Header link (when there is a page)                                                      | 1      | 1                  | S     | U3   |
| Stop keeping a site (« Ne plus garder »)                         | « ··· », 2                 | « ··· » (when there is a site)                                                          | 2      | 2                  | R     | U3   |
| Why audio is or is not kept (zones, retention)                   | Privacy line               | Privacy line, one line, « ⓘ »                                                           | 0–1    | —                  | S     | U3   |
| « Aussi enregistré par l'iPhone », switch the journal's source   | Same-moment line, 1        | Same-moment line                                                                        | 1      | 1                  | S     | U3   |
| Change an episode's kind                                         | « ··· » ▸ Kind, 3          | « ··· » ▸ Type                                                                          | 3      | 3                  | R     | U3   |
| Transcribe again                                                 | « ··· », 2                 | « ··· »                                                                                 | 2      | 2                  | R     | U3   |
| Recognize voices here (off)                                      | « ··· » checkbox, 2        | « ··· »                                                                                 | 2      | 2                  | R     | U3   |
| Delete a recording                                               | « ··· » ▸ confirm, 2       | « ··· » ▸ Supprimer                                                                     | 2      | 2 + ✓              | R     | U3   |
| Step through search matches                                      | Transcript search bar, 1   | Same                                                                                    | 1      | 1                  | S     | U3   |
| Search filters (date, kind, app, person, imported)               | Three menus, 3             | Chips under the field, active ones always shown                                         | 2      | 2                  | S     | U4   |
| Copy, export or share results                                    | Results « ··· », 3–4       | Results « ··· »                                                                         | 2      | 2–3 (+ ▢)          | S     | U4   |
| Import a recording                                               | Imported ▸ button, 2       | Day « ··· » ▸ « Importer un enregistrement… », palette, drop on the window              | 2      | 2 + ▢              | S     | U4   |
| Import progress, failure, retry, open the result                 | Imported screen            | Toast with « Ouvrir » / « Réessayer »; the recording in its day with « Importé »        | 0–1    | —                  | S     | U4   |
| Rename, merge, delete a person                                   | Person page, 3–4           | Person « ··· »                                                                          | 2      | 2 + ⌨ / ✓          | R     | U2b  |
| Unnamed voices                                                   | People page section        | People ▸ « Voix sans nom (n) »                                                          | 2      | 2                  | S     | U2b  |
| Names to check                                                   | —                          | People ▸ « À vérifier », when there is one (ADR 030)                                    | 1      | 1                  | S     | —    |
| Past discussions, delete one                                     | Chat screen list           | Agent panel ▸ history                                                                   | 2      | 2 (+ ✓)            | S     | U5   |
| Model and thinking                                               | Chat picker, 2             | Agent panel « ··· »                                                                     | 2      | 2                  | R     | U5   |
| Stop an answer                                                   | Chat, 1                    | Agent panel                                                                             | 1      | 1                  | S     | U5   |
| Private zones                                                    | Settings + scroll, 3–4     | Settings ▸ Écoute et confidentialité                                                    | 3–4    | + ✓                | R     | U6a  |
| Journal: on or off, who writes it, its model                     | Settings + scroll, 2–3     | Settings ▸ Général ▸ Journal                                                            | 3      | + ✓ (Claude)       | R     | U6a  |
| Pair an iPhone, Tailscale, revoke                                | Settings + scroll, 2–4     | Settings ▸ Appareils et agents                                                          | 3–4    | + ✓                | R     | U6a  |
| Agent keys, chat switch                                          | Settings + scroll, 2–5     | Settings ▸ Appareils et agents                                                          | 3–5    | + ✓                | R     | U6a  |
| Model, dictation apps, browsers, voices, notch                   | Settings + scroll, 2       | Their tabs                                                                              | 3      | 3                  | R     | U6a  |
| Language, theme, login, updates                                  | Settings + scroll, 2       | Settings ▸ Général                                                                      | 3      | 3                  | R     | U6a  |
| Technical status: tracks, helper, permissions, waived conditions | Status screen, 1–2         | Settings ▸ Avancé                                                                       | 3      | 3                  | R     | U6a  |
| Statistics                                                       | —                          | Settings ▸ Statistiques; palette                                                        | 2      | —                  | R     | U6c  |
| Command palette, theme toggle                                    | ⇧⌘P, ⇧⌘D                   | Same                                                                                    | 1      | 1                  | R     | —    |

### Menu bar, notch, notification (U8)

| Surface      | Now                                                | M6                                                                                                                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu bar     | A dozen items, three pause items, an erase submenu | The state line, with its reason during a hold; « Pause » or « Reprendre » (one item); « Pause pendant ▸ » 15 min or 1 h; « Écouter quand même » during a hold; « Garder les 2 dernières minutes »; « Effacer ▸ »; « Importer… »; « Ouvrir Sondine »; Quit. Update and call context unchanged. The same words as the window. |
| Notch island | Person, recent conversations, hide                 | Same structure; motion from the catalogue; shorter labels                                                                                                                                                                                                                                                                   |
| Call offer   | A 15-word body, three buttons                      | « Appel {app}. Sondine est en pause. » with « Écouter cet appel » first; « Reprendre l'écoute » and « Jamais pour {app} » in Options                                                                                                                                                                                        |

## 3. Screens, now and target

The review page shows the targets as mock-ups in the visual direction
below, with today's captures behind « Voir l'écran actuel ». This section
is the reference.

### Visual direction

Téo reviewed three rounds of mock-ups on 2026-11-18. He kept the layouts
of the Granola-inspired round, and asked for no serif, the Allo typeface
and a neutral white (and possibly black) instead of the warm beige. The
placement of elements is what this plan fixes; colours are tuned later in
Graphical. U0 sets these values in the Graphical theme (ADR 033) before
any screen changes:

- **Type.** One family, Allo (Josh Puckett, SIL Open Font License 1.1, a
  redrawn Inter 4.1 with weight, roundness and optical-size axes), for
  everything. Titles semi-bold with tight tracking; text regular. It
  replaces Timeless Grotesk: an amendment to ADR 009, with the font file
  committed and its licence named as Timeless's is today.
- **Surfaces.** A neutral white base (a black one for the dark appearance),
  a barely grey sidebar, white content. Rows and blocks are cards: a 1 px
  hairline, the medium radius (18 px, so a one-row card keeps the corner
  of a tall one; Téo, 2026-11-19), no shadow except on floating layers.
  The window's card, the agent panel and the player keep the large radius.
- **Controls.** Buttons, icon buttons included, take the sidebar items'
  small radius (Téo, 2026-11-19: a round button beside a square one looked
  apart); chips stay pills. One primary button per screen
  in ink (black on white, white on black); secondary buttons are surfaces
  with a hairline.
- **Colour.** Ink and neutral greys carry the interface. A light red marks
  speech heard live (the top bar's wave; grey and still when nobody speaks).
  Sondine's orange stays for the brand mark and the menu bar icon, not for
  buttons.
- **Rows.** A tile for the kind (call, in person, media, dictation), the
  people as the title, the first words below, the time and a play button
  on the right.
- **No dock** (ADR 037, amended 2026-11-20). Search and « Demander » are
  sidebar entries; nothing floats over the screen.

### Shell (U1)

- **Now.** Eight entries, a listening panel (dot, pause button, queue
  line), and a banner when paused or failing.
- **M6.**
  - **Sidebar.** Three entries (Aujourd'hui, Recherche ⌘K, Personnes) and
    Réglages at the bottom. Each entry leaves only in the step that
    delivers its replacement (§7).
  - **The dock (gone, 2026-11-20).** It held search and « Demander »;
    both are sidebar entries now, and the player sits at the screen's
    foot.
  - **Listening control.** In the window's top band. Two targets:
    - The button says the state and does its one action.
    - The chevron opens the menu: the status lines first (queue, the
      sources being recorded, a hold's reason), then timed pauses, keep,
      erase and import.
  - **States.** The button follows the helper's confirmed state, as
    `listening-view.ts` does today:

| State                                               | Button reads         | Click does                                           | Banner                                              |
| --------------------------------------------------- | -------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Listening, both sources                             | « Écoute »           | Pause until resumed                                  | —                                                   |
| Listening, one source missing                       | « Écoute partielle » | Pause                                                | — (the menu says which source and offers to fix it) |
| Paused, until resumed                               | « En pause »         | Resume                                               | —                                                   |
| Paused until a time                                 | « En pause · 15:30 » | Resume                                               | —                                                   |
| Pause asked, not yet confirmed                      | « Mise en pause… »   | —                                                    | —                                                   |
| Private-zone hold                                   | « Zone privée »      | « Écouter quand même » for this occurrence (ADR 029) | —                                                   |
| Pause failed, helper gone, disk full, write failure | « Problème »         | Opens the menu with the cause and its action         | Kept, one line with the action                      |

- **Banner.** It stays for failures that stop capture without the user
  asking. It goes for a plain pause, which the button already shows.
- **« Demander ».** A sidebar entry under Search (⌘J); it opens and
  closes the agent panel (U5) and stays lit while the panel is open.

### Today (landing, U2)

- **Now.** Title and date, Media and Dictations lanes, arrows, the day
  « ··· »; rows with time, duration, context, people and first words;
  moments collapsed by hour; traces hidden.
- **M6.**
  - **Header.** The date, its arrows, the « Tout ▾ » filter (media,
    dictations, imported) and the day « ··· » (copy, export, share,
    import, write the journal now or again).
  - **Commitments.** Open commitments of every day come first, overdue
    marked, each with a checkbox and a line « ··· ».
  - **Journal.** Then the day's lines, each ending with the time of its
    cited sentence (a link). When the journal is on but cannot write (no
    model, a failure, waiting), the block says so in one line with its
    action, instead of hiding.
  - **Conversations.** Grouped under « Ce matin », « Cet après-midi »,
    « Ce soir ». One card per conversation: a tile for its kind, the people
    as the title (« Voix 2 ? » until named), the first words below, the
    time, and a play button always shown. Moments stay collapsed by hour. A new conversation
    appears at its place. The ongoing one shows its live dot.
  - **Empty day.** « Rien entendu aujourd'hui. »
- **Reworked (Téo, 2026-11-19).** Too many blocks, all in cards:
  - **One thread, no cards.** The conversations by part of the day,
    separated by hairlines. Each reads its journal line in place of its
    first words; the journal block is gone. Media and dictations, when the
    filter shows them, join the thread at their time, one line each.
  - **App icons.** A conversation's or a medium's tile is its app's icon
    (Discord, FaceTime, Safari, the dictation app) when one was heard.
  - **Beside the thread** (a wide window): a month to go to any day in one
    click, a dot per day for how much was said (`statistics.month`); the
    commitments, shown only when there are some, with the ones done
    lately folded under them to undo one; the people of the day. In a
    narrow window the commitments come above the thread, without the month
    and the people.
  - **Now.** What is being said now left Today for the sidebar, on every
    screen: its kind, since when, its last words.
- **Calm header and kept choices (Téo, 2026-11-20).** Going to another day
  moved the title, the controls and the column beside the thread.
  - **One shape.** A day, a week and a month have the same header: a
    title and a line under it (« Aujourd'hui » / « Vendredi 20 novembre »,
    « Mercredi » / « 18 novembre », « 16 – 22 novembre » / « Semaine 47 »,
    « Novembre » / « 2026 »), then the filter (a day only), the zoom,
    « Aujourd'hui », the arrows and « ⋯ ». « Aujourd'hui » and the « ⋯ »
    hold their places when hidden or absent. The header's width, never its
    words, puts the controls beside the title or under it. A day's errors
    show in a toast.
  - **Commitments fold.** Their heading folds the block to one line with
    the count; the choice is kept by core (`display.update`), for both
    layouts. The Commitments page is unchanged.
  - **The filter is kept.** Media and Dictations are one choice for Today
    and the calendar's day, kept by core: media shown, dictations by the
    first run's goal, until the user picks.
- **Sidebar (Téo, 2026-11-19).** Today, Calendar, Commitments, Search,
  People.
  - **Calendar** (`/calendar`): a week, the conversations at their hour as
    on a diary with their app's icon, and beside each day's head a small
    book opening, in a drawer on the window's side (Dialog `side="end"`),
    what mattered that day (its journal lines, its commitments);
    or a month, how long people spoke each day, its journal on hover; or a
    day, Today's view, kept in the calendar so the sidebar and the gestures
    stay there. The « Jour · Semaine · Mois » switch, ⌘− / ⌘+ and a
    trackpad pinch zoom between them (Chromium hands a pinch to the page
    as a wheel with Ctrl; the development View menu drops its page zoom); a
    two-finger swipe goes to the day, week or month before or after, on
    Today too.
    The journal has no screen of its own: it is the calendar's text (the
    week's book, the month's hover). A swipe ends with a pause; after a
    step its momentum is ignored, but a stronger push is a new swipe. While
    the fingers move, a hint at the card's edge (a chevron in a ring that
    fills to the step) shows how far to go, so a swipe
    made by chance teaches that swiping turns the page. The screen stays
    under the fingers up to the step and gives a little past it; the page
    turns when they leave past the step (momentum, or the wheel quiet
    0.22 s: Chromium tells no lift), and comes in with a spring. One step
    per touch: the next swipe starts once the fingers have left and come
    back (momentum cut by a pause of 40 ms, or 0.26 s without events), so
    holding on and swiping on never turns two pages. A gesture's first
    14 px say what it is: clearly sideways (2.5 times more than up or
    down), a swipe; else a scroll, which never turns into one, momentum
    included; short of
    the step, it springs back. Toward the future the screen gives a little,
    the hint greyed, and bounces back. Away from its place the screen
    shrinks a touch and blurs lightly (1.5 %, 1.8 px at most), the next page
    clearing as it settles. Changing zoom is a view transition of the
    screen alone (`#main`, renderer/styles.css): zooming in, the view left
    grows and blurs away as the closer one settles in from a little
    smaller; zooming out, the reverse. Reduced motion keeps both still. Reduced motion keeps
    the hint and leaves the screen still.
  - **Commitments** (`/commitments`): every commitment of the last 90
    days, open ones by when they are due (late, the next 7 days, later,
    without a date), others' folded; « Faits » to undo one; a menu keeps
    those naming one person. Each tab shows its count; each group its first
    five, then ten more per click, so the page never opens on everything.
  - **Imported** has no entry of its own: Search's « Importé » filter with
    nothing typed lists the imported files with « Importer un audio… »;
    `/imports` and the command palette land there. Importing stays one
    click from Today's « ⋯ », the palette, or a file dropped or pasted.

### Conversation (U3)

- **Now.** A back link, a time-range title, date, duration and kind, Play,
  a paperclip, a « ··· » of thirteen items, speakers with talk time, then
  the transcript with names and times; sentence actions on hover.
- **M6.**
  - **Title.** The people (« Avec Camille »).
  - **Journal.** The journal's lines that cite this conversation come
    first, as a short list, each linked to its sentence. It is read from
    existing citations (ADR 028); nothing new is generated.
  - **Player.** It sits at the screen's foot, below its scroll: play or
    pause, time, a progress bar.
  - **Header.** Time, duration, kind and people chips, then Share. While the
    conversation waits, « Transcrire maintenant » (or « Installer le
    modèle ») sits beside them, along with the source page's link when
    there is one. Then « ··· ».
  - **« ··· »**, the object's own actions in this order:
    1. Keep the audio.
    2. Add context.
    3. Merge with the previous one, merge with the next one.
    4. Recognize voices here.
    5. Stop keeping this site (when there is one).
    6. Type ▸.
    7. Transcribe again.
    8. Delete.

    Share, copy and export live in the Share popover only.

  - **Voices.** A suggested name reads « Camille ? » with a separate ✓
    target that confirms it in one click. A click on any name opens the
    voice popover: rename, « Pas Camille », « C'est moi », remove the
    name, why it was suggested (« ⓘ »), « Voir Camille ».
  - **Transcript.** It stays the page. Each sentence has a « ··· » at its
    end (play from here, correct, split, restore, delete). It shows on
    hover and on keyboard focus, and right-click opens it. The time plays
    from there.
  - **Lines kept.** The privacy line (why audio is or is not kept) and the
    same-moment line (« Aussi enregistré par l'iPhone ») stay, one line
    each.
  - **Context.** Items become chips under the header. Dropping a file on
    the transcript adds it as context; the drop zone says « Ajouter comme
    contexte ».

### Search (U4)

- **Now.** A field, three filter menus, results by episode, and a
  « ··· ».
- **M6.**
  - A field with filter chips under it (Période, Personne, Type, App,
    Importé). Inactive chips appear when the field or a chip has focus;
    active chips are always shown.
  - Results as on Today, with the results' « ··· ».
  - Empty: the field's placeholder « Un mot, un nom… » and nothing else.

### Import (U4)

- **Drop.** Dropping an audio file anywhere outside a conversation
  imports it. The overlay says « Importer l'enregistrement ».
- **Picker.** « Importer un enregistrement… » sits in the day « ··· », in
  the palette and in the menu bar.
- **Feedback.** Progress, failure, a duplicate and the result go in a
  toast with « Ouvrir » or « Réessayer ». The recording appears in its own
  day with the « Importé » chip and a Search filter.

### People and a person (U2b)

- **List.** Name and the last time heard. Unnamed voices sit behind a
  « Voix sans nom (n) » chip. « À vérifier » shows above it only when a voice
  the user named sounds like someone else (ADR 030).
- **Person page.** Their conversations, shown as on Today; « Demander »
  scoped to them; and « ··· » (rename, merge, delete, and the voice read
  when it is the user).

### Agent panel (U5)

- **Now.** A Chat screen with a list of discussions, a model picker and a
  field.
- **M6.** A side panel of 380 px. When the window is narrower than 55rem,
  it covers the screen. It is not modal:
  - **Keyboard.** Focus goes to its field. Esc closes it and returns
    focus to where it was.
  - **Focus.** A chip at the top shows where the discussion starts:
    « Cette conversation », « Ce jour » or « Camille », from the screen it
    opened on, or « Tout » from the sidebar. The agent starts there and
    can read every other conversation, as the chat does today.
  - **Limit, as an option.** The chip's menu has « Limiter à cette
    conversation » (or that day, that person). When it is on, core
    enforces it: that discussion's tools read only within the focus, and
    the chip shows a lock. Settings ▸ Appareils et agents will set whether
    new discussions start limited (U6a); off by default. Core keeps the
    focus and the limit with the discussion; turning the limit on applies
    to the next tool call, even during an answer.
  - **What the limit allows.** Before a call, core refuses the tools that
    range over everything (search, the lists of people and commitments,
    another day or person); after it, an answer that read a conversation
    outside the focus is withheld whole.
  - **Navigation.** A discussion keeps its focus and its limit after
    navigation; a new discussion takes the current screen's.
  - **Rest of the panel.** History (past discussions, delete one), Stop,
    and the model and thinking in the panel's « ··· ».
  - **Chat off.** ⌘J opens ADR 027's consent as a modal, with its full
    text.
  - **ADR 027 unchanged.** Consent, nothing sent before « Envoyer », the
    provider shown, Stop, deletion, and erasure with what a discussion
    read are all acceptance criteria of U5.

### Settings (U6a)

- **Now.** One page, fourteen sections, about 680 words.
- **M6.** Tabs, each a short list with one-line labels and an « ⓘ » for
  the long explanation:
  - **Général**: language, appearance, login, updates, transcription
    model, journal (on or off, who writes it, its model, Claude's consent).
  - **Écoute et confidentialité**: call offers, live text, private zones,
    audio retention, dictation apps, browsers.
  - **Voix**: recognition, my voice (read, forget), learning from
    dictations, the notch.
  - **Appareils et agents**: iPhone (pair, Tailscale, revoke, reset),
    agents (MCP keys), chat.
  - **Statistiques** (U6b–c): §3 « Statistics ».
  - **Avancé**: the former Status screen (listening, transcription and
    its waived conditions, permissions, tracks, helper).
- **Reworked (Téo, 2026-11-19).** Rows, not tabs: the main sections in four
  groups (Général, Transcription, Journal · Écoute, Confidentialité, Voix ·
  iPhone, Agents · Statistiques, Avancé), each with its icon and, where it
  is short, its state (« Français · Comme le Mac », « Activé »). A row opens
  the section's own page (`/settings/$page`) with the way back; old
  `?tab=` links land on the matching page. The always-shown explanations
  are one or two sentences, each keeping what stays on the Mac and what
  leaves it; the consent dialogs keep their full text.

### Statistics (U6b contract, U6c screen)

- **Where they come from.** Core computes them on demand from what the
  database holds and shows them on this Mac only (ADR 002).
- **Missing history.** A figure whose history is not recorded is not
  shown. Nothing new is recorded to feed them.
- **Delay.** Each figure has a « ⓘ » with its definition, and the
  query's cost is measured in U6b.

Shipped in U6b–c (2026-11-19), from `loadStatistics` in `packages/db`:

| Figure                  | Definition                                                                                         | Source                                   | Window           |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------- |
| Speech heard, per day   | Voiced time of conversations and moments, by local start day                                       | `episodes.voiced_ms`                     | The last 7 days  |
| Conversations           | Episodes of size conversation, by local start day                                                  | `episodes`                               | The last 7 days  |
| Where speech comes from | Voiced time by context: call, in person, media, dictation, imported                                | `episodes.context`                       | The last 30 days |
| People talked with most | Talk time of confirmed names in conversations' current transcripts, not media, not the user, top 5 | `speaker_turns`, the names the user gave | The last 30 days |
| Words transcribed       | Words in the current transcripts                                                                   | `segments`                               | Now              |
| Agent reads             | Tool calls by outside agents                                                                       | `agent_calls`                            | The last 7 days  |

Not shown yet: the union of voiced intervals across a Mac and iPhone pair
(today's figure counts each episode's own voiced time), storage on disk,
hours erased by the user, transcription delay and voices (named, suggested,
unnamed). Removals by retention are not recorded and stay out.

### Status

There is no status screen. The listening menu holds the short status, and
Settings ▸ Avancé holds the detail.

## 4. First run (U7)

There are six steps. The user's choice is saved as they move, so a
relaunch reopens the step, as today. Sondine's own text stays at 30 words
or fewer per step, except the reading passage, consent text and errors
(§5). Nothing is recorded for memory before the last step.

| #   | Step                                                                                                                                                                  | What it gives                                                          | What it teaches                                      | What it sets                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| 1   | « Que voulez-vous retrouver ? » under one line: « Sondine écoute ce Mac toute la journée. Tout reste ici. » Three cards: Réunions et appels · Toute la journée · Tout | The app set up without a tour of Settings, and the promise in one line | Always on, local                                     | The display defaults below         |
| 2   | Permissions with a live meter, and one line about others: « Les voix autour de vous sont aussi enregistrées ; prévenez-les si la loi le demande. »                    | Proof that Sondine hears                                               | The microphone, and system audio for calls and media | Sources                            |
| 3   | The model, or the branch for a Mac that cannot run it (below). Skipped when installed; a download goes on in the background                                           | Local transcription                                                    | Where the work happens                               | Model                              |
| 4   | A first memory: « Dites une phrase », then « Retrouvez-la : tapez un mot »                                                                                            | A first result, at once                                                | A conversation, search                               | —                                  |
| 5   | « Apprendre ma voix » (optional, « Plus tard » as plain as « Commencer »)                                                                                             | « Moi ? » suggested from the first day                                 | Voices carry names                                   | Recognition, with ADR 034's opt-in |
| 6   | What will happen: the sources that will record all day, what is kept and for how long, the menu bar icon. « Commencer l'écoute »                                      | No surprise after starting                                             | Pause, the menu bar                                  | Listening                          |

### Step 1: what the goal sets

The cards set what Sondine shows and suggests, never what it records. It
listens to the same sources whatever the card, as step 6 says before
anything starts.

| Goal               | Today shows first    |
| ------------------ | -------------------- |
| Réunions et appels | Conversations, calls |
| Toute la journée   | Everything by hour   |
| Tout               | Everything           |

The three goals keep the call offer during a pause and the journal on, and
ask for system audio.

- **Retention.** No card changes audio retention. ADR 029's defaults stay,
  and step 6 shows them.
- **Settings.** Each value already exists there. Step 1 only writes it,
  and Settings shows « réglé à l'accueil » until the user changes it.
- **Another goal later.** Choosing again in Settings ▸ Général asks for
  any permission the new goal needs.

### Step 2: the live meter

- **Transient.** The meter reads the microphone's level while the step
  shows and stores nothing. Its line says so: « Rien n'est enregistré. »
- **Order.** It starts only after macOS grants the microphone, and stops
  when the step changes.

### Step 3 on a Mac that cannot run a local model

- **When.** Sondine checks the fit as today. The model step's words say
  why:
  - « Ce Mac n'a pas assez de mémoire pour le modèle local » when the fit
    fails;
  - the model's own message when it is not supported on this Mac.
- **Choices.**
  1. A lighter local model, first, when one passes ADR 018's bar on this
     Mac.
  2. « Continuer sans transcription »: audio is kept and can be played,
     as today.
  3. A card: « Prévu : une transcription dans le cloud, conçue pour ne
     rien garder. » and « Me prévenir ».
  - **As built (Téo, 2026-11-19).** On a Mac too small, the step shows
    only this: the model is too heavy for this Mac, with an « ⓘ » saying
    how the cloud is planned (only if turned on; audio encrypted,
    transcribed, erased at once; nothing kept or read), and « Me prévenir
    par e-mail ». No download is
    offered there; Settings ▸ Modèle still allows one. Development builds
    have a switch that shows a Mac of 16 GB without the model.
- **What « Me prévenir » does.**
  - It stores `cloud.notify` on this Mac.
  - When the update check is on, a release that announces the service
    shows it once, in the update notice.
  - When the check is off, the button says « Activez la vérification des
    mises à jour pour être prévenu », with its own switch. Turning it on
    is a separate choice.
  - Nothing else: no e-mail, no account, no new request.
  - **Amended (Téo, 2026-11-19).** « Me prévenir par e-mail » opens a
    sign-up page in the default browser (`shared/cloud.ts`, provisional
    address `https://sondine.app/cloud`, the Worker `apps/cloud-waitlist`
    posting to a Discord webhook kept in Infisical), where the user leaves an e-mail
    to be contacted when the cloud is ready. Sondine itself still sends
    nothing: the page is the browser's, typed into by the user, and main
    allows that one address as an external link. The flag is still stored.
  - **Removed (Téo, 2026-11-28).** The first run no longer shows the
    card nor « Me prévenir », and nothing is stored: « Ce Mac » shows why
    in a dialog (the memory the model asks for, this Mac's, and that an
    update will offer a lighter model once one runs well), and Sondine
    Cloud is a card of its own with its terms. Settings keep their link to
    the sign-up page.
- **What it does not do.**
  - « Prévu » and « conçue pour ne rien garder » state an intention, not
    a service.
  - Building the cloud, or calling it available, needs a decision that
    amends ADR 002, `AGENTS.md`'s first priority and
    `docs/product-vision.md`, with its retention terms.

### Step 4: the first memory (U7a contract)

The test session is a contract of its own, with tests, before any screen
uses it:

- **Capture.** It records the microphone only, never system audio. It
  runs while the user holds the button (or between two presses of the
  button or of Space), 15 seconds at most. It is apart from listening,
  which stays paused.
- **Storage.** The audio and its text live in a test staging area. They
  are never an episode, never in search, the journal, agents or sync
  until kept.
- **Transcription.** It runs at once, without the power and idle
  conditions, when a model is ready. Without one, the step plays the
  sentence back and says transcription comes with the model.
- **Search.** The search box looks only in the test sentence.
- **End.**
  - « Garder » promotes it to a normal episode.
  - Otherwise it is deleted when the step is left, when the first run
    ends, and at every core start (crash, quit, relaunch). Tests prove
    each case and that nothing derived remains.
- **Failure states.** Microphone refused (the step offers System Settings,
  or « Passer »), no speech heard (« Je n'ai rien entendu. Réessayer »),
  transcription failed (« Réessayer » or « Passer »). The step can always
  be skipped.
- **Cost.** This touches capture: U7a reports its effect on the helper as
  AGENTS.md asks.

### Step 5: the voice read

- ADR 034 unchanged: when recognition is off, the step asks to turn it on
  with its own line; the print stays on the Mac; the recording is deleted
  at once; Settings ▸ Voix forgets it.
- The reading passage (about 75 words) is reading material, outside the
  word budget.
- « Plus tard » moves the read to Settings ▸ Voix and to a first-use hint
  on the first conversation where « Moi ? » could be suggested.

### Step 6: before listening starts

The sources (« Micro et son du Mac » or the ones granted), « Sondine
écoute jusqu'à ce que vous mettiez en pause », the audio kept by type
(ADR 029's defaults in one line, « ⓘ » for the detail), and the hint on
the menu bar icon. The button: « Commencer l'écoute ».

After the first run, Today is empty unless the user kept the first memory.
Its empty state says « Rien entendu aujourd'hui. » and the live dot shows
listening.

### iPhone (U9)

Done on 2026-11-23 (Téo asked for the iPhone to match the Mac and feel
as premium). The screens are in `docs/iphone-screens.md`.

- **Look.** The Mac's tokens and face: ink instead of orange, the
  neutrals, Allo (its WOFF2, read by Core Text, in the app and the
  widget extension), Graphical's motion curves. Red marks only a
  recording under way and what went wrong. Rows on the canvas, no
  grouped cards, except the rows of Réglages and Mac, grouped as the
  Mac's settings.
- **Home.** The recordings by day as the Mac's Today rows: the hour, a
  tile, the name or whom it heard, its journal line or where it stands,
  the length. A tile's waveform moves while a recording is sent or
  transcribed, with a ring for the share sent. While paired, « Journal du
  jour » on top shows the day's first journal line from the Mac.
  « Enregistrer » floats at the bottom, ink, and the recording screen
  zooms out of it. The « Prêt » line is gone; what waits shows in each
  row and on « Mac ».
- **Recording.** The time, large; the last seconds' level as bars that
  freeze and fade at an interruption; « Arrêter », round; « Reprendre »
  beside it after an interruption.
- **A recording.** Its name is the page's title (typed in place), then
  one line: day, hour, length, and its state until transcribed. A
  player with its progress, the journal lines and commitments (each
  opening its sentence), the notes, the transcript. « Partager… »,
  « Ajouter une note… », « Renommer » and « Supprimer… » in « ··· ».
- **Aujourd'hui.** The Mac's Today on the phone: conversations with
  their journal lines, then the open commitments, late first; a
  sideways swipe or the arrows change the day.
- **First run.** The Mac's: the steps as a bar across the top, each
  page centered, a title and one sentence that rise in turn, « Retour »
  as a round button on the left. 30 words a page at most.
- **Réglages.** Rows with an icon and their state: Mac, what waits,
  version, expiry, « Confidentialité et licence ».
- **Demonstration.** A debug build launched with `-SondineDemo` shows
  invented recordings and an invented paired Mac that answers the
  memory reads (`demo-data.swift`); `-SondineFirstRun` starts it on the
  first run. Captures use it, never real data.

## 5. Words on screen

This counts the screen's own text, not the user's data. Each number is
for a rendered state, in French, which is the longer language; English is
checked too.

- **Now** sums the message keys a screen shows in that state. The figure
  in parentheses counts everything visible with invented data.
- **M6** is the budget.

Exempt from budgets:

- the voice read's passage;
- the full text of a consent: ADR 027's chat, agents, Claude for the
  journal, the iPhone pairing;
- an error's cause and its action.

Exempt text is in a modal or a popover, never on the resting screen.

| Screen, state                            | Now                   | M6 budget                |
| ---------------------------------------- | --------------------- | ------------------------ |
| Sidebar and listening control, listening | 18                    | 8                        |
| Today, a day with conversations          | 20 (155 with data)    | 12                       |
| Conversation, transcribed                | 25–45 (140 with data) | 12                       |
| Conversation « ··· »                     | 30                    | 20                       |
| Search, empty                            | 25                    | 4                        |
| People, empty                            | 25                    | 8                        |
| Agent panel, empty                       | 20                    | 10 (without the consent) |
| Status (now a screen, then the menu)     | 80–120                | 20                       |
| Settings, a tab                          | 680 for the page      | 120 a tab                |
| First run, a step                        | 40–100                | 30                       |
| Call offer notification                  | 15                    | 10                       |

**Test (U0).** It renders each listed state with fixtures and counts the
visible words that come from message keys, in both languages. It starts
as a passing baseline at today's numbers. Each U-step lowers the budget
of the screens it converts, so a converted screen cannot grow back.
Budgets are review thresholds: safety and understanding come first, and
an exception is written beside the screen's row.

## 6. Motion catalogue

- **Curves.** Small means `--motion-duration` and `--motion-easing`; Large
  means `--motion-large-duration` and `--motion-large-easing`. These are
  live tokens, 200 and 360 ms in the theme today.
- **Roles.** Graphical's role decides the curve: controls, menus and small
  popovers use Small; dialogs, drawers, toasts, navigation surfaces (⌘K,
  the palette) and disclosure panels use Large.
- **What animates.** Only opacity and transform. Layout (width, height,
  position in flow) changes at once.
- **Reduced motion.** Under « Réduire les animations », every animation
  below is immediate. Live meters keep showing the signal.

| #   | When                          | What moves                                                                                             | Curve |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------ | ----- |
| 1   | Listening ↔ pause             | The two states of the button cross-fade (two layers' opacity)                                          | Small |
| 2   | A new conversation in the day | The row fades in and moves 4 px down to its place (transform)                                          | Small |
| 3   | Open a conversation, go back  | The content fades and rises 8 px                                                                       | Large |
| 4   | Confirm a voice               | The ✓ scales from 0.8 and fades in; the « ? » fades out                                                | Small |
| 5   | Agent panel opens, closes     | It slides from the right (translateX); the backdrop uses the theme's overlay when it covers the screen | Large |
| 6   | Menus, popovers               | The primitive's own: fade and `--motion-popup-scale`                                                   | Small |
| 7   | ⌘K, palette, dialogs          | The primitive's own                                                                                    | Large |
| 8   | Toast                         | Rises from the bottom (translateY)                                                                     | Large |
| 9   | First-run step                | The outgoing step fades; the next rises 12 px; no progress bar (Téo, 2026-11-28)                       | Large |
| 10  | First memory found            | The matched word's highlight fades in                                                                  | Small |
| 11  | Live text                     | New words fade in                                                                                      | Small |
| 12  | Play ↔ pause                  | The icons cross-fade; the playing sentence's highlight fades                                           | Small |
| 13  | First-use hint                | Fades in beside its control and fades out on use                                                       | Small |
| 14  | Press                         | `--motion-press-distance` (translateY)                                                                 | Small |

No other animation is added.

## 7. Steps

Each step is one thread, merged on its own, with `pnpm check` green and
its measures. A screen or route leaves only in the step that delivers its
replacement. A redirect keeps the route's parameters and lands on that
replacement.

| Step  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Exit                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| U0    | Check that Graphical (ADR 033) is in `main`. Set the visual direction of §3 in the Graphical theme (Allo, white and black bases, pills), through the editor, and amend ADR 009 for Allo. Add the object menu, voice popover, first-use hint and « ⓘ » popover to `packages/ui` and the design system page. Add the word-budget test as a passing baseline, and `pnpm ux:shots` with `pnpm ux:paths`: seeded invented data, fake hardware, CDP captures and scripted click paths | The patterns on the design system page; baselines recorded; the paths script runs every P row of §2     |
| U1    | The listening control and its state matrix, the listening menu (status, timed pauses, keep, erase), the banner for failures only, « Demander » as a placeholder that opens Chat                                                                                                                                                                                                                                                                                                 | Pause and resume in one click; every state of the matrix tested; the window's idle CPU before and after |
| U2    | Today: commitments, the journal block with citations and its states, the filter chip, the play button; the Journal screen leaves (redirect)                                                                                                                                                                                                                                                                                                                                     | Every journal row of §2 reachable; Today within budget                                                  |
| U2b   | People and a person, with « Voix sans nom »                                                                                                                                                                                                                                                                                                                                                                                                                                     | Person actions in the « ··· »                                                                           |
| U3    | Conversation: the header, Share popover, voice popover and ✓, sentence « ··· », context chips, privacy and same-moment lines, « ··· »                                                                                                                                                                                                                                                                                                                                           | Confirm a voice and open sharing in one click; every conversation row of §2; within budget              |
| U4    | Search chips; import by picker, drop and palette, with its toast; the Imported screen leaves (redirect)                                                                                                                                                                                                                                                                                                                                                                         | Import from every screen; drop zones distinct; Search within budget                                     |
| U5a   | Core: a discussion's focus, and its optional limit enforced in the tools, with tests (conversation, day, person)                                                                                                                                                                                                                                                                                                                                                                | A limited discussion cannot read outside its focus                                                      |
| U5b   | The agent panel; the Chat screen leaves (redirect)                                                                                                                                                                                                                                                                                                                                                                                                                              | ⌘J from every screen; focus and Esc; ADR 027's guarantees tested again                                  |
| U6a   | Settings tabs with « ⓘ », the journal's settings, Avancé; the Status screen leaves (redirect)                                                                                                                                                                                                                                                                                                                                                                                   | 120 words a tab; every former section reachable                                                         |
| U6b   | Core: the statistics of §3, with tests and their query cost                                                                                                                                                                                                                                                                                                                                                                                                                     | Each figure matches a hand count on fixtures; no figure without history                                 |
| U6c   | The Statistiques tab                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Within budget; definitions in « ⓘ »                                                                     |
| U7a   | Core and helper: the first-memory test session of §4                                                                                                                                                                                                                                                                                                                                                                                                                            | Its tests: microphone only, bounded, deleted on every path; the helper's cost reported                  |
| U7b   | The goal defaults, the model eligibility branch, `cloud.notify` and its update notice                                                                                                                                                                                                                                                                                                                                                                                           | `cloud.notify` local only; no request added (checked as in ADR 002's soak)                              |
| U7c   | The six screens of the first run                                                                                                                                                                                                                                                                                                                                                                                                                                                | 30 words a step; time to the first sentence found, measured; every failure state shown                  |
| U8    | Menu bar, notch and call offer: words and motion                                                                                                                                                                                                                                                                                                                                                                                                                                | The same words as the window; within budget                                                             |
| U9a   | iPhone: inventory and budgets, like §2 and §5                                                                                                                                                                                                                                                                                                                                                                                                                                   | `docs/iphone-screens.md` updated                                                                        |
| U9b–c | iPhone: first run, then home and recording, with the same rules                                                                                                                                                                                                                                                                                                                                                                                                                 | Within budget; `pnpm test:ios`                                                                          |

Each U-step adds a note in `changes/` (users see it) and updates this
file's state.

## 8. Measures

Every step reports these, and they are kept here:

- **Clicks.** `pnpm ux:paths` drives each P and S row of the step through
  the real window on fixtures and records access and done costs. A
  primary action must have an access cost of 1.
- **Words.** The budget test of §5, in both languages, plus the word count
  of each shot with invented data, as a trend.
- **Motion.** Each animation names its catalogue row in a code comment;
  anything else fails review. Reduced motion is checked by emulating
  `prefers-reduced-motion`.
- **Accessibility.**
  - Every new pattern (listening control, voice popover, agent panel,
    sentence « ··· », hint, toast) states and tests its keyboard path, its
    focus on open and close, and its label for VoiceOver.
  - State changes are announced through a live region.
  - Single keys (Space, arrows) never act while a text field, an editor
    or a native control has focus.
  - A toast stays while focused or hovered, and ⌘Z works after it leaves.
- **Privacy.** U5a's limit tests, U7a's lifecycle tests, and U7b's check
  that no request was added.
- **Cost.**
  - Core, the renderer and the helper report CPU and memory where a step
    adds work: U1 (live status), U5a (limited tools), U6b (statistics
    queries), U7a (test capture), U7c (meter).
  - Steps that do not touch capture say so, backed by an unchanged helper
    diff.
- **First value.** U7c measures the time from step 4's press to the
  sentence found on a Mac with a model, and states it.

## 9. Open points

- The lighter local model for step 3 depends on ADR 018's measured
  engines. Until one passes, the branch offers only « Continuer sans
  transcription » and the cloud card.
- Statistics show only what is recorded. Searches, playback and
  retention's removals are not recorded, so they are not shown unless a
  later decision records them locally.
- Téo validated the plan and the direction on 2026-11-19; ADR 037 is
  accepted.

## 10. Review (2026-11-18)

Codex gpt-6-astra and gpt-6.1-sol reviewed ADR 037 and this plan. The
6.2 Sol model is not available to this Codex account.

Both reviews agreed on almost every point. Each finding was checked
against the ADRs and the source before it was accepted.

### Accepted and changed

| Finding                                                                                                                                             | Change                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Deleting a recording was listed with an undo toast, against ADR 017 (blocker, both)                                                                 | Deletions and erasures keep their confirmation. Undo is for edits only (ADR 037).                                      |
| « Écoute / En pause » hid partial capture, unconfirmed pauses, failures and private-zone holds (blocker)                                            | The state matrix in §3, the banner kept for failures, « Écouter quand même » kept                                      |
| The first memory had no complete privacy lifecycle (blocker, both)                                                                                  | The U7a contract in §4, with tests on every path and its cost reported                                                 |
| The goal cards suggested capture limits they do not apply                                                                                           | The cards set display only. Step 6 says what records; no card changes retention.                                       |
| ADR 034's opt-in and the « Moi » promise were lost                                                                                                  | Step 5 keeps ADR 034 and says « Moi ? » suggestions                                                                    |
| The cloud card promised a date and a retention guarantee                                                                                            | « Prévu… conçue pour ne rien garder ». The update check stays a separate choice. The amendments are named.             |
| The agent's scope had no meaning; removing the chip widened it                                                                                      | The chip is a focus; « Limiter » is enforced in core (U5a). ADR 027's guarantees are acceptance criteria.              |
| Capabilities without a destination (journal settings and screen, site, source page, context actions, voice actions, same-moment link, privacy line) | The inventory now lists each one with its home and step                                                                |
| Rules contradicted the screens (« nothing else is a button », hover-only play, a chip with two meanings, share in two places)                       | ADR 037's rules rewritten. Play always shown. ✓ and the name are separate targets. Share lives in its popover only.    |
| Click counts mixed reaching a control with finishing a task                                                                                         | Access and done costs, with typing, dialogs and confirmations apart                                                    |
| Dropping a file had two meanings; no file picker                                                                                                    | Drop zones defined, a picker in three places, a toast for progress and failure                                         |
| Word budgets could not hold the required text; counting keys missed the visible state                                                               | Rendered states in both languages, named exemptions, ratcheting budgets                                                |
| The motion catalogue animated layout; ⌘K used the wrong curve                                                                                       | Layout changes at once; curves follow Graphical's roles                                                                |
| Accessibility was only reduced motion                                                                                                               | The measures add keyboard, focus, announcement and timing for each pattern                                             |
| Steps could not all ship alone; U0 left a failing test                                                                                              | Each removal moves to the step of its replacement; baselines start passing                                             |
| U6, U7 and U9 were too big                                                                                                                          | Split into U5a–b, U6a–c, U7a–c and U9a–c, contracts before screens                                                     |
| Statistics had no definitions                                                                                                                       | §3 defines each figure. Retention's removals are not shown.                                                            |
| The evidence was read as proof of use; screenshots cannot check click paths                                                                         | The evidence is labelled as hypotheses; `pnpm ux:paths` and the privacy tests added; cost measured where work is added |
| The first value came late; the post-test home was not empty as promised                                                                             | The promise joins the goal step. The first memory comes before the voice read. The empty home is stated as it is.      |

### Kept as they were

The reviews asked to keep these: Today as home with the journal on top,
the three sidebar entries, the transcript as the conversation's page, the
⌘J panel, direct pause and voice confirmation,
the first memory, the optional voice read, local statistics, Mac before
iPhone, Graphical's primitives, invented data in captures, and no cloud
built under this plan.

### Not taken

None. Téo settled the two open choices on 2026-11-19:

- **No « Notes vocales » card.** Other apps do voice notes well; the first
  run offers three goals.
- **The agent reads everything by default.** Limiting it to the focus
  costs it too much; the limit is an option, enforced when it is on.

### Code review (2026-11-19)

Codex gpt-6-astra reviewed the implemented steps' core changes:

| Finding                                                                                  | Outcome                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A limited discussion's search still returned totals for other days (blocker)             | Broad tools are refused before they run under a limit; reads are checked after                   |
| The limit lived in the window and was lost on restart                                    | Focus and limit are stored with the discussion (migration `chat_focus`)                          |
| « Limiter » during an answer did not hold the answer back                                | The key reads the stored limit at every call, and the check runs again until the limit is stable |
| Deleting a person missed discussions that read a conversation where they were recognized | Deletion also erases the discussions that read those conversations (pre-existing, fixed here)    |
| « Lectures des agents, 7 jours » counted 30 days                                         | Counted from the first charted day                                                               |
