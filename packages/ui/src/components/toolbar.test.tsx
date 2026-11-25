import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookmarkIcon, MicrophoneIcon, PauseIcon } from "../icon";
import { ToggleGroup } from "./toggle-group";
import {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarLink,
  ToolbarSeparator,
  ToolbarToggle,
} from "./toolbar";

/** Opening tags of every element carrying `data-slot="<slot>"`. */
function tagsOf(markup: string, slot: string): string[] {
  const tags: string[] = [];
  let at = markup.indexOf(`data-slot="${slot}"`);
  while (at !== -1) {
    const start = markup.lastIndexOf("<", at);
    tags.push(markup.slice(start, markup.indexOf(">", at) + 1));
    at = markup.indexOf(`data-slot="${slot}"`, at + 1);
  }
  if (tags.length === 0) throw new Error(`no ${slot} in ${markup}`);
  return tags;
}

function tagOf(markup: string, slot: string): string {
  const [tag] = tagsOf(markup, slot);
  if (tag === undefined) throw new Error(`no ${slot}`);
  return tag;
}

/** Matches the attribute itself, not a class such as `data-pressed:…`. */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(=|\\s|>|$)`).test(tag);
}

const ICON_SIDE = "size-[max(calc(1em+var(--space-s)*2),calc(1lh+var(--space-xs)*2))]";

function renderListening(props: { disabled?: boolean } = {}) {
  return renderToStaticMarkup(
    <Toolbar aria-label="Écoute" disabled={props.disabled}>
      <ToolbarGroup aria-label="Sources">
        <ToolbarToggle size="icon" aria-label="Micro" defaultPressed>
          <MicrophoneIcon />
        </ToolbarToggle>
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarButton>
        <PauseIcon />
        Mettre en pause l’écoute
      </ToolbarButton>
      <ToolbarButton size="icon" aria-label="Marquer ce moment">
        <BookmarkIcon />
      </ToolbarButton>
      <ToolbarLink href="#zoom">Ouvrir dans Zoom</ToolbarLink>
    </Toolbar>,
  );
}

describe("Toolbar", () => {
  it("renders the toolbar surface from the spec's group part", () => {
    const root = tagOf(renderListening(), "toolbar");
    expect(root).toContain('role="toolbar"');
    expect(root).toContain('aria-label="Écoute"');
    expect(root).toContain('aria-orientation="horizontal"');
    for (const token of [
      "flex w-fit items-stretch gap-xxs",
      "corner-s bg-neutral-1 p-xxs ring-s ring-neutral-4-transparent",
      "font-body font-regular text-body-s text-neutral-10",
      "data-[orientation=vertical]:flex-col",
    ]) {
      expect(root).toContain(token);
    }
    expect(tagOf(renderListening(), "toolbar-group")).toContain("flex items-stretch gap-xxs");
  });

  it("styles buttons with the shared Toggle control treatment", () => {
    const [text] = tagsOf(renderListening(), "toolbar-button");
    expect(text).toMatch(/^<button/);
    expect(text).toContain('data-size="default"');
    for (const token of [
      "corner-s",
      "px-s py-xs",
      "gap-xs",
      "bg-transparent text-neutral-10",
      "font-body font-medium text-body-s",
      "control-hover:bg-neutral-3",
      "data-pressed:bg-neutral-3",
      "control-focus:ring-color-1",
      "control-disabled:text-neutral-6",
      "focus-ring",
      "motion-safe:control-pressed:translate-y-(--motion-press-distance)",
      "duration-motion ease-motion motion-reduce:transition-none",
    ]) {
      expect(text).toContain(token);
    }
  });

  it("sizes icon-only controls as max(1em + X padding, 1lh + Y padding) squares", () => {
    const [, icon] = tagsOf(renderListening(), "toolbar-button");
    expect(icon).toContain('data-size="icon"');
    expect(icon).toContain('aria-label="Marquer ce moment"');
    expect(icon).toContain(ICON_SIDE);
    expect(icon).toContain("p-zero");
    expect(icon).not.toContain("px-s");
    expect(icon).not.toContain("py-xs");
  });

  it("composes toggles as one element that is both toolbar item and Toggle", () => {
    const markup = renderListening();
    const toggle = tagOf(markup, "toolbar-toggle");
    expect(toggle).toMatch(/^<button/);
    expect(toggle).toContain('aria-pressed="true"');
    expect(hasAttribute(toggle, "data-pressed")).toBe(true);
    expect(toggle).toContain('data-size="icon"');
    expect(toggle).toContain("data-pressed:bg-neutral-3");
    expect(toggle).toContain(ICON_SIDE);
    expect(toggle).not.toContain('data-slot="toggle"');
    // The Toggle's label box is inside the single button.
    const afterToggle = markup.slice(markup.indexOf('data-slot="toolbar-toggle"'));
    expect(afterToggle.indexOf('data-slot="toggle-label"')).toBeLessThan(
      afterToggle.indexOf("</button>"),
    );
  });

  it("keeps toggle values working inside a ToggleGroup", () => {
    const markup = renderToStaticMarkup(
      <Toolbar aria-label="Conversation">
        <ToggleGroup defaultValue={["transcript"]} aria-label="Affichage">
          <ToolbarToggle value="summary">Résumé</ToolbarToggle>
          <ToolbarToggle value="transcript">Transcription</ToolbarToggle>
        </ToggleGroup>
      </Toolbar>,
    );
    const [summary, transcript] = tagsOf(markup, "toolbar-toggle");
    expect(summary).toContain('aria-pressed="false"');
    expect(transcript).toContain('aria-pressed="true"');
  });

  it("renders a real link styled as a control", () => {
    const link = tagOf(renderListening(), "toolbar-link");
    expect(link).toMatch(/^<a/);
    expect(link).toContain('href="#zoom"');
    expect(link).toContain("px-s py-xs");
    expect(link).toContain("control-hover:bg-neutral-3");
  });

  it("reuses the shared Separator, perpendicular to the toolbar", () => {
    const separator = tagOf(renderListening(), "toolbar-separator");
    expect(separator).toContain('role="separator"');
    expect(separator).toContain('aria-orientation="vertical"');
    expect(separator).toContain('data-orientation="vertical"');
    expect(separator).toContain(
      "data-[orientation=vertical]:inset-shadow-[1px_0_0_0_var(--neutral-4)]",
    );

    const vertical = renderToStaticMarkup(
      <Toolbar aria-label="Actions" orientation="vertical">
        <ToolbarButton size="icon" aria-label="Marquer">
          <BookmarkIcon />
        </ToolbarButton>
        <ToolbarSeparator />
      </Toolbar>,
    );
    expect(tagOf(vertical, "toolbar")).toContain('aria-orientation="vertical"');
    expect(tagOf(vertical, "toolbar-separator")).toContain('data-orientation="horizontal"');
  });

  it("keeps disabled buttons and toggles focusable in the roving order", () => {
    const markup = renderListening({ disabled: true });
    const [text] = tagsOf(markup, "toolbar-button");
    expect(text).toContain('aria-disabled="true"');
    expect(hasAttribute(text ?? "", "data-disabled")).toBe(true);
    expect(hasAttribute(text ?? "", "disabled")).toBe(false);
    // Static markup still carries the inner Toggle's native `disabled`; Base
    // UI's useButton removes it on mount for composite items, so the live
    // toggle matches the buttons (checked in Chrome on the playground).
    const toggle = tagOf(markup, "toolbar-toggle");
    expect(toggle).toContain('aria-disabled="true"');
    expect(hasAttribute(toggle, "data-disabled")).toBe(true);
    expect(hasAttribute(toggle, "data-focusable")).toBe(true);
    expect(toggle).toContain('tabindex="-1"');
    expect(hasAttribute(toggle, "data-pressed")).toBe(true);
  });

  it("merges className strings and state functions", () => {
    const markup = renderToStaticMarkup(
      <Toolbar aria-label="Écoute" className="w-full">
        <ToolbarButton className={(state) => (state.disabled ? "is-off" : "is-on")}>
          Exporter
        </ToolbarButton>
      </Toolbar>,
    );
    expect(tagOf(markup, "toolbar")).toContain("w-full");
    expect(tagOf(markup, "toolbar-button")).toContain("is-on");
  });
});
