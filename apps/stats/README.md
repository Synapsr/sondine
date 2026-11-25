# stats.sondine.app

Receives the anonymous daily reports of people who agreed to share them
([ADR 042](../../docs/decisions/042-usage-statistics.md)), checks them against
the strict schema the Mac uses (`packages/protocol`), and passes each to
PostHog EU as one event, `usage_reported`, without a person profile or a place.
It reads nothing else of the request (no IP, no country), keeps nothing and
logs nothing. What each field means: [docs/analytics.md](../../docs/analytics.md).

## On this machine

```bash
pnpm --filter @sondine/stats dev     # wrangler dev, forwards nothing
pnpm --filter @sondine/stats test
```

## Deploy (the maintainer)

PostHog, once: an EU organization of Sondine's own (the free plan has one
project per organization), with **Discard client IP data** on and the GeoIP
transformation, which PostHog turns on in a new project, turned off. The project token goes to Infisical
(Sondine, `prod`, `/stats`, `STATS_POSTHOG_TOKEN`), never to this repository.

```bash
npx --yes wrangler@4.164.0 login
pnpm --filter @sondine/stats run deploy   # `run`: `pnpm deploy` is pnpm's own command
infisical run --env prod --path /stats -- sh -c \
  'printf %s "$STATS_POSTHOG_TOKEN" | (cd apps/stats && npx --yes wrangler@4.164.0 secret put POSTHOG_TOKEN --env production)'
```

This creates the Worker `sondine-stats-production` and the DNS record of
`stats.sondine.app`. Releases from 0.7.0 on are built with
`SONDINE_STATS_ENDPOINT=https://stats.sondine.app/v1/report`; no other build
calls it.

Deploy before a release that adds an event or an error code: the schema is
strict, and refuses a name it does not know. Never remove one, Macs that have
not updated still send it.

## Check after a deploy

1. Send `USAGE_EXAMPLE` with today's date and a fresh id, by hand, once.
2. In PostHog, exactly one `usage_reported`, in the right project, with the
   properties of `src/report.ts`, no `$ip`, no `$geoip_*`, and no person.
3. When the request to PostHog changes: the same code in a temporary Worker,
   on a random path of the zone, whose `send` goes to
   `https://httpbin.org/anything?show_env=1` (which hides `X-Forwarded-For`,
   `X-Real-IP` and `Via` without `show_env`), with an invented report and token.
   None of the headers that arrive carries the sender's address. Delete it.
