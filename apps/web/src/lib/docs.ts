import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import GithubSlugger from "github-slugger";
import type { Element, ElementContent, Root as HastRoot } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createHighlighter, type Highlighter } from "shiki";
import { unified } from "unified";
import { visit, SKIP } from "unist-util-visit";
import { parse as parseYaml } from "yaml";

/**
 * The docs content contract: Markdown files under `apps/web/content/docs/**` with frontmatter
 * `title`, `description`, `section` (one of {@link DOC_SECTIONS}) and `order`; the file path is the
 * URL (`index.md` → `/docs`, `admin/keys.md` → `/docs/admin/keys`). `{{url}}` and `{{host}}` in a page
 * are replaced by the instance's public URL and its host when it is rendered.
 */
export const DOC_SECTIONS = ["Getting started", "Concepts", "Clients", "Administration", "Self-hosting", "Help"] as const;

export type DocSection = (typeof DOC_SECTIONS)[number];

/** Frontmatter of a docs page. */
export interface DocFrontmatter {
  title: string;
  description: string;
  section: DocSection;
  order: number;
}

/** A docs page without its rendered body. */
export interface DocMeta extends DocFrontmatter {
  /** URL segments below `/docs`; `[]` is `/docs` itself. */
  slug: string[];
  /** The page URL path, such as `/docs/admin/keys`. */
  path: string;
  /** Absolute path of the Markdown file. */
  file: string;
}

/** An h2 or h3 heading of a page, for the "On this page" list and search. */
export interface DocHeading {
  depth: 2 | 3;
  id: string;
  text: string;
}

/** A neighbouring page in reading order. */
export interface DocLink {
  path: string;
  title: string;
}

/** A page rendered to HTML, with its headings and neighbours. */
export interface RenderedDoc extends DocMeta {
  html: string;
  headings: DocHeading[];
  prev?: DocLink;
  next?: DocLink;
}

/** One navigation group: a section with its pages in order. */
export interface DocNavGroup {
  section: DocSection;
  items: DocLink[];
}

/** One search index entry: a page and its headings. */
export interface DocSearchEntry {
  path: string;
  title: string;
  description: string;
  section: DocSection;
  headings: { id: string; text: string }[];
}

