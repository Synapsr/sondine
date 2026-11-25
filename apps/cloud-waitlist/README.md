# sondine.app/cloud

The page the desktop's first run opens on a Mac too small for the local
transcription model (`apps/desktop/src/shared/cloud.ts`). It asks for an
e-mail and posts it to the team's Discord channel through a webhook, so the
user can be told when the cloud transcription opens more widely. The page says
so, and links to the site's privacy policy (ADR 043): deploy the two together. The desktop app
itself sends nothing (ADR 002): the e-mail is typed in the browser.

A Cloudflare Worker on the route `sondine.app/cloud*` (it answers only
`/cloud`, whatever the query); the rest of the site
is untouched.

## Deploy

The webhook is a secret, kept in Infisical (Sondine, `prod`, `/cloud`,
`CLOUD_WAITLIST_WEBHOOK`), never in this repository.

```bash
npx --yes wrangler@4.164.0 login
infisical run --env prod --path /cloud -- sh -c \
  'printf %s "$CLOUD_WAITLIST_WEBHOOK" | npx --yes wrangler@4.164.0 secret put DISCORD_WEBHOOK'
pnpm --filter @sondine/cloud-waitlist run deploy   # `run`: `pnpm deploy` is pnpm's own command
```
