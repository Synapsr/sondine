import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "electron-vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Builds the app the way `pnpm build` does, into a temporary directory, and
// checks what the bundles must and must not contain. Kept out of the unit
// run (vitest.build.config.ts) because the build rewrites the Paraglide output
// that unit tests import.

const appDir = resolve(import.meta.dirname, "..");
const outDir = mkdtempSync(join(tmpdir(), "sondine-build-"));
const read = (path: string) => readFileSync(join(outDir, path), "utf8");
const files = (dir: string) => readdirSync(join(outDir, dir));

beforeAll(async () => {
  await build({
    root: appDir,
    configFile: join(appDir, "electron.vite.config.ts"),
    logLevel: "warn",
    build: { outDir },
  });
}, 120_000);
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("production build", () => {
  it("emits main as ES modules with core as a separate bundle, and no fake helper", () => {
    const main = read("main/index.js");
    const [coreChunk] = files("main/chunks");
    expect(coreChunk).toBeDefined();
    expect(main).toContain(`chunks/${coreChunk}"`);
    expect(read(`main/chunks/${coreChunk}`)).toContain('from "node:sqlite"');
    expect(existsSync(join(outDir, "main/fake-helper.js"))).toBe(false);
  });

  it("registers the media scheme in the production main bundle, streaming and without CSP bypass", () => {
    const main = read("main/index.js");
    // One registration for both schemes, outside any development-only branch.
    const call = /registerSchemesAsPrivileged\(\[([\s\S]*?)\]\)/.exec(main)?.[1] ?? "";
    expect(call).toMatch(/scheme:\s*APP_SCHEME|scheme:\s*"sondine"/);
    expect(call).toMatch(/scheme:\s*MEDIA_SCHEME|scheme:\s*"sondine-media"/);
    expect(call).toMatch(/stream:\s*(true|!0)/);
    expect(call).not.toContain("bypassCSP");
    expect(main).toContain('"sondine-media"');
    expect(main).toMatch(/protocol\.handle\(MEDIA_SCHEME|protocol\.handle\("sondine-media"/);
  });

  it("emits a CommonJS preload that only requires electron", () => {
    const preload = read("preload/index.cjs");
    const required = [...preload.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(new Set(required)).toEqual(new Set(["electron"]));
    expect(preload).not.toMatch(/^import /m);
  });

  it("puts a strict Content Security Policy in the renderer's HTML", () => {
    const html = read("renderer/index.html");
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/
      .exec(html)?.[1]
      ?.replaceAll("&#39;", "'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("media-src sondine-media:;");
    expect(policy).not.toContain("blob:");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("leaves Graphical's theme editor and its account service out of every bundle", () => {
    const bundles = ["main", "main/chunks", "preload", "renderer/assets"]
      .flatMap((dir) => files(dir).map((name) => `${dir}/${name}`))
      .filter((path) => /\.(c?js|css)$/.test(path))
      .map(read)
      .join("\n");
    expect(bundles).not.toContain("graphicalui.com");
    expect(bundles).not.toContain("GraphicalInstalledEditor");
    expect(bundles).not.toContain("@graphical/editor");
  });

  it("leaves the design system page out of the renderer", () => {
    const scripts = files("renderer/assets").filter((name) => name.endsWith(".js"));
    const bundle = scripts.map((name) => read(`renderer/assets/${name}`)).join("\n");
    // Strings that only the design system's sections contain.
    expect(bundle).not.toContain("Point quotidien");
    expect(bundle).not.toContain("DesignSystemPage");
    expect(bundle).toContain("sondine:core-port");
  });
});
