# 036 — A notification when a call starts

Status: Accepted — 2026-11-17; amended 2026-11-20 (a call while Sondine
listens, « Ne pas écouter cet appel », `shown` logged on macOS's word) and
2026-11-25 (the island says the call, with a switch; a call's end; a forgotten
pause)

## Context

Téo pauses Sondine, then a Discord or Zoom call starts and nothing records
it. He asked for a notification that offers to start listening.

The helper already watches the process catalog during a pause: private zones
need to know whether a call is going on whatever the pause (ADR 029). But it
reported calls (`call`) only while Sondine listened to something, because a
`call` event opens a call span, and a call span shapes episodes (ADR 007,
ADR 025). Sondine sent no macOS notification before. Since Electron 42,
Electron's `Notification` uses Apple's User Notifications framework on macOS:
it takes buttons, a stable id to remove a delivered notification, and it
needs a signed app (an unsigned build gets `failed`). A Swift helper cannot
notify in Sondine's name, because macOS credits notifications to the bundle
that sends them.

## Decision

- **What triggers an offer: a call, nothing else.** The call sources are
  the ones `CallPolicy` already uses: a call app, a call daemon (FaceTime),
  or a browser that uses a microphone while it plays sound (Meet, Teams,
  Zoom on the web). A dictation app or a video is not a conversation.
- **The helper says the calls it sees, paused or not (`call.seen`, protocol 7)**, from the same catalog pass as `call`: same sources, never Sondine or
  an excluded app, one id per active span, replayed in snapshots. It adds no
  listener, no timer and no polling: during a pause the catalog already
  runs for the zones, and the pass now also runs `CallPolicy` over what it
  sees, then sends one event when a call starts and one when it ends. A
  `call.seen` never opens a call span.
- **Core decides the offer** (`call-offers/`, from the helper's events in
  socket order, holds included): the latest call seen, while the user's
  pause covers anything, if the pause began at least a minute before the
  call (a pause taken during a call or just before it was meant for it), if
  the app is not muted, if the user has not declined that call, and while no
  private zone holds capture (a lifted one does not count), and only once the
  session's snapshot has said both the calls and the holds. A zone keeps the
  upper hand, and listening would record nothing under it anyway. The offer
  is `ListeningStatus.callOffer`.
- **Main shows it once per call**, as a macOS notification with three
  buttons: « Écouter cet appel », « Reprendre l'écoute », « Pas pour <app> »,
  and as « Écouter l'appel <app> » in the menu bar while the offer lasts (the
  fallback where notifications are refused or the build is unsigned). The
  notification is removed when the offer goes. (The amendment of 2026-11-25
  replaces this where there is a notch.)
- **Every answer is an oRPC procedure** (`callOffers.listen`,
  `callOffers.decline`, `listening.resume`), never on MCP: an agent does not
  answer for the user.
- **« Écouter cet appel » listens for that call only.** Listening resumes
  what the pause covered, and stores in the same transaction the call's app
  with the pause it replaced, its flags and its deadline
  (`capture.call-listen`). Once no call of that app has been seen for 10 s,
  and only after a snapshot has said what the helper sees, Listening reads
  the stored intent again and pauses as before. Any pause or resume the user
  makes meanwhile drops the record, so a newer intent is never rewritten. A
  timed pause whose end passed during the call is not restored. The record
  is durable: after a restart, the helper's snapshot says whether the call
  still goes on.
- **A timed pause offers too**: its end was chosen without this call in mind.
- **Settings ▸ Écoute**: the offer is on by default, since it records nothing
  until the user accepts; the muted apps are listed with « Prévenir à
  nouveau » (« Proposer à nouveau » before the amendment).

## Amendment — 2026-11-20: a call while Sondine listens

Téo listens without pausing, so the offer never came, and he had no word of
his calls. He asked for the notification while listening too.

- **The same offer, two kinds** (`CallOffer.kind`): `listen` during a pause
  (unchanged), `skip` while nothing is paused. A `skip` offer is made for
  every call seen, with the same rules otherwise: never for a muted app, a
  call already answered, or while an unlifted private zone holds capture (we
  are not really listening). Nothing is offered while Sondine listens or
  pauses for one call.
- **« Sondine écoute cet appel »**, body « Appel <app> », with « Ne pas
  écouter cet appel » and « Pas pour <app> »; the menu bar offers « Ne pas
  écouter l'appel <app> ». One notification per call and kind, removed when
  the offer goes.
- **« Ne pas écouter cet appel » mirrors « Écouter cet appel »**
  (`callOffers.skip`, never on MCP): it pauses everything and stores, in the
  same transaction, the call's app and that Sondine was listening
  (`capture.call-listen`, `kind: "skip"`). Once no call of that app has been
  seen for 10 s, after a snapshot, Listening reads the stored record and the
  stored flags again and resumes, only if the flags are still the full pause
  the call set: any pause or resume of the user's drops the record. The
  record is durable, so a restart ends it the same way: Sondine never stays
  paused for a call that is over. The end is checked again once Listening's
  lock is taken (the call may be back, or a new helper session not settled),
  and a resume the helper refuses is tried again every 30 s until the helper
  holds the intent of the moment. The menu bar reads « En pause le temps de
  l'appel <app> » meanwhile.
- **One switch** (« Prévenir quand un appel commence ») covers both kinds,
  with one list of muted apps.
