# 043 — The site in a repository of its own

Status: Accepted — 2026-11-25 (Téo: « j'aimerais à part »; the former blog goes
to the home page). Builds on ADR 041.

## Context

sondine.app still runs from `teo-goulois/sondine-legacy`, archived. It sells
the former app, and its policy and terms contradict ADR 027, ADR 040 and the
AGPL-3.0. Its source depends on that repository's packages and on demos of the
former app.

## Decision

- **A separate repository**, `Synapsr/Sondine-Website`, private, not an app of
  this one. It copies the app's look (theme, font) rather than depending on it.
- **Taken from the former site:** the wordmark, the icons, the Worker's name,
  the Umami site and the addresses. Nothing else: no demo, form, blog or CMS.
- **Static files**, English at `/`, French at `/fr/`, behind a Worker of a few
  lines. No form, so the site itself collects nothing but visits.
- **`docs/network.md`, here, is the source** of every public sentence about what
  leaves. A change that widens it is carried to the site's policy before the
  release that has it: two repositories let the texts drift once already.
- **A deploy refuses** while the publisher is incomplete, the legal texts
  unread, or a link its `check-launch.ts` lists does not answer.
- **`/cloud` stays here** (`apps/cloud-waitlist`), deployed with the policy it
  links to.

## Rejected

- `apps/site` in this repository, built first: Téo prefers it apart.
- Porting the former landing page: most of its claims are no longer true.
