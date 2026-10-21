import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractArchive, sha256, type ProtoFile } from "@protoloom/core";
import { RegistryClient, type ResolveConflict } from "./client.js";
import { CliError } from "./config.js";

export interface FetchOptions {
  url: string;
  token?: string;
  repositories: string[];
  dependencies: string[];
  outDir: string;
  cacheDir: string;
  /** Receives non-fatal notices such as version conflicts. */
  warn?: (message: string) => void;
}

export interface FetchResult {
  artifacts: number;
  files: number;
}

/** `node_modules/.cache/protoloom` when a node_modules folder exists in `cwd`, else `~/.cache/protoloom`. */
export function defaultCacheDir(cwd: string): string {
  return existsSync(join(cwd, "node_modules"))
    ? join(cwd, "node_modules", ".cache", "protoloom")
    : join(homedir(), ".cache", "protoloom");
}

const hasIllegalChar = (segment: string): boolean =>
  /[<>:"|?*]/.test(segment) || [...segment].some((ch) => ch.charCodeAt(0) < 0x20);
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Returns why a relative path cannot be created on Windows, or undefined when it is safe everywhere. */
function unsafeReason(path: string): string | undefined {
  for (const segment of path.split("/")) {
    if (hasIllegalChar(segment)) return `illegal character in "${segment}"`;
    // Windows treats "con.proto" like "con".
    if (RESERVED_NAMES.test(segment.split(".")[0] as string)) return `reserved name "${segment}"`;
    if (/[. ]$/.test(segment)) return `trailing dot or space in "${segment}"`;
  }
  return undefined;
}

interface Placed {
  coordinate: string;
  file: ProtoFile;
}

/** Validates every output path and flattens the artifacts into one conflict-free list. */
function placeFiles(extracted: { coordinate: string; files: ProtoFile[] }[]): Placed[] {
  const byKey = new Map<string, { path: string; coordinate: string }>();
  const placed: Placed[] = [];
  for (const { coordinate, files } of extracted) {
    for (const file of files) {
      const reason = unsafeReason(file.path);
      if (reason) {
        throw new CliError(`Unsafe output path "${file.path}" in ${coordinate}: ${reason}`);
      }
      const key = file.path.toLowerCase();
      const other = byKey.get(key);
      if (other) {
        throw new CliError(
          other.path === file.path
            ? `Path "${file.path}" is provided by both ${other.coordinate} and ${coordinate}`
            : `Paths "${other.path}" (${other.coordinate}) and "${file.path}" (${coordinate}) collide on case-insensitive file systems`,
        );
      }
      byKey.set(key, { path: file.path, coordinate });
      placed.push({ coordinate, file });
    }
  }
  return placed;
}

async function readCached(path: string, expected: string): Promise<Buffer | undefined> {
  try {
    const data = await readFile(path);
    return sha256(data) === expected ? data : undefined;
  } catch {
    return undefined;
  }
}

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

function assertSafeOutDir(outDir: string): void {
  const rel = relative(outDir, process.cwd());
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new CliError(`Refusing to replace ${outDir}: it is or contains the working directory`);
  }
  if (dirname(outDir) === outDir) throw new CliError("Refusing to replace the file system root");
}

function describeConflict(c: ResolveConflict): string {
  return `${c.group}:${c.name} requested at ${c.requested.join(", ")}; using ${c.selected}`;
}

/**
 * Resolves the dependencies against the registry, downloads (or reuses cached)
 * archives, and replaces `outDir` with the union of their proto files.
 * Nothing is written to `outDir` unless every artifact verified and every path is safe.
 */
export async function fetchProtos(opts: FetchOptions): Promise<FetchResult> {
  const outDir = resolve(opts.outDir);
  assertSafeOutDir(outDir);
  const client = new RegistryClient(opts.url, opts.token);
  const resolution = await client.resolve(opts.repositories, opts.dependencies);
  for (const conflict of resolution.conflicts) opts.warn?.(`Version conflict: ${describeConflict(conflict)}`);

  const extracted: { coordinate: string; files: ProtoFile[] }[] = [];
  for (const artifact of resolution.artifacts) {
    const cachePath = join(opts.cacheDir, `${artifact.sha256}.tar.gz`);
    let data = await readCached(cachePath, artifact.sha256);
    if (!data) {
      const downloaded = await client.download(artifact.archiveUrl);
      const actual = sha256(downloaded.data);
      if (actual !== artifact.sha256 || (downloaded.sha256 !== undefined && downloaded.sha256 !== actual)) {
        throw new CliError(
          `Checksum mismatch for ${artifact.coordinate}: expected ${artifact.sha256}, ` +
            `server header ${downloaded.sha256 ?? "(none)"}, downloaded ${actual}`,
        );
      }
      data = downloaded.data;
      await writeAtomic(cachePath, data);
    }
    try {
      extracted.push({ coordinate: artifact.coordinate, files: await extractArchive(data) });
    } catch (err) {
      throw new CliError(`Invalid archive for ${artifact.coordinate}: ${(err as Error).message}`);
    }
  }

  const placed = placeFiles(extracted);

  const tmpDir = `${outDir}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  try {
    for (const { file } of placed) {
      const target = join(tmpDir, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    await rm(outDir, { recursive: true, force: true });
    await rename(tmpDir, outDir);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
  return { artifacts: resolution.artifacts.length, files: placed.length };
}
