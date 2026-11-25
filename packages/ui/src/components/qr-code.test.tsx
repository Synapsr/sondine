import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QrCode } from "./qr-code";

describe("QrCode", () => {
  it("renders a labelled square with the quiet zone", () => {
    const markup = renderToStaticMarkup(
      <QrCode value="Sondine" label="Code" className="w-[8rem]" />,
    );
    expect(markup).toContain('data-slot="qr-code"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Code"');
    // Version 1 is 21 modules, plus four on each side.
    expect(markup).toContain('viewBox="0 0 29 29"');
    expect(markup).toContain("w-[8rem]");
    // The top-left finder starts at the quiet zone's corner.
    expect(markup).toContain("M4 4h1v1h-1z");
  });
});
