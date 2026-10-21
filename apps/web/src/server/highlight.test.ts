import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { HIGHLIGHT_MAX_BYTES, highlight, plainHtml } = await import("./highlight");

describe("highlight", () => {
  it("colors small sources with theme variables and escapes them", async () => {
    const html = await highlight('message Money { string note = 1; } // <script>"x"</script>', "proto");
    expect(html).toContain('class="shiki');
    expect(html).toContain("--shiki-light");
    expect(html).toContain("--shiki-dark");
    expect(html).not.toContain("<script>");
  });

  it("shows sources above the limit as plain escaped text", async () => {
    const big = `// <b>&</b>\n${"x".repeat(HIGHLIGHT_MAX_BYTES)}`;
    const html = await highlight(big, "proto");
    expect(html.startsWith('<pre class="shiki plain"><code><span class="line">// &lt;b&gt;&amp;&lt;/b&gt;</span>\n')).toBe(true);
    expect(html).not.toContain("--shiki-light");
  });

  it("returns the cached result for the same key", async () => {
    const first = await highlight("message A {}", "proto", "sha-1:a.proto");
    // A different source under the same key proves the cache answered.
    const second = await highlight("message B {}", "proto", "sha-1:a.proto");
    expect(second).toBe(first);
    expect(await highlight("message B {}", "proto", "sha-2:a.proto")).toContain("B");
  });

  it("plainHtml keeps one span per line", () => {
    expect(plainHtml("a\n<b>")).toBe('<pre class="shiki plain"><code><span class="line">a</span>\n<span class="line">&lt;b&gt;</span></code></pre>');
  });
});
