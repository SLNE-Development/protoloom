import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const componentsDir = join(import.meta.dirname, "components");
const css = readFileSync(join(import.meta.dirname, "styles", "globals.css"), "utf8");

function component(name: string): string {
  return readFileSync(join(componentsDir, `${name}.tsx`), "utf8");
}

describe("pointer cursors", () => {
  it("no component uses cursor-default on an interactive element", () => {
    const offenders = readdirSync(componentsDir)
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) => /cursor-default/.test(readFileSync(join(componentsDir, file), "utf8")));

    expect(offenders).toEqual([]);
  });

  it("globals.css gives interactive elements, sliders included, a pointer", () => {
    const pointerRule = /button:not\(:disabled\)([^{]*)\{\s*cursor: pointer;/.exec(css)?.[1] ?? "";

    for (const selector of ['[role="menuitem"]', '[role="option"]', '[role="tab"]', '[role="slider"]', "a[href]"]) {
      expect(pointerRule).toContain(selector);
    }
  });

  it("globals.css shows not-allowed on disabled elements, ignoring data-disabled=\"false\"", () => {
    expect(css).toMatch(
      /:disabled,\s*\[aria-disabled="true"\],\s*\[data-disabled\]:not\(\[data-disabled="false"\]\)\s*\{\s*cursor: not-allowed;/,
    );
  });

  it("slider thumbs show a grab cursor", () => {
    expect(component("slider")).toMatch(/data-slot="slider-thumb"[\s\S]*cursor-grab active:cursor-grabbing/);
  });

  it.each(["combobox", "command", "context-menu", "dropdown-menu", "menubar", "select"])(
    "disabled %s items show not-allowed instead of swallowing pointer events",
    (name) => {
      const source = component(name);
      expect(source).not.toMatch(/(?<![\w-])data-\[disabled(=true)?\]:pointer-events-none/);
      expect(source).toMatch(/data-\[disabled(=true)?\]:cursor-not-allowed/);
    },
  );
});
