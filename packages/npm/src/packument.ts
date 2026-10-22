/** One published version as it appears in a packument. */
export interface VersionManifest {
  name: string;
  version: string;
  dist: { tarball: string; shasum: string; integrity?: string; [k: string]: unknown };
  deprecated?: string;
  [k: string]: unknown;
}

/** The full npm metadata document of a package. */
export interface Packument {
  _id: string;
  _rev?: string;
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, VersionManifest>;
  time: Record<string, string>;
  readme?: string;
  description?: string;
  [k: string]: unknown;
}

/** The install-only metadata document served for the abbreviated media type. */
export interface AbbreviatedPackument {
  name: string;
  modified: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, Partial<VersionManifest>>;
}

/** Media type of the abbreviated packument. */
export const ABBREVIATED_TYPE = "application/vnd.npm.install-v1+json";

const ABBREVIATED_FIELDS = [
  "name",
  "version",
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "bundleDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "acceptDependencies",
  "bin",
  "directories",
  "dist",
  "engines",
  "os",
  "cpu",
  "libc",
  "_hasShrinkwrap",
  "hasInstallScript",
  "deprecated",
  "funding",
] as const;

/** Whether an Accept header lists the abbreviated media type with a quality above zero. */
export function wantsAbbreviated(accept: string | null): boolean {
  if (!accept) return false;
  for (const part of accept.split(",")) {
    const [type, ...params] = part.split(";").map((s) => s.trim());
    if (type?.toLowerCase() !== ABBREVIATED_TYPE) continue;
    const q = params.find((p) => p.toLowerCase().startsWith("q="));
    const value = q ? Number(q.slice(2)) : 1;
    if (Number.isNaN(value) || value > 0) return true;
  }
  return false;
}

/** Reduces a packument to the fields package managers need to install. */
export function abbreviate(p: Packument): AbbreviatedPackument {
  const versions: Record<string, Partial<VersionManifest>> = {};
  for (const [version, manifest] of Object.entries(p.versions)) {
    const kept: Record<string, unknown> = {};
    for (const field of ABBREVIATED_FIELDS) {
      if (manifest[field] !== undefined) kept[field] = manifest[field];
    }
    versions[version] = kept as Partial<VersionManifest>;
  }
  return { name: p.name, modified: p.time["modified"] ?? "", "dist-tags": { ...p["dist-tags"] }, versions };
}

/**
 * Returns a copy of the packument whose tarball URLs point at `${base}/${name}/-/${file}`, where `base` is
 * `${publicUrl}/npm/${repo}`. Absolute and relative upstream tarball URLs are both handled.
 */
export function rewriteTarballs<T extends { versions: Record<string, Partial<VersionManifest>> }>(p: T, base: string): T {
  const versions: Record<string, Partial<VersionManifest>> = {};
  for (const [version, manifest] of Object.entries(p.versions)) {
    const tarball = manifest.dist?.tarball;
    if (!manifest.dist || typeof tarball !== "string" || typeof manifest.name !== "string") {
      versions[version] = manifest;
      continue;
    }
    const file = tarball.split(/[?#]/)[0]!.split("/").pop() ?? "";
    versions[version] = { ...manifest, dist: { ...manifest.dist, tarball: `${base}/${manifest.name}/-/${file}` } };
  }
  return { ...p, versions };
}

/**
 * Merges the packuments of a group's members, in member order. The first packument wins per version, dist-tag and time
 * entry; the readme comes from the first that has one; `time.modified` is the latest of all.
 */
export function mergePackuments(list: Packument[]): Packument {
  const first = list[0];
  if (!first) throw new Error("mergePackuments needs at least one packument");
  const merged: Packument = { ...first, "dist-tags": {}, versions: {}, time: {} };
  delete merged.readme;
  let modified = "";
  for (const p of list) {
    for (const [k, v] of Object.entries(p.versions)) if (!(k in merged.versions)) merged.versions[k] = v;
    for (const [k, v] of Object.entries(p["dist-tags"])) if (!(k in merged["dist-tags"])) merged["dist-tags"][k] = v;
    for (const [k, v] of Object.entries(p.time)) {
      if (k === "modified") {
        if (v > modified) modified = v;
      } else if (!(k in merged.time)) merged.time[k] = v;
    }
    if (merged.readme === undefined && p.readme) merged.readme = p.readme;
  }
  if (modified) merged.time["modified"] = modified;
  return merged;
}
