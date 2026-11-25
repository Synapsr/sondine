// How the user writes to us. A mail opens in their own app (ADR 042); Sondine
// sends none.

export const CONTACT_EMAIL = "hello@sondine.app";

/** The longest diagnostic and note, each character percent-encoded. */
const MAX_MAIL_URL = 80_000;

/** Public: linked, never filled in. */
export const ISSUES_PAGE = "https://github.com/Synapsr/sondine/issues";

/** A `mailto:` to the contact, with a subject and a body. */
export function contactMail(subject: string, body: string): string {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Only a mail to the contact, with nothing but a subject and a body. */
export function isContactMail(url: string): boolean {
  const start = `mailto:${CONTACT_EMAIL}?`;
  if (!url.startsWith(start) || url.length > MAX_MAIL_URL) return false;
  const keys = [...new URLSearchParams(url.slice(start.length)).keys()];
  return keys.length > 0 && keys.every((key) => key === "subject" || key === "body");
}
