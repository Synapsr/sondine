# 037 — UX redesign: action levels, text budget, motion, one way to do each thing

Status: Accepted — 2026-11-19 (proposed 2026-11-18; Téo validated the plan,
`docs/ux-redesign.md`, and its direction); amended 2026-11-20 (the dock
goes: search and « Demander » live in the sidebar)

## Context

Sondine grew one feature at a time, each with its own screen, settings
section and explanation. In November 2026 the Mac window has eight sidebar
entries, a single Settings page of fourteen sections (about 680 visible
words), a first run of about 310 words, and secondary actions that sit two
to four clicks away in different places on each screen. Pausing takes two
clicks from the window and from the menu bar.

Two weeks of Téo's own data (aggregates from his database, no text) point
to what matters, as hypotheses to check: about eleven conversations a day,
and voices named on five days out of fourteen. Context items, kept audio,
titles, journal marks and the in-app chat were used at most twice each.
Searches and playback are not recorded.

Téo asked for an app that is far more minimal, simple and coherent, with
Granola as the reference. He asked for:

- a first run where every step gives something, teaches, and sets the app
  up for what the user wants;
- primary actions in one click, secondary ones in two steps, rare ones
  further away;
- as little text as possible, with teaching in popovers and modals rather
  than on the screen;
- subtle motion where it helps.

He chose:

- the day as home, with the journal on top;
- removing the Status, Imported, Journal and Chat screens as places;
- an agent panel that starts where it opens and can read everything,
  with a limit as an option;
- statistics;
- a first memory recorded during the first run;
- the Mac first;
- a card for Macs too weak for the local model, announcing a cloud
  without retention.

The product does not change (`docs/product-vision.md`): local, always on.
The redesign changes how things are reached and said, and adds only the
contracts it names (a first-run test session, an optional limit for
agent discussions, statistics computed from existing data). The theme comes from
Graphical (ADR 033), whose work is not yet in `main`; the redesign builds
on it and starts once it has landed.

## Decision

### Action levels

Every user action belongs to one level, recorded in the action inventory
of `docs/ux-redesign.md`.

- **How it is counted.**
  - **Access** is the number of clicks to reach the control that does the
    action.
  - **Done** is the full cost: clicks, then typing, native dialogs and
    confirmations, each written apart.
  - Both are counted from a stated start: the screen showing the object,
    anywhere in the window for global actions, the menu bar for its menu.
- **Primary: an access of one click, and a visible control.**
  - Open the day, open a conversation, play, search (⌘K).
  - Pause or resume.
  - Confirm a suggested voice.
  - Open sharing, open the agent (⌘J).
- **Secondary: an access of two steps at most.** The first step opens a
  control that is always in the same place (the « ··· » menu, the voice
  popover, the Share popover, the listening menu, a filter chip, the agent
  panel); the second is the action.
- **Rare: Settings or the command palette (⇧⌘P).**
- **Deletion stays as ADR 017 says.** Deleting a recording, erasing the
  last minutes and deleting a person erase for good, after a confirmation.
  Undo, with its toast, is for edits only.

### Navigation

- **Sidebar.** Today, Calendar, Commitments, Search (⌘K), « Demander »
  (⌘J), People, with Settings at the bottom. Today stays the landing
  screen. The listening control sits in the window's top band.
  « Demander » opens and closes the agent panel and stays lit while it is
  open.
- **No floating dock** (amended 2026-11-20). The dock at the bottom of
  the screen repeated the sidebar's search and covered the end of each
  screen; « Demander » moved to the sidebar, which has room, rather than
  to a floating button that would get in the way. The player sits at the
  foot of the screen, below its scroll, so nothing passes under it.
