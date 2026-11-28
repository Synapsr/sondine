// The page where a user of a Mac too small for the local model leaves their
// e-mail, to be told when the cloud transcription is ready (Téo,
// 2026-11-19). Sondine itself sends nothing: the first run opens this page
// in the default browser, and the e-mail is typed there (ADR 002 holds).
// The page itself is apps/cloud-waitlist, a Cloudflare Worker.

/**
 * The beta's server (ADR 040): an ordinary machine of Synapsr's, with a few
 * places anyone takes in one click, reached through a Cloudflare Tunnel. Null
 * to close it in a build: the app then never mentions it.
 */
export const CLOUD_BETA: { readonly endpoint: string; readonly serverKey: string } | null = {
  endpoint: "https://cloud.sondine.app",
  serverKey: "s3c36N1sQrrTgBZ4GdjJalJtMrdGmsf-4vKwrQ5EQTU",
};

export const CLOUD_WAITLIST_URL = "https://sondine.app/cloud";

export function isCloudWaitlist(url: string): boolean {
  return url === CLOUD_WAITLIST_URL;
}

/** What the Cloud's server keeps, in full, on the site (ADR 047): the first run links to it. */
export const CLOUD_PRIVACY_URL = {
  fr: "https://sondine.app/fr/privacy-policy",
  en: "https://sondine.app/privacy-policy",
} as const;

export function isCloudPrivacy(url: string): boolean {
  return url === CLOUD_PRIVACY_URL.fr || url === CLOUD_PRIVACY_URL.en;
}

/**
 * How to set up sondine-compute on one's own machine and link it (ADR 040),
 * in the repository: the first run's « Votre machine » links to it.
 */
export const COMPUTE_GUIDE_URL =
  "https://github.com/Synapsr/sondine/blob/main/apps/compute/README.md";

export function isComputeGuide(url: string): boolean {
  return url === COMPUTE_GUIDE_URL;
}
