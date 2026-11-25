import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "./field";
import { Input, inputVariants } from "./input";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

describe("Input", () => {
  it("renders a native input with the rest appearance", () => {
    const root = attributesOf(
      renderToStaticMarkup(<Input name="query" placeholder="Rechercher dans vos conversations" />),
    );
    expect(root).toMatch(/^<input/);
    expect(root).toContain('data-slot="input"');
    expect(root).toContain('name="query"');
    expect(root).toContain('placeholder="Rechercher dans vos conversations"');
    for (const token of [
      "bg-neutral-3",
      "text-neutral-10",
      "ring-s",
      "ring-neutral-4",
      "corner-s",
      "px-m",
      "py-s",
      "font-regular",
      "text-body-s",
      "placeholder:text-cte-text-muted",
      "focus-ring",
    ]) {
      expect(root).toContain(token);
    }
  });

  it("forwards disabled and read-only to the native input", () => {
    const disabled = attributesOf(renderToStaticMarkup(<Input disabled />));
    expect(disabled).toMatch(/\sdisabled=""/);
    expect(disabled).toContain("data-disabled");

    const readOnly = attributesOf(renderToStaticMarkup(<Input readOnly defaultValue="Zoom" />));
    expect(readOnly).toMatch(/\sreadOnly=""/);
    expect(readOnly).toContain('value="Zoom"');
    expect(readOnly).not.toContain("data-disabled");
  });

  it("takes the invalid and disabled state of its Field", () => {
    const invalid = renderToStaticMarkup(
      <Field invalid>
        <Input />
      </Field>,
    );
    expect(invalid).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(invalid).toMatch(/<input[^>]*data-invalid=""/);

    const disabled = renderToStaticMarkup(
      <Field disabled>
        <Input />
      </Field>,
    );
    expect(disabled).toMatch(/<input[^>]*\sdisabled=""/);
    expect(disabled).toMatch(/<input[^>]*data-disabled=""/);
  });

  it("merges className strings and state functions", () => {
    expect(attributesOf(renderToStaticMarkup(<Input className="px-s" />))).toContain("px-s");
    expect(attributesOf(renderToStaticMarkup(<Input className="px-s" />))).not.toContain("px-m");
    const root = attributesOf(
      renderToStaticMarkup(
        <Input disabled className={(state) => (state.disabled ? "is-off" : "is-on")} />,
      ),
    );
    expect(root).toContain("is-off");
    expect(root).toContain("bg-neutral-3");
  });

  it("exports its styling for other controls built on the text field", () => {
    expect(inputVariants()).toContain("bg-neutral-3");
  });
});

// State precedence is decided by selector specificity and source order in
// the compiled CSS, so it is checked against Tailwind's real output.
describe("Input state precedence (compiled CSS)", async () => {
  const require = createRequire(import.meta.url);
  const tailwindDir = path.dirname(require.resolve("tailwindcss/package.json"));
  const tailwind: typeof import("tailwindcss") = await import(
    pathToFileURL(path.join(tailwindDir, "dist/lib.mjs")).href
  );
  const stylesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../styles");
  const compiler = await tailwind.compile(
    await readFile(path.join(stylesDir, "index.css"), "utf8"),
    {
      base: stylesDir,
      async loadStylesheet(id: string, base: string) {
        const file =
          id === "tailwindcss"
            ? path.join(tailwindDir, "index.css")
            : id.startsWith("tailwindcss/")
              ? path.join(tailwindDir, id.slice("tailwindcss/".length))
              : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: await readFile(file, "utf8") };
      },
    },
  );
  const output = compiler.build(inputVariants().split(" "));
  const utilities = output.slice(output.indexOf("@layer utilities"));
  const ruleFor = (className: string) => {
    const escaped = className.replace(/[:[\]().]/g, "\\$&");
    const start = utilities.indexOf(`.${escaped}`);
    expect(start, className).toBeGreaterThan(-1);
    return { start, selector: utilities.slice(start, utilities.indexOf("{", start)) };
  };

  it("keeps the validation edge over the hover and focus edges", () => {
    for (const className of [
      "not-data-invalid:not-[[data-valid][data-filled]]:control-hover:ring-neutral-5",
      "not-data-invalid:not-[[data-valid][data-filled]]:control-focus:ring-color-1-transparent",
    ]) {
      const { selector } = ruleFor(className);
      expect(selector).toContain(":not([data-invalid]):not(:is([data-valid][data-filled]))");
    }
  });

  it("lets validation fills win over read-only, and disabled win over both", () => {
    const readOnly = ruleFor("read-only:bg-neutral-2");
    const invalid = ruleFor("data-invalid:bg-error-transparent");
    const valid = ruleFor("data-valid:data-filled:bg-success-transparent");
    const disabled = ruleFor("control-disabled:bg-neutral-3");
    expect(readOnly.selector).toMatch(/:read-only\s*$/);
    expect(invalid.start).toBeGreaterThan(readOnly.start);
    expect(valid.start).toBeGreaterThan(readOnly.start);
    // An empty field that Base UI reports valid keeps the rest look.
    expect(valid.selector).toContain("[data-valid][data-filled]");
    // [data-disabled]:not([data-pending]) outranks a single attribute or pseudo-class.
    expect(disabled.selector).toContain("[data-disabled]:not([data-pending])");
    expect(disabled.start).toBeGreaterThan(invalid.start);
  });
});
