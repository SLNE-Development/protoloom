import "server-only";

import { createHighlighter, type Highlighter } from "shiki";

/** Languages the UI highlights. */
export type CodeLanguage = "proto" | "kotlin" | "json";

const LANGUAGES: CodeLanguage[] = ["proto", "kotlin", "json"];

// Kept on globalThis so dev-mode reloads reuse the loaded grammars instead of building a new highlighter.
const globalForShiki = globalThis as typeof globalThis & { __protoloomShiki?: Promise<Highlighter> };

function highlighter(): Promise<Highlighter> {
  globalForShiki.__protoloomShiki ??= createHighlighter({ themes: ["github-light", "github-dark"], langs: LANGUAGES });
  return globalForShiki.__protoloomShiki;
}

/**
 * Highlights `code` on the server into Shiki HTML (`<pre class="shiki"><code><span class="line">…`).
 * Token colors come as `--shiki-light` / `--shiki-dark` custom properties, so the CSS of
 * {@link CodeBlock} picks the right one for the active theme without re-rendering.
 */
export async function highlight(code: string, lang: CodeLanguage): Promise<string> {
  return (await highlighter()).codeToHtml(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}
