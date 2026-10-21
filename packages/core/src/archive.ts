import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import { Header, Pax, Parser, type ReadEntry } from "tar";
import { RegistryError } from "./errors.js";

/** A single .proto source file addressed by its normalized relative path. */
export interface ProtoFile {
  path: string;
  content: string;
}

/** Hard limits applied to uploaded archives. */
export const LIMITS = {
  archiveBytes: 10 * 1024 * 1024,
  files: 1000,
  fileBytes: 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
} as const;

/** Backstop for everything the decompressor may emit (file bodies plus tar framing and metadata). */
const MAX_DECOMPRESSED_BYTES = LIMITS.totalBytes * 2;

/** Lowercase hex SHA-256 digest of the given bytes. */
export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function invalid(message: string): RegistryError {
  return new RegistryError("invalid_request", message);
}

function tooLarge(message: string): RegistryError {
  return new RegistryError("payload_too_large", message);
}

/**
 * Validates an archive entry path and returns its normalized form: relative,
 * forward-slash separated, no `.`/empty/`..` segments, ending in `.proto`.
 */
function normalizePath(raw: string, directory = false): string {
  if (raw.includes("\0") || raw.includes("\\")) {
    throw invalid(`Invalid path in archive: ${JSON.stringify(raw)}`);
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw invalid(`Absolute paths are not allowed: ${raw}`);
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw invalid(`Path traversal is not allowed: ${raw}`);
    segments.push(segment);
  }
  const path = segments.join("/");
  if (directory) return path;
  if (!path.endsWith(".proto")) {
    throw invalid(`Only .proto files are allowed: ${raw}`);
  }
  return path;
}

/** Passes bytes through while aborting once the decompressed total exceeds the cap. */
function limitedPassThrough(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      total += chunk.length;
      if (total > max) {
        cb(tooLarge("Archive expands beyond the allowed size"));
        return;
      }
      cb(null, chunk);
    },
  });
}

/**
 * Safely extracts a tar.gz held in memory into proto files, sorted by path.
 * Never touches the file system; rejects traversal, links, non-.proto entries,
 * duplicates and anything exceeding {@link LIMITS}.
 */
export async function extractArchive(data: Buffer): Promise<ProtoFile[]> {
  if (data.length > LIMITS.archiveBytes) {
    throw tooLarge(`Archive exceeds ${LIMITS.archiveBytes} bytes`);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const found = new Map<string, string>();
  let totalContent = 0;

  await new Promise<void>((resolve, reject) => {
    const gunzip = createGunzip();
    const limiter = limitedPassThrough(MAX_DECOMPRESSED_BYTES);
    const parser = new Parser({ strict: true });
    let failed = false;

    const fail = (err: unknown): void => {
      if (failed) return;
      failed = true;
      reject(
        err instanceof RegistryError ? err : invalid("Archive is not a valid tar.gz"),
      );
      source.destroy();
      gunzip.destroy();
      limiter.destroy();
    };

    parser.on("entry", (entry: ReadEntry) => {
      if (failed) {
        entry.resume();
        return;
      }
      try {
        // node-tar rewrites backslashes on Windows, so check the raw header name too.
        if (entry.header.path?.includes("\\")) {
          throw invalid(`Backslashes are not allowed in paths: ${entry.path}`);
        }
        if (entry.type === "Directory") {
          normalizePath(entry.path, true);
          entry.resume();
          return;
        }
        if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "ContiguousFile") {
          throw invalid(`Unsupported entry type ${entry.type}: ${entry.path}`);
        }
        const path = normalizePath(entry.path);
        if (found.has(path)) throw invalid(`Duplicate path: ${path}`);
        if (found.size >= LIMITS.files) {
          throw tooLarge(`Archive contains more than ${LIMITS.files} files`);
        }
        if (entry.size > LIMITS.fileBytes) {
          throw tooLarge(`${path} exceeds ${LIMITS.fileBytes} bytes`);
        }
        // Reserve the slot now so duplicates and counts are checked in order.
        found.set(path, "");
        const chunks: Buffer[] = [];
        let size = 0;
        entry.on("data", (chunk: Buffer) => {
          size += chunk.length;
          totalContent += chunk.length;
          if (size > LIMITS.fileBytes) {
            fail(tooLarge(`${path} exceeds ${LIMITS.fileBytes} bytes`));
            return;
          }
          if (totalContent > LIMITS.totalBytes) {
            fail(tooLarge(`Archive content exceeds ${LIMITS.totalBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        entry.on("end", () => {
          if (failed) return;
          try {
            found.set(path, decoder.decode(Buffer.concat(chunks)));
          } catch {
            fail(invalid(`${path} is not valid UTF-8`));
          }
        });
      } catch (err) {
        entry.resume();
        fail(err);
      }
    });
    // Pax and GNU long-name records, before node-tar normalizes their paths.
    parser.on("meta", (raw: string) => {
      if (raw.includes("\\")) fail(invalid("Backslashes are not allowed in paths"));
    });
    parser.on("warn", (_code: string, message: string | Error) => {
      fail(invalid(typeof message === "string" ? message : message.message));
    });
    parser.on("error", fail);
    gunzip.on("error", fail);
    limiter.on("error", fail);
    parser.on("end", () => {
      if (!failed) resolve();
    });

    const source = Readable.from([data]);
    source.pipe(gunzip).pipe(limiter).pipe(parser);
  });

  if (found.size === 0) throw invalid("Archive contains no .proto files");

  return [...found.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => compare(a.path, b.path));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Encodes one file as tar blocks, adding a pax header when the path does not fit ustar. */
function encodeEntry(file: ProtoFile): Buffer[] {
  const body = Buffer.from(file.content, "utf8");
  const header = new Header({
    path: file.path,
    type: "File",
    size: body.length,
    mode: 0o644,
    uid: 0,
    gid: 0,
    uname: "",
    gname: "",
    mtime: new Date(0),
  });
  const block = Buffer.alloc(512);
  // node-tar only sets needPax while encoding.
  header.encode(block, 0);
  const blocks: Buffer[] = [];
  if (header.needPax) {
    const pax = new Pax(
      { path: file.path, mtime: new Date(0), uid: 0, gid: 0, uname: "", gname: "" },
      false,
    );
    blocks.push(pax.encode());
  }
  blocks.push(block, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  return blocks;
}

/**
 * Packs files into a deterministic tar.gz: entries sorted by path, mtime 0,
 * fixed ownership and mode, with the same path validation as extraction.
 * Identical inputs yield identical bytes on every platform (the gzip OS byte is
 * pinned); compressed bytes are only guaranteed stable for the same zlib version.
 */
export async function packArchive(files: ProtoFile[]): Promise<Buffer> {
  const seen = new Set<string>();
  const normalized = files.map((file) => {
    const path = normalizePath(file.path);
    if (seen.has(path)) throw invalid(`Duplicate path: ${path}`);
    seen.add(path);
    return { path, content: file.content };
  });
  normalized.sort((a, b) => compare(a.path, b.path));
  const blocks = normalized.flatMap(encodeEntry);
  blocks.push(Buffer.alloc(1024));
  const out = gzipSync(Buffer.concat(blocks), { level: 9 });
  // Node writes the host OS id (10 on Windows, 3 on Linux) into byte 9; pin it to "unknown".
  out[9] = 0xff;
  return out;
}
