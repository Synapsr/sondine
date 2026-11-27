// sondine.app/cloud (Téo, 2026-11-19): the page the desktop's first run opens
// on a Mac too small for the local model. It asks for an e-mail, to tell
// the user when the cloud transcription is ready, and passes it to the team's
// Discord channel through a webhook kept as a secret of the Worker. The page
// says what the e-mail is for and where it goes; the Worker keeps nothing and
// logs nothing. Deploy it with the site's privacy policy it links to.
// French or English, from the browser's languages.

export interface Env {
  /** The Discord webhook (a secret: `wrangler secret put DISCORD_WEBHOOK`). */
  readonly DISCORD_WEBHOOK: string;
}

type Lang = "fr" | "en";

const TEXT = {
  fr: {
    title: "Soyez prévenu quand le cloud ouvre",
    lead: "Le Cloud Sondine ouvre par petites vagues pour les Mac qui n’ont pas assez de mémoire pour le modèle local (60 min d’essai gratuit sans carte, puis tarif Fondateur 19 € TTC/mois pour 40 h/mois). Laissez votre e-mail pour recevoir une invitation.",
    noticeTitle: "Transparence bêta (Vague 1)",
    notice:
      "La Vague 1 tourne sur un serveur dédié de Synapsr (file partagée, sans garantie de disponibilité). L’audio des conversations terminées y part chiffré jusqu’au programme, reste en mémoire le temps du calcul puis est effacé — mais ce n’est pas une ZDR (zéro rétention garantie) vis-à-vis de ses administrateurs. Nous nous engageons sur l’honneur à ne rien lire ni écouter, et vos données n’entraînent aucun modèle.",
    email: "Votre e-mail",
    send: "Me prévenir",
    use: "Votre e-mail arrive dans un salon Discord privé de notre équipe et sert seulement à vous prévenir. Il y reste jusqu’à ce que nous l’effacions ; demandez-le quand vous voulez.",
    invalid: "Cette adresse ne semble pas valide.",
    failed: "L’envoi n’a pas abouti. Réessayez dans un moment.",
    policy: "Politique de confidentialité",
    terms: "Conditions",
    thanks: "C’est noté",
    thanksLead: "Nous vous écrirons dès qu’une place s’ouvre dans la prochaine vague.",
  },
  en: {
    title: "Be told when the cloud opens",
    lead: "Sondine Cloud opens in small waves for Macs without enough memory for the local model (60-minute free trial with no card, then €19/month incl. VAT Founder rate for 40 h/month). Leave your e-mail to receive an invite.",
    noticeTitle: "Wave 1 beta transparency",
    notice:
      "Wave 1 runs on a dedicated Synapsr server (shared queue, no availability guarantee). Audio of finished conversations goes encrypted up to the program, stays in memory only while transcribing, and is then erased — but it is not zero data retention (ZDR) towards its administrators. We give our word never to read or listen to it, and your data trains no model.",
    email: "Your e-mail",
    send: "Tell me",
    use: "Your e-mail reaches a private Discord channel of our team and is only used to tell you. It stays there until we delete it; ask whenever you want.",
    invalid: "This address does not look valid.",
    failed: "It did not go through. Try again in a moment.",
    policy: "Privacy policy",
    terms: "Terms",
    thanks: "Noted",
    thanksLead: "We will write as soon as a spot opens in the next wave.",
  },
} as const satisfies Record<Lang, Record<string, string>>;

const MAX_EMAIL = 254;
const EMAIL = /^[^\s@`<>"']+@[^\s@`<>"']+\.[^\s@`<>"']+$/u;

export function langOf(request: Request): Lang {
  const asked = new URL(request.url).searchParams.get("lang");
  if (asked === "fr" || asked === "en") return asked;
  return (request.headers.get("accept-language") ?? "").toLowerCase().startsWith("fr")
    ? "fr"
    : "en";
}

export function validEmail(value: string): boolean {
  return value.length <= MAX_EMAIL && EMAIL.test(value);
}

export async function handle(
  request: Request,
  env: Env,
  send: typeof fetch = fetch,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/cloud") return new Response(null, { status: 404 });
  const lang = langOf(request);
  if (request.method === "GET" || request.method === "HEAD") {
    return page(lang, { kind: "form" });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const form = await request.formData().catch(() => null);
  const email = String(form?.get("email") ?? "").trim();
  // A field people never see: what fills it is a robot.
  if (String(form?.get("website") ?? "") !== "") return page(lang, { kind: "thanks" });
  if (!validEmail(email)) return page(lang, { kind: "form", error: "invalid", email }, 400);
  const sent = await send(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `Inscription au cloud : \`${email}\` (${lang})`,
      allowed_mentions: { parse: [] },
    }),
  }).catch(() => null);
  if (sent === null || !sent.ok) return page(lang, { kind: "form", error: "failed", email }, 502);
  return page(lang, { kind: "thanks" });
}

type View =
  | { readonly kind: "form"; readonly error?: "invalid" | "failed"; readonly email?: string }
  | { readonly kind: "thanks" };

const escape = (value: string) => value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

function page(lang: Lang, view: View, status = 200): Response {
  const t = TEXT[lang];
  const prefix = lang === "fr" ? "/fr" : "";
  const body =
    view.kind === "thanks"
      ? `<h1>${t.thanks}</h1><p class="muted">${t.thanksLead}</p>`
      : `<h1>${t.title}</h1>
<p class="muted">${t.lead}</p>
<aside class="notice" aria-label="${t.noticeTitle}">
  <strong>${t.noticeTitle}</strong>
  <p class="small muted">${t.notice}</p>
</aside>
<form method="post" action="/cloud?lang=${lang}">
  <label for="email">${t.email}</label>
  <input id="email" name="email" type="email" required autocomplete="email" maxlength="${MAX_EMAIL}" value="${escape(view.email ?? "")}">
  <input class="trap" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
  ${view.error === undefined ? "" : `<p class="error" role="alert">${t[view.error]}</p>`}
  <button type="submit">${t.send}</button>
</form>
<p class="small muted">${t.use} <a href="${prefix}/privacy-policy">${t.policy}</a> · <a href="${prefix}/terms">${t.terms}</a></p>`;
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sondine · ${view.kind === "thanks" ? t.thanks : t.title}</title>
<style>
  :root { color-scheme: light dark; --ink: #000; --muted: #6b6b6b; --line: #e5e5e5; --bg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #fff; --muted: #a3a3a3; --line: #333; --bg: #111; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
    background: var(--bg); color: var(--ink); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
  main { width: 100%; max-width: 28rem; display: flex; flex-direction: column; gap: 16px; }
  h1 { margin: 0; font-size: 32px; line-height: 1.15; letter-spacing: -0.02em; }
  p { margin: 0; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }
  .notice { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); }
  .notice strong { font-size: 13px; font-weight: 600; }
  a { color: inherit; }
  form { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  label { font-weight: 500; font-size: 14px; }
  input { font: inherit; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line);
    background: transparent; color: inherit; }
  input:focus { outline: 2px solid var(--ink); outline-offset: 1px; }
  button { font: inherit; font-weight: 500; padding: 12px 16px; border: 0; border-radius: 12px;
    background: var(--ink); color: var(--bg); cursor: pointer; margin-top: 4px; }
  .error { color: #d4402b; font-size: 14px; }
  .trap { position: absolute; left: -9999px; width: 1px; height: 1px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
