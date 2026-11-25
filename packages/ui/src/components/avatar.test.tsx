import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserIcon } from "../icon";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

describe("Avatar", () => {
  it("renders an XL neutral-3 circle with the fallback in its grid cell", () => {
    const markup = renderToStaticMarkup(
      <Avatar>
        <AvatarFallback>CM</AvatarFallback>
      </Avatar>,
    );
    const root = attributesOf(markup);
    expect(root).toMatch(/^<span/);
    expect(root).toContain('data-slot="avatar"');
    expect(root).toContain("size-xl");
    expect(root).toContain("corner-full");
    expect(root).toContain("bg-neutral-3");
    expect(root).toContain("overflow-hidden");
    expect(root).toContain("ring-none ring-neutral-4-transparent");
    expect(root).not.toContain("data-disabled");
    expect(markup).toContain('data-slot="avatar-fallback"');
    expect(markup).toContain("font-body font-medium text-body-s text-neutral-8");
    expect(markup).toContain("col-start-1 row-start-1");
    expect(markup).toContain(">CM</span>");
  });

  it("shows the fallback until Base UI has loaded the image", () => {
    const markup = renderToStaticMarkup(
      <Avatar>
        <AvatarImage src="portrait.png" alt="Camille Martin" />
        <AvatarFallback>CM</AvatarFallback>
      </Avatar>,
    );
    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-slot="avatar-fallback"');
  });

  it("marks the root disabled so the fallback dims", () => {
    const markup = renderToStaticMarkup(
      <Avatar disabled role="img" aria-label="Intervenant inconnu">
        <AvatarFallback>
          <UserIcon />
        </AvatarFallback>
      </Avatar>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('data-disabled=""');
    expect(root).toContain('role="img"');
    expect(root).toContain('aria-label="Intervenant inconnu"');
    expect(root).toContain("group/avatar");
    expect(markup).toContain("group-data-disabled/avatar:text-neutral-6");
    expect(markup).toContain('data-slot="icon"');
  });

  it("merges className, including a state function", () => {
    const markup = renderToStaticMarkup(
      <Avatar className={() => "size-l"}>
        <AvatarFallback className="text-neutral-10">CM</AvatarFallback>
      </Avatar>,
    );
    const root = attributesOf(markup);
    expect(root).toContain("size-l");
    expect(root).not.toContain("size-xl");
    expect(markup).toContain("text-neutral-10");
    expect(markup).not.toContain("text-neutral-8");
  });
});
