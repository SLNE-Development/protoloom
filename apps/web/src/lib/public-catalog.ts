import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { and, asc, countDistinct, eq, exists, sql } from "drizzle-orm";
import { artifact, build, repository, version, type Db } from "@protoloom/db";

/**
 * Where the docs Markdown lives (`content/docs/**\/*.md`, path = URL), relative to the app root.
 * next.config.ts traces this folder into the standalone output for the sitemap.
 */
export const DOCS_CONTENT_DIR = join(process.cwd(), "content", "docs");

/**
 * URL paths of every docs page under `dir`: `index.md` → `/docs`, `admin/keys.md` →
 * `/docs/admin/keys`, `admin/index.md` → `/docs/admin`. Sorted; empty when the folder is missing.
 */
export async function listDocsPaths(dir: string = DOCS_CONTENT_DIR): Promise<string[]> {
  let entries: string[];
  try {
    // Scoped to the docs folder; the folder is traced explicitly (see DOCS_CONTENT_DIR).
    entries = await readdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => {
      const slug = entry
        .split(sep)
        .join("/")
        .replace(/\.md$/, "")
        .replace(/(^|\/)index$/, "");
      return slug ? `/docs/${slug}` : "/docs";
    })
    .sort();
}

/** Counts shown on the landing page; only public repositories are ever counted. */
export interface PublicStats {
  repositories: number;
  artifacts: number;
}

/** Number of public repositories, and of artifacts (group:name) in them with at least one published build. */
export async function getPublicStats(db: Db): Promise<PublicStats> {
  const isPublic = eq(repository.visibility, "public");
  const [[repos], [artifacts]] = await Promise.all([
    db.select({ count: countDistinct(repository.id) }).from(repository).where(isPublic),
    db
      .select({ count: countDistinct(artifact.id) })
      .from(artifact)
      .innerJoin(repository, and(eq(repository.id, artifact.repositoryId), isPublic))
      .innerJoin(version, eq(version.artifactId, artifact.id))
      .innerJoin(build, eq(build.versionId, version.id)),
  ]);
  return { repositories: repos?.count ?? 0, artifacts: artifacts?.count ?? 0 };
}

/** A crawlable browse page of a public repository. */
export interface BrowsePage {
  path: string;
  lastModified?: Date;
}

/** Sitemaps hold at most 50,000 URLs; stay below that. */
const MAX_BROWSE_PAGES = 45_000;

function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Browse pages of public repositories: each repository, and each artifact and version that has a
 * published build, sorted by path. Private repositories never appear.
 */
export async function listPublicBrowsePages(db: Db): Promise<BrowsePage[]> {
  const [repos, versions] = await Promise.all([
    db
      .select({ name: repository.name })
      .from(repository)
      .where(eq(repository.visibility, "public"))
      .orderBy(asc(repository.name)),
    db
      .select({
        repository: repository.name,
        group: artifact.group,
        name: artifact.name,
        version: version.version,
        updatedAt: version.updatedAt,
      })
      .from(version)
      .innerJoin(artifact, eq(artifact.id, version.artifactId))
      .innerJoin(repository, and(eq(repository.id, artifact.repositoryId), eq(repository.visibility, "public")))
      // Only versions with a published build have a page.
      .where(exists(db.select({ one: sql`1` }).from(build).where(eq(build.versionId, version.id))))
      .limit(MAX_BROWSE_PAGES),
  ]);

  const pages = new Map<string, BrowsePage>();
  for (const repo of repos) pages.set(`/browse/${segment(repo.name)}`, { path: `/browse/${segment(repo.name)}` });
  for (const v of versions) {
    const artifactPath = `/browse/${segment(v.repository)}/${segment(v.group)}/${segment(v.name)}`;
    const previous = pages.get(artifactPath)?.lastModified;
    if (!previous || previous < v.updatedAt) pages.set(artifactPath, { path: artifactPath, lastModified: v.updatedAt });
    const versionPath = `${artifactPath}/${segment(v.version)}`;
    pages.set(versionPath, { path: versionPath, lastModified: v.updatedAt });
  }
  return [...pages.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, MAX_BROWSE_PAGES);
}