/** Where the docs live: `apps/web/content/docs` (the server and tests run with `apps/web` as cwd). */
export const DOCS_DIR = join(process.cwd(), "content", "docs");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Splits a page into validated frontmatter and the Markdown body; errors name `file`. */
export function parseFrontmatter(source: string, file: string): { meta: DocFrontmatter; body: string } {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error(`${file}: missing frontmatter (--- title, description, section, order ---)`);
  const data = (parseYaml(match[1] ?? "") ?? {}) as Record<string, unknown>;
  const text = (key: string): string => {
    const value = data[key];
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${file}: frontmatter needs a ${key}`);
    return value.trim();
  };
  const section = text("section");
  if (!(DOC_SECTIONS as readonly string[]).includes(section)) {
    throw new Error(`${file}: unknown section "${section}", expected one of ${DOC_SECTIONS.join(", ")}`);
  }
  if (typeof data.order !== "number" || !Number.isFinite(data.order)) {
    throw new Error(`${file}: frontmatter needs a numeric order`);
  }
  return {
    meta: {
      title: text("title"),
      description: text("description"),
      section: section as DocSection,
      order: data.order,
    },
    body: source.slice(match[0].length),
  };
}

/** URL segments for a Markdown file path relative to the docs directory. */
export function slugFromFile(file: string): string[] {
  const parts = file.replace(/\\/g, "/").replace(/\.md$/, "").split("/");
  if (parts.at(-1) === "index") parts.pop();
  return parts;
}

/** The URL path of a slug. */
export function docPath(slug: string[]): string {
  return slug.length === 0 ? "/docs" : `/docs/${slug.join("/")}`;
}

/**
 * Replaces every `{{url}}` with the instance URL (without a trailing slash) and every `{{host}}`
 * with its host name (with the port, if any).
 */
export function fillUrl(text: string, url: string): string {
  const base = url.replace(/\/+$/, "");
  let host = base;
  try {
    host = new URL(base).host;
  } catch {
    // Not a full URL (search indexing passes ""): leave the host as given.
  }
  return text.replaceAll("{{url}}", base).replaceAll("{{host}}", host);
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name));
}

const sectionRank = (section: DocSection) => DOC_SECTIONS.indexOf(section);

/**
 * In production the content can't change while the server runs, so the page list is read once per
 * process. `NODE_ENV` is set by Next.js and Vitest themselves, not by the operator.
 */
const CACHE_LIST = process.env.NODE_ENV === "production";
const listCache = new Map<string, DocMeta[]>();

/** Every page in reading order: by section, then `order`. Throws when a page has bad frontmatter. */
export function listDocs(dir: string = DOCS_DIR): DocMeta[] {
  const cached = CACHE_LIST ? listCache.get(dir) : undefined;
  if (cached) return cached;
  const docs = readDocs(dir);
  if (CACHE_LIST) listCache.set(dir, docs);
  return docs;
}

function readDocs(dir: string): DocMeta[] {
  return markdownFiles(dir)
    .map((file) => {
      const rel = relative(dir, file).split(sep).join("/");
      const { meta } = parseFrontmatter(readFileSync(file, "utf8"), rel);
      const slug = slugFromFile(rel);
      return { ...meta, slug, path: docPath(slug), file };
    })
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || a.order - b.order || a.path.localeCompare(b.path));
}

/** The page at `slug`, or undefined. */
export function getDoc(slug: string[], dir: string = DOCS_DIR): DocMeta | undefined {
  const path = docPath(slug);
  return listDocs(dir).find((doc) => doc.path === path);
}

/** Pages grouped by section, in reading order; empty sections are left out. */
export function docNavigation(dir: string = DOCS_DIR): DocNavGroup[] {
  const docs = listDocs(dir);
  return DOC_SECTIONS.map((section) => ({
    section,
    items: docs.filter((d) => d.section === section).map(({ path, title }) => ({ path, title })),
  })).filter((group) => group.items.length > 0);
}

// ---- Markdown rendering ----

const LIGHT_THEME = "github-light-default";
const DARK_THEME = "github-dark-default";
const LANGUAGES = ["kotlin", "json", "shellscript", "proto", "yaml", "typescript", "http", "dotenv", "ini"] as const;
const LANGUAGE_ALIASES: Record<string, string> = { sh: "shellscript", bash: "shellscript", shell: "shellscript", kts: "kotlin", env: "dotenv" };
const LANGUAGE_LABELS: Record<string, string> = { shellscript: "shell", text: "text" };

let highlighterPromise: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [LIGHT_THEME, DARK_THEME], langs: [...LANGUAGES] });
  return highlighterPromise;
}

const CALLOUT = /^\[!(NOTE|TIP|WARNING)\]\s*/;
const STEP = /^(\d+)\.\s+/;

function el(tagName: string, properties: Element["properties"], children: ElementContent[] = []): Element {
  return { type: "element", tagName, properties, children };
}

function classes(node: Element): string[] {
  const value: unknown = node.properties?.className;
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(" ") : [];
}

/** The `title="…"` of a fenced code block's meta string. */
function codeTitle(meta: unknown): string | undefined {
  return typeof meta === "string" ? /title="([^"]+)"/.exec(meta)?.[1] : undefined;
}

/** Turns a `[!NOTE]`/`[!TIP]`/`[!WARNING]` blockquote into a callout; returns false otherwise. */
function toCallout(node: Element): boolean {
  const first = node.children.find((c): c is Element => c.type === "element");
  const lead = first?.tagName === "p" ? first.children[0] : undefined;
  if (!first || lead?.type !== "text") return false;
  const match = CALLOUT.exec(lead.value);
  if (!match) return false;
  lead.value = lead.value.slice(match[0].length);
  if (lead.value === "" && first.children[1]?.type === "element" && first.children[1].tagName === "br") {
    first.children.splice(1, 1);
  }
  if (lead.value === "") first.children.shift();
  const kind = (match[1] as string).toLowerCase();
  node.tagName = "div";
  node.properties = { className: ["docs-callout", `docs-callout-${kind}`], role: "note" };
  return true;
}

/** Whether a link's `href` (or an image's `src`) is relative, an anchor, or uses http, https or mailto. */
function hasSafeUrl(node: Element): boolean {
  const value = node.properties?.href ?? node.properties?.src;
  if (typeof value !== "string") return true;
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto";
}

interface RenderState {
  headings: DocHeading[];
  links: string[];
}

/**
 * The rehype step: heading ids (GitHub-style), callouts, scrollable tables, external link rel,
 * and code blocks highlighted by shiki (light and dark colours as CSS variables) inside a frame
 * with a title or language label and a copy button.
 */
function rehypeDocs(highlighter: Highlighter, state: RenderState) {
  return () => (tree: HastRoot) => {
    const slugger = new GithubSlugger();
    visit(tree, "element", (node, index, parent) => {
      if ((node.tagName === "h2" || node.tagName === "h3") && parent) {
        // `## 2. Store the key` renders the number as a step marker outside the heading text.
        const lead = node.children[0];
        const step = lead?.type === "text" ? STEP.exec(lead.value) : null;
        if (lead?.type === "text" && step) {
          lead.value = lead.value.slice(step[0].length);
          node.children.unshift(el("span", { className: ["docs-step"], ariaHidden: "true" }, [{ type: "text", value: step[1] as string }]));
        }
        const text = hastToString({ ...node, children: step ? node.children.slice(1) : node.children }).trim();
        const id = slugger.slug(text);
        node.properties = { ...node.properties, id };
        state.headings.push({ depth: node.tagName === "h2" ? 2 : 3, id, text });
        // Hidden from assistive tech so the heading's accessible name stays its text; the TOC links to it.
        node.children.push(el("a", { className: ["docs-anchor"], href: `#${id}`, ariaHidden: "true", tabIndex: -1 }, [{ type: "text", value: "#" }]));
        return SKIP;
      }
      if (node.tagName === "blockquote") {
        toCallout(node);
        return undefined;
      }
      if ((node.tagName === "a" || node.tagName === "img") && !hasSafeUrl(node)) {
        // `javascript:`, `data:` and other schemes never reach the page.
        const properties = { ...node.properties };
        delete properties.href;
        delete properties.src;
        node.properties = properties;
        return undefined;
      }
      if (node.tagName === "a" && typeof node.properties?.href === "string") {
        const href = node.properties.href;
        if (/^https?:\/\//.test(href)) node.properties = { ...node.properties, rel: ["noreferrer"] };
        else state.links.push(href);
        return undefined;
      }
      if (node.tagName === "table" && parent && index !== undefined) {
        parent.children[index] = el("div", { className: ["docs-table"] }, [node]);
        return SKIP;
      }
      if (node.tagName === "pre" && parent && index !== undefined) {
        const code = node.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
        if (!code) return undefined;
        const requested = classes(code).find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "text";
        const resolved = LANGUAGE_ALIASES[requested] ?? requested;
        const lang = highlighter.getLoadedLanguages().includes(resolved) ? resolved : "text";
        const source = hastToString(code).replace(/\n$/, "");
        const highlighted = highlighter.codeToHast(source, {
          lang,
          themes: { light: LIGHT_THEME, dark: DARK_THEME },
          defaultColor: false,
        });
        const pre = highlighted.children.find((c): c is Element => c.type === "element" && c.tagName === "pre");
        if (!pre) return undefined;
        pre.properties = { ...pre.properties, style: undefined, tabIndex: 0 };
        const title = codeTitle(code.data && "meta" in code.data ? code.data.meta : undefined);
        const label = title ?? LANGUAGE_LABELS[lang] ?? (lang === "text" ? requested : lang);
        parent.children[index] = el("div", { className: ["docs-code"], dataLang: lang }, [
          el("div", { className: ["docs-code-bar"] }, [
            el("span", { className: title ? ["docs-code-title"] : ["docs-code-lang"] }, [{ type: "text", value: label }]),
            el("button", { type: "button", className: ["docs-copy"], dataCopy: "", title: "Copy code", ariaLive: "polite" }, [
              { type: "text", value: "Copy" },
            ]),
          ]),
          pre,
        ]);
        return SKIP;
      }
      return undefined;
    });
  };
}