- **`shown` means macOS took it.** Main logged `call-offer.notice shown:true`
  right after `show()`, before macOS answered. It now logs it on Electron's
  `show` event (the request was added to Notification Center) and `failed`
  with the reason otherwise. Electron asks macOS for authorization when its
  presenter is created (at launch, by `getHistory`); launching with
  `ELECTRON_DEBUG_NOTIFICATIONS=1` and `ELECTRON_ENABLE_LOGGING=1` logs the
  answer.
- **Settings ▸ Écoute says when macOS keeps the notifications off the
  screen.** Electron never says macOS's answer, so a small Node-API addon
  (`native/notification-settings.m`, packaged builds) reads Sondine's
  notification settings from User Notifications: denied or never allowed
  reads « macOS bloque les notifications de Sondine. », an alert style of
  « Aucun » (or a provisional authorization) « Les notifications de Sondine
  n'apparaissent pas à l'écran. », each with « Ouvrir les réglages » (System
  Settings ▸ Notifications ▸ Sondine). It is read again when the window gets
  focus back. Allowed says nothing. On Téo's Mac on 2026-11-20 macOS refused
  the authorization: no notification had ever reached his screen.

## Amendment — 2026-11-25: the island, with a switch

Téo asked for notifications that do more: a call with an inline switch. A
macOS notification holds no switch: only buttons, under « Options » on a
banner. His logs said the rest: an offer on screen during a pause was answered
in the window instead, and one call was said three times in 15 s, because its
app had dropped its microphone for 55 ms twice.

- **Where there is a notch, the island says it, not a notification.** One
  island (ADR 025) holds the call and whom it may be with. Compact, all call
  long: the app's icon, or her initial, left of the notch; « ? » when someone
  is suggested, and a dot, full while Sondine may record, right of it. When a
  call starts (an offer, as before), it grows for 8 s: « Appel Discord », what
  the capture does, and the switch. Open: the same row, « Ouvrir » and
  « Terminer » (ADR 044) when a recording goes on, the people and their
  conversations, « Masquer les personnes pour cet appel », « Ne plus prévenir
  pour <app> ». The switch does not move when the island opens under the
  pointer. It stays in a call whose offer was not made (a pause taken during
  it), without saying anything on its own.
- **The switch shows what the capture does**, as the menu bar does: on while
  Sondine may record (a pause not confirmed included), off once the pause is
  confirmed, absent when neither is known. It moves when core says so, not
  when it is clicked. Its answers are `callOffers.listen` and
  `callOffers.skip`, with no new procedure: while a call is answered, each
  takes the other back by putting back the intent before, with the same
  guards, under one hold of Listening's lock: a resume that comes meanwhile
  is applied after it. Not listening to a call during a
  partial pause pauses the rest, and only the rest comes back. The menu bar
  offers the same switch all call long.
- **A call lasts until its app has not been seen in one for 10 s.** The
  helper gives a new id each time an app takes its microphone again; core
  keeps the first one, so a flap is neither another call nor another notice,
  and a declined call stays declined. A call is said once, whatever its offer
  becomes. A helper session's end ends no call before its snapshot has said so.
- **A call's end** is a card in the island, for 8 s or while the pointer is on
  it: what was recorded (« Ouvrir », « Terminer » while it is open) and the
  intent that came back, once the helper has confirmed it (after a restart
  too). Nothing recorded and nothing to bring back: no card.
  Core says it 10 s after the call was last seen (`callEnded`, in memory).
- **A forgotten pause** is a card too: everything paused, confirmed, for 3 h
  with no end,
  once someone is at the Mac (unlocked, used less than a minute ago); once per
  pause, stored before it is said (`capture.pause-reminded`), never before the
  first run is done. « Reprendre l'écoute » is the only button; it changes
  nothing on its own.
- **Without a notch, with a failing helper, or with a second display** (the one
  in use may not be the notch's), the same things are notifications. Main
  waits for the helper's word (`ready`, `no-notch`) before choosing.
- The app's icon goes to the helper as a small PNG on its wire: it still reads
  no file. Focus does not hide the island, and it may show in a shared screen
  (`sharingType` is not honored by ScreenCaptureKit), as ADR 025 says.

## Consequences

- The notch helper runs all call long, not only once someone is recognized:
  15 MB with a call and someone suggested (2026-11-25; CPU and wakeups at rest
  as ADR 025 measured them, not measured again), and for
  some 10 s for a card. Core reads the call's open episode with each of the
  importer's commits while a call goes on (one query, as call voices do). A
  pause with no end keeps one timer; once 3 h old, core asks main each minute
  whether the Mac is in use, until it has said it.
- Protocol 7: a helper and a core of different versions refuse each other at
  `hello`, as before.
- The helper knows, during a pause, when a call starts and ends, and says
  it to core. Core keeps it in memory only; nothing of a call seen during
  a pause is stored, except the app the user muted and, while Sondine
  listens for a call, that call's app.
- The pause's cost (S6) gets one catalog pass per process change, as before,
  and two events per call. It was not measured again: measuring S6 means
  pausing Téo's Sondine, which no agent does.
- An unsigned dev build shows the offer in the menu bar only.
- While the Mac sleeps or another user's session is in front, nothing is
  observed, so the calls seen stay as they were; the helper says what it
  sees once the session is back, and the 10 s grace starts from there.
- A pause brought back after a call keeps the time it was taken, so a call
  that drops and is joined again a moment later is offered again.
- Main removes offers left in Notification Center by an earlier run at
  launch; Electron keeps a notification only while its object lives, so the
  one shown is held until it goes.
