import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const componentsDir = join(import.meta.dirname, "components");

describe("pointer cursors", () => {
  it("no component uses cursor-default on an interactive element", () => {
    const offenders = readdirSync(componentsDir)
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) => /cursor-default/.test(readFileSync(join(componentsDir, file), "utf8")));

    expect(offenders).toEqual([]);
  });

  it("globals.css gives interactive elements a pointer and disabled ones not-allowed", () => {
    const css = readFileSync(join(import.meta.dirname, "styles", "globals.css"), "utf8");

    expect(css).toMatch(/button:not\(:disabled\)[^{]*\[role="menuitem"\][^{]*\{\s*cursor: pointer;/);
    expect(css).toMatch(/:disabled,\s*\[aria-disabled="true"\],\s*\[data-disabled\]\s*\{\s*cursor: not-allowed;/);
  });
});