async function renderMarkdown(markdown: string): Promise<{ html: string } & RenderState> {
  const state: RenderState = { headings: [], links: [] };
  const highlighter = await getHighlighter();
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeDocs(highlighter, state))
    .use(rehypeStringify)
    .process(markdown);
  return { html: String(file), ...state };
}

/** Rendered pages by content key; insertion-ordered, so the oldest entry is dropped first. */
const renderCache = new Map<string, Promise<RenderedDoc>>();
/** Enough for every page at the instance URL plus the search index, with room for edits in development. */
const RENDER_CACHE_LIMIT = 200;

/**
 * Renders the page at `slug` with `{{url}}` filled in, or null when there is no such page.
 * Results are cached per file, URL and file contents, so edits show up in development.
 */
export async function renderDoc(
  slug: string[],
  opts: { url: string; dir?: string },
): Promise<RenderedDoc | null> {
  const docs = listDocs(opts.dir);
  const index = docs.findIndex((d) => d.path === docPath(slug));
  return index === -1 ? null : renderAt(docs, index, opts.url);
}

/** Renders `docs[index]` with its neighbours; cached per file contents, URL and neighbours. */
function renderAt(docs: DocMeta[], index: number, url: string): Promise<RenderedDoc> {
  const doc = docs[index] as DocMeta;
  const prev = docs[index - 1];
  const next = docs[index + 1];
  const source = readFileSync(doc.file, "utf8");
  const key = [doc.file, url, prev?.path, prev?.title, next?.path, next?.title, source].join("\u0000");
  let cached = renderCache.get(key);
  if (!cached) {
    if (renderCache.size >= RENDER_CACHE_LIMIT) renderCache.delete(renderCache.keys().next().value as string);
    cached = renderMarkdown(fillUrl(parseFrontmatter(source, doc.file).body, url)).then(({ html, headings }) => ({
      ...doc,
      html,
      headings,
      prev: prev && { path: prev.path, title: prev.title },
      next: next && { path: next.path, title: next.title },
    }));
    renderCache.set(key, cached);
    cached.catch(() => renderCache.delete(key));
  }
  return cached;
}

