import { describe, expect, it } from "vitest";
import { developmentCsp, PRODUCTION_CSP, PRODUCTION_CSP_HEADER } from "./csp";

const directive = (policy: string, name: string) =>
  policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));

describe("renderer CSP", () => {
  it("plays media, and shows context images, only from the sondine-media: scheme", () => {
    const development = developmentCsp("http://localhost:5173");
    const policies = [PRODUCTION_CSP, PRODUCTION_CSP_HEADER, development];
    for (const policy of policies) {
      expect(directive(policy, "media-src")).toBe("media-src sondine-media:");
      expect(directive(policy, "default-src")).toBe("default-src 'none'");
      expect(policy).not.toContain("blob:");
      // Media and images reach it (ADR 024): no fetch, no XHR, no script.
      // Graphical's development-only theme editor shows its previews (ADR 033).
      expect(directive(policy, "img-src")).toBe(
        policy === development
          ? "img-src 'self' data: sondine-media: https://www.graphicalui.com"
          : "img-src 'self' data: sondine-media:",
      );
      for (const name of ["connect-src", "script-src", "default-src"]) {
        expect(directive(policy, name), name).not.toContain("sondine-media");
      }
    }
    expect(directive(PRODUCTION_CSP, "connect-src")).toBe("connect-src 'none'");
  });
});