- **Screens that go.** Status, Imported, Journal and Chat stop being
  screens, each in the step that delivers its replacement:
  - Today shows the open commitments and the day's journal (with its
    citations and its states) above the conversations.
  - Import is a picker (the day's « ··· », the palette, the menu bar) and a
    drop on the window, with a toast for progress and failure.
  - Status moves to the listening menu, with the detail in Settings ▸
    Avancé.
  - Chat becomes the agent panel.
- **Redirects.** A route that goes redirects for one release, with its
  parameters.

### The listening control

- **Two targets.**
  - The button says the confirmed state and does its one action.
  - The chevron opens the listening menu: the status first, then timed
    pauses, keep, erase and import.
- **States.** The button follows the helper's confirmed state, including
  partial capture, an unconfirmed pause, a pause until a time, a
  private-zone hold (with ADR 029's « Écouter quand même ») and failures.
- **Banner.** Failures that stop capture without the user asking keep a
  banner; a plain pause does not.

### The agent: one panel that starts where it opens

- **The panel.** The chat of ADR 027 becomes a side panel (⌘J, or
  « Demander »).
- **Focus.** A discussion starts on the conversation, day or person it
  opened on (« Tout » from elsewhere) and can read every conversation, as
  the chat does today: limiting it costs it too much.
- **Limit, as an option.** « Limiter » in the focus chip's menu, or a
  Settings default (off), restricts a discussion to its focus. Core
  enforces it: that discussion's tools read only within the focus.
- A discussion keeps its focus and its limit.
- **ADR 027.** Its consent, its rule that nothing is sent before Send,
  Stop, the provider shown, deletion, and erasure with what a discussion
  read are unchanged, and they are acceptance criteria of the panel.

### Statistics

- **Where.** Settings gains « Statistiques », also reached from the
  palette.
- **What.** Each figure is defined in `docs/ux-redesign.md` (source,
  window, overlap and confidence rules).
- **How.** Core computes them on demand from data the database already
  holds, and shows them on this Mac only (ADR 002).
- **No new tracking.** A figure without recorded history (retention's
  removals, searches, playback) is not shown, and nothing new is recorded
  to feed one.

### Text budget

- **Budgets.**
  - Each screen state has a word budget for its own text: labels,
    headings and helper lines, not the user's data.
  - It is counted on the rendered state in French and English, by a test.
  - The test starts at today's numbers, and each redesign step lowers the
    budgets of the screens it converts.
- **What is exempt.** A reading passage, the full text of a consent, and
  an error's cause and action. They live in a modal or a popover, not on
  the resting screen. Safety and understanding come before a budget, and
  an exception is written down.
- **Where longer text goes.** An inline helper line has twelve words at
  most. Anything longer goes in:
  - an « ⓘ » popover;
  - a modal at the moment it matters;
  - or a first-use hint.
- **First-use hints.**
  - A hint points at one control and shows once.
  - It disappears when that control is used or the hint is closed, and
    never shows beside another hint.
  - Hints are stored as settings (`hints.<id>`).
- **Empty states and errors.** An empty state is one line and at most one
  action. An error is one line that says what to do, with its action.
- **Icons.** An icon-only button has an accessible name and a tooltip.

### Motion

- **Tokens.** Motion uses Graphical's tokens and roles (ADR 033):
  - the small curve for controls, menus and small popovers;
  - the large curve for dialogs, drawers, toasts, navigation surfaces (⌘K,
    the palette) and panels.
- **What it is for.** Primary actions and changes of state: listening,
  pause, a new conversation, a confirmed voice, the agent panel, a step of
  the first run.
- **What animates.** Only opacity and transform. Layout changes at once,
  and nothing animates on the capture or playback path.
- **No decorative loop.** A live meter and live text move with the signal.
- **Reduced motion.** Under « Réduire les animations », every animation is
  immediate, as Graphical's zero-duration rule says.
- **The catalogue.** Each animation is listed in `docs/ux-redesign.md`. An
  animation that is not listed is not added.

### Coherence: one way to do each thing, the same gesture everywhere

- **One home.** Each action has one home control. A shortcut, the palette
  and the menu bar may reach it too. A row's play button and « Demander »
  are named exceptions, so a primary action can be reached where the eye
  is.
- **Object controls.** Every object (a day, a conversation, a person, a
  search's results) has the same kinds of controls:
  - its primary buttons;
  - a Share control where it can be shared, holding copy and export;
  - one « ··· » at the top right for its own actions, with delete last,
    in red;
  - right-click opens the same « ··· ».
    Secondary controls that belong to content stay where the content is: a
    date's arrows, a commitment's checkbox, a filter chip.
- **Voices.** A voice's name opens the voice popover everywhere. A
  suggestion has a separate ✓ that confirms it in one click.
- **Hover.** Nothing needed shows only on hover: what hover reveals also
  shows on keyboard focus and in a menu.
- **Keys.** The same everywhere: ⌘K search, ⌘J agent, ⇧⌘P palette, Space
  play or pause, ←/→ five seconds, ↑/↓ sentence, Esc closes the top layer
  and returns focus, ⌘Z undoes. Single keys never act while a text field,
  an editor or a native control has focus.

### The first run

Six steps (detail in `docs/ux-redesign.md`), each with 30 words at most of
Sondine's own text outside the exemptions:

1. What the user wants to find again (three goals), under the promise in one line.
2. Permissions, with a live meter and a line about the other people
   recorded.
3. Where to transcribe (ADR 040: this Mac, the user's machine, the beta),
   then the transcription model, offered only for this Mac.
4. A first memory.
5. The voice read (optional, ADR 034 unchanged).
6. What will record and be kept, then « Commencer l'écoute ».

- **The goal choice** (meetings and calls, the whole day, everything)
  writes what Today shows first, a display default Settings holds. It
  never changes what Sondine records or how long audio is kept; step 6
  says both before listening starts. Téo dropped a voice-notes goal: other
  apps do it well.
- **The live meter** reads the level while its step shows and stores
  nothing.
- **The first memory** is a test session, its own contract:
  - it records the microphone only, while the user holds the button (or
    between two presses), 15 seconds at most, with listening still
    paused;
  - its audio and text stay in a staging area, out of search, the
    journal, agents and sync;
  - it is transcribed at once when a model is ready;
  - « Garder » makes it an episode; otherwise it is deleted on leaving the
    step, at the end of the first run and at every core start;
  - tests cover every path, and its cost on the helper is reported.
- **A Mac that cannot run a local model** gets:
  - a lighter local model when one passes ADR 018's bar;
  - otherwise « Continuer sans transcription », as today;
  - and a card: « Prévu : une transcription dans le cloud, conçue pour ne
    rien garder. » with « Me prévenir ».

  The button stores `cloud.notify` on this Mac. The news arrives through
  the update check, which stays the user's separate choice. There is no
  e-mail, account or new request. The card states an intention, not a
  service. Building the cloud or calling it available needs its own
  decision amending ADR 002, `AGENTS.md`'s first priority and
  `docs/product-vision.md`.

### Visual direction

The layouts follow Granola's spirit, as Téo chose: soft cards, pill chips,
buttons with the sidebar's small radius (Téo, 2026-11-19), one primary
button per screen, the primary actions in the sidebar. The type is one family, Allo (SIL Open Font License), with no
serif; the base is a neutral white, and black for the dark appearance;
a light red marks speech heard live (Téo, 2026-11-19) and Sondine's orange the brand mark. The
layout is what this decision fixes. The values go through Graphical's
editor (ADR 033) in the first step, and replacing Timeless Grotesk with
Allo amends ADR 009. `docs/ux-redesign.md` §3 holds the detail.

### Scope and order

- The Mac app first. The iPhone app (ADR 031) follows the same levels,
  budgets and motion rules after an inventory of its own.
- Implementation waits for the Graphical work (ADR 033) to land in
  `main`.

## Consequences

- **Functions.** Four screens and Today's two lanes disappear as places;
  every function they hold keeps a named home in the plan's inventory.
- **Settings.** It becomes tabs (Général, Écoute et confidentialité,
  Voix, Appareils et agents, Statistiques, Avancé). Long explanations move
  into « ⓘ » popovers.
- **`packages/ui`.** It gains the object menu, the voice popover, the
  first-use hint and the « ⓘ » popover, shown on the design system page.
  No new icon provider; new glyphs stay within ADR 009's subset.
- **Reports.** Each redesign step reports access and done costs, words per
  state, the animations it uses, its accessibility checks and its cost
  where it adds work. A screen over its budget is not done.
- **New contracts.** Core gains three, each tested before a screen uses it:
  - the first-run test session;
  - the optional limit of a discussion;
  - statistics.
- **The cloud card** is the only mention of a cloud in the app until a
  decision about the cloud is accepted.
