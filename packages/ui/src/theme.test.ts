import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "styles", "globals.css"), "utf8");

/** Returns the declarations of the first top-level rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match?.[1]) throw new Error(`no ${selector} block in globals.css`);
  return match[1];
}

/** Returns the value of custom property `name` inside `declarations`, or undefined. */
function token(declarations: string, name: string): string | undefined {
  return new RegExp(`(?:^|[\\s;])${name}:\\s*([^;]+);`).exec(declarations)?.[1]?.trim();
}

describe("ink theme", () => {
  const light = block(":root");
  const dark = block(".dark");

  it.each(["--link", "--release", "--release-soft", "--snapshot", "--snapshot-soft"])(
    "defines %s in both :root and .dark",
    (name) => {
      expect(token(light, name)).toBeDefined();
      expect(token(dark, name)).toBeDefined();
    },
  );

  it("uses a white light background", () => {
    expect(token(light, "--background")).toMatch(/^(#ffffff|oklch\(1 0 0\))$/i);
  });

  it("uses a 6px radius", () => {
    expect(token(light, "--radius")).toBe("0.375rem");
  });

  it("maps the new tokens to Tailwind colors", () => {
    for (const name of ["link", "release", "release-soft", "snapshot", "snapshot-soft"]) {
      expect(css).toContain(`--color-${name}: var(--${name});`);
    }
  });
});
