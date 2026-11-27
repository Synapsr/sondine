import { describe, expect, it } from "vitest";
import { handle, langOf, validEmail, type Env } from "../src/worker";

const env: Env = { DISCORD_WEBHOOK: "https://discord.test/hook" };

function post(fields: Record<string, string>, lang = "fr"): Request {
  const body = new URLSearchParams(fields);
  return new Request(`https://sondine.app/cloud?lang=${lang}`, { method: "POST", body });
}

describe("sondine.app/cloud", () => {
  it("speaks the browser's language, French or English", () => {
    const fr = new Request("https://sondine.app/cloud", {
      headers: { "accept-language": "fr-FR,fr" },
    });
    expect(langOf(fr)).toBe("fr");
    expect(langOf(new Request("https://sondine.app/cloud"))).toBe("en");
    expect(langOf(new Request("https://sondine.app/cloud?lang=fr"))).toBe("fr");
  });

  it("accepts an e-mail and refuses what is not one", () => {
    expect(validEmail("camille@exemple.fr")).toBe(true);
    for (const bad of ["", "camille", "a@b", "a b@c.fr", "`x`@y.fr", `${"a".repeat(250)}@b.fr`]) {
      expect(validEmail(bad), bad).toBe(false);
    }
  });

  it("shows the form, then sends a valid e-mail to the webhook without mentions", async () => {
    const page = await handle(new Request("https://sondine.app/cloud?lang=fr"), env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Me prévenir");
    // Where the e-mail goes and the Wave 1 non-ZDR limit are said beside the field.
    expect(html).toContain("Discord");
    expect(html).toContain("ZDR");
    expect(html).toContain('href="/fr/privacy-policy"');
    expect(html).toContain('href="/fr/terms"');

    const enHtml = await (
      await handle(new Request("https://sondine.app/cloud?lang=en"), env)
    ).text();
    expect(enHtml).toContain("zero data retention (ZDR)");
    expect(enHtml).toContain('href="/privacy-policy"');
    expect(enHtml).toContain('href="/terms"');
    const calls: { url: string; body: string }[] = [];
    const send = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const done = await handle(post({ email: " camille@exemple.fr " }), env, send);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("C’est noté");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(env.DISCORD_WEBHOOK);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      content: "Inscription au cloud : `camille@exemple.fr` (fr)",
      allowed_mentions: { parse: [] },
    });
  });

  it("sends nothing for an invalid e-mail or a robot, and says when the webhook fails", async () => {
    let sent = 0;
    const send = (async () => {
      sent += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    const invalid = await handle(post({ email: "camille" }), env, send);
    expect(invalid.status).toBe(400);
    const robot = await handle(post({ email: "bot@spam.io", website: "x" }), env, send);
    expect(robot.status).toBe(200);
    expect(sent).toBe(0);
    const failed = await handle(post({ email: "camille@exemple.fr" }), env, send);
    expect(failed.status).toBe(502);
    expect(sent).toBe(1);
  });

  it("answers only /cloud, whatever its query", async () => {
    expect((await handle(new Request("https://sondine.app/cloudy"), env)).status).toBe(404);
    expect((await handle(new Request("https://sondine.app/cloud?lang=en"), env)).status).toBe(200);
  });

  it("escapes what the user typed when the form comes back", async () => {
    const page = await handle(post({ email: "<b>@x.fr" }), env);
    expect(await page.text()).not.toContain("<b>@");
  });
});