/** Search entries for every page: title, section, description and headings. */
export async function searchIndex(dir: string = DOCS_DIR): Promise<DocSearchEntry[]> {
  const docs = listDocs(dir);
  return Promise.all(
    docs.map(async (doc, index) => {
      const rendered = await renderAt(docs, index, "");
      return {
        path: doc.path,
        title: doc.title,
        description: doc.description,
        section: doc.section,
        headings: rendered.headings.map(({ id, text }) => ({ id, text })),
      };
    }),
  );
}

/** Internal `/docs` links that point at a missing page or a missing heading anchor. */
export async function findBrokenDocLinks(dir: string = DOCS_DIR): Promise<{ from: string; href: string }[]> {
  const docs = listDocs(dir);
  const rendered = await Promise.all(
    docs.map(async (doc) => {
      const source = readFileSync(doc.file, "utf8");
      const { headings, links } = await renderMarkdown(fillUrl(parseFrontmatter(source, doc.file).body, ""));
      return { doc, anchors: new Set(headings.map((h) => h.id)), links };
    }),
  );
  const byPath = new Map(rendered.map((r) => [r.doc.path, r]));
  const broken: { from: string; href: string }[] = [];
  for (const { doc, links } of rendered) {
    for (const href of links) {
      if (!href.startsWith("/docs") && !href.startsWith("#")) continue;
      const [path = "", anchor] = href.startsWith("#") ? [doc.path, href.slice(1)] : href.split("#");
      const target = byPath.get(path.replace(/\/+$/, "") || "/docs");
      if (!target || (anchor && !target.anchors.has(anchor))) broken.push({ from: doc.path, href });
    }
  }
  return broken.sort((a, b) => a.from.localeCompare(b.from) || a.href.localeCompare(b.href));
}
