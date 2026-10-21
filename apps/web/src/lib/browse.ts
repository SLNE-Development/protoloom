/** Pure helpers of the artifact browser: paths, usage snippets, the file tree and formatting. */

/** The browse page of a repository. */
export function repositoryHref(repository: string): string {
  return `/browse/${encodeURIComponent(repository)}`;
}

/** The page of an artifact, or of one of its versions when `version` is given. */
export function artifactHref(repository: string, group: string, name: string, version?: string): string {
  const base = `${repositoryHref(repository)}/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
  return version === undefined ? base : `${base}/${encodeURIComponent(version)}`;
}

/** What a usage snippet needs: the public base URL, the repository and the `group:name:version`. */
export interface SnippetInput {
  url: string;
  repository: string;
  coordinate: string;
}

/** Gradle (Kotlin DSL) setup that fetches the artifact with the Protoloom plugin. */
export function gradleSnippet({ url, repository, coordinate }: SnippetInput): string {
  return [
    "protoloom {",
    `    url = "${url}"`,
    '    token = providers.environmentVariable("PROTOLOOM_TOKEN")',
    `    repositories("${repository}")`,
    "}",
    "",
    "dependencies {",
    `    protoloom("${coordinate}")`,
    "}",
  ].join("\n");
}

/** A `protoloom.json` for `protoloom fetch` that fetches the artifact into `./protos`. */
export function protoloomJsonSnippet({ url, repository, coordinate }: SnippetInput): string {
  return JSON.stringify({ url, repositories: [repository], dependencies: [coordinate], outDir: "./protos" }, null, 2);
}

/** A node of a version's file tree. Folder names may span several path segments (collapsed chains). */
export type FileTreeNode =
  | { kind: "file"; name: string; path: string }
  | { kind: "folder"; name: string; path: string; children: FileTreeNode[] };

interface MutableFolder {
  folders: Map<string, MutableFolder>;
  files: string[];
}

function toNodes(folder: MutableFolder, prefix: string): FileTreeNode[] {
  const folders = [...folder.folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, child]): FileTreeNode => {
      // Collapse folders that only hold a single folder ("dev/example/v1" instead of three levels).
      let name = segment;
      let current = child;
      while (current.files.length === 0 && current.folders.size === 1) {
        const [nextName, next] = [...current.folders.entries()][0]!;
        name = `${name}/${nextName}`;
        current = next;
      }
      const path = prefix + name;
      return { kind: "folder", name, path, children: toNodes(current, `${path}/`) };
    });
  const files = [...folder.files]
    .sort((a, b) => a.localeCompare(b))
    .map((name): FileTreeNode => ({ kind: "file", name, path: prefix + name }));
  return [...folders, ...files];
}

/** Turns relative file paths into a tree: folders before files, each sorted by name. */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: MutableFolder = { folders: new Map(), files: [] };
  for (const path of paths) {
    const segments = path.split("/");
    const file = segments.pop()!;
    let folder = root;
    for (const segment of segments) {
      let next = folder.folders.get(segment);
      if (!next) {
        next = { folders: new Map(), files: [] };
        folder.folders.set(segment, next);
      }
      folder = next;
    }
    folder.files.push(file);
  }
  return toNodes(root, "");
}

/** The first file of the tree in display order, or `null` for an empty tree. */
export function firstFile(nodes: FileTreeNode[]): string | null {
  for (const node of nodes) {
    if (node.kind === "file") return node.path;
    const inner = firstFile(node.children);
    if (inner) return inner;
  }
  return null;
}

/** Human-readable size in binary units. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "5 minutes ago", "yesterday", … relative to `now`; under a minute is "just now". */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** Absolute timestamp for tooltips, in UTC so server and client agree. */
export function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The `pageMetadata()` input of an artifact version page. */
export interface ArtifactMetadataInput {
  title: string;
  description: string;
  path: string;
  image?: string;
  noindex?: boolean;
}

/**
 * Metadata of a version page. Public artifacts get an indexable page with the artifact share
 * card; private ones (and versions the visitor can't see, `visibility: null`) stay out of search
 * engines and get the generic card, with a description that names nothing.
 */
export function artifactMetadataInput(input: {
  repository: string;
  group: string;
  name: string;
  version: string;
  visibility: "public" | "private" | null;
  fileCount?: number;
  dependencyCount?: number;
}): ArtifactMetadataInput {
  const { repository, group, name, version, visibility } = input;
  const path = artifactHref(repository, group, name, version);
  if (visibility === null) {
    return { title: "Artifact", description: "A protobuf artifact on this Protoloom.", path, noindex: true };
  }
  const coordinate = `${group}:${name}:${version}`;
  if (visibility === "private") {
    return { title: coordinate, description: "A protobuf artifact in a private repository.", path, noindex: true };
  }
  const files = input.fileCount ?? 0;
  const deps = input.dependencyCount ?? 0;
  const parts = [
    `${files} proto ${files === 1 ? "file" : "files"}`,
    deps > 0 ? `${deps} ${deps === 1 ? "dependency" : "dependencies"}` : "no dependencies",
  ];
  return {
    title: coordinate,
    description: `${coordinate} in the ${repository} repository: ${parts.join(", ")}. Fetch it with Gradle or the protoloom CLI.`,
    path,
    image: `/og/artifact/${[repository, group, name, version].map(encodeURIComponent).join("/")}`,
  };
}
