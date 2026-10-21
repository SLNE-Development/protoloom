import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Header } from "tar";
import { LIMITS, extractArchive, packArchive, sha256, type ProtoFile } from "./archive.js";
import { RegistryError } from "./errors.js";

interface RawEntry {
  path: string;
  content?: string | Buffer;
  type?: "File" | "SymbolicLink" | "Directory";
  linkpath?: string;
}

/** Hand-rolled tar.gz builder so tests can create entries the packer would refuse. */
function rawArchive(entries: RawEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.content ?? "");
    const type = e.type ?? "File";
    const size = type === "File" ? body.length : 0;
    const head = Buffer.alloc(512);
    new Header({
      path: e.path,
      type,
      size,
      mode: 0o644,
      mtime: new Date(0),
      linkpath: e.linkpath,
    }).encode(head, 0);
    blocks.push(head);
    if (size > 0) {
      blocks.push(body, Buffer.alloc((512 - (size % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RegistryError) return e.code;
    throw e;
  }
  return "none";
}

describe("archive", () => {
  const files: ProtoFile[] = [
    { path: "z/last.proto", content: 'syntax = "proto3";\n' },
    { path: "a/first.proto", content: "// héllo\n" },
    { path: "m.proto", content: "" },
  ];

  it("round-trips files sorted by path", async () => {
    const out = await extractArchive(await packArchive(files));
    expect(out).toEqual([...files].sort((a, b) => (a.path < b.path ? -1 : 1)));
  });

  it("round-trips paths longer than 100 characters", async () => {
    const long = { path: `${"d/".repeat(60)}x.proto`, content: "x" };
    expect(await extractArchive(await packArchive([long]))).toEqual([long]);
  });

  it("packs deterministically regardless of input order", async () => {
    const a = sha256(await packArchive(files));
    const b = sha256(await packArchive([...files].reverse()));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects traversal, absolute, symlink, non-proto and empty archives", async () => {
    const bad: Buffer[] = [
      rawArchive([{ path: "../evil.proto", content: "x" }]),
      rawArchive([{ path: "a/../../evil.proto", content: "x" }]),
      rawArchive([{ path: "/abs.proto", content: "x" }]),
      rawArchive([{ path: "C:/abs.proto", content: "x" }]),
      rawArchive([{ path: "link.proto", type: "SymbolicLink", linkpath: "/etc/passwd" }]),
      rawArchive([{ path: "readme.md", content: "x" }]),
      rawArchive([]),
      rawArchive([{ path: "d", type: "Directory" }]),
      rawArchive([{ path: "bad.proto", content: Buffer.from([0xff, 0xfe]) }]),
      Buffer.from("not a gzip"),
    ];
    for (const archive of bad) {
      expect(await codeOf(extractArchive(archive))).toBe("invalid_request");
    }
  });

  it("ignores directory entries alongside files", async () => {
    const out = await extractArchive(rawArchive([{ path: "d", type: "Directory" }, { path: "d/a.proto", content: "x" }]));
    expect(out).toEqual([{ path: "d/a.proto", content: "x" }]);
  });

  it("normalizes ./ prefixes and rejects duplicates after normalization", async () => {
    const out = await extractArchive(rawArchive([{ path: "./a/b.proto", content: "x" }]));
    expect(out).toEqual([{ path: "a/b.proto", content: "x" }]);
    const dup = rawArchive([
      { path: "./a/b.proto", content: "x" },
      { path: "a/b.proto", content: "y" },
    ]);
    expect(await codeOf(extractArchive(dup))).toBe("invalid_request");
  });

  it("rejects an archive over the byte limit", async () => {
    const big = Buffer.alloc(LIMITS.archiveBytes + 1, 1);
    expect(await codeOf(extractArchive(big))).toBe("payload_too_large");
  });

  it("rejects more than 1000 files", async () => {
    const entries = Array.from({ length: LIMITS.files + 1 }, (_, i) => ({ path: `f${i}.proto`, content: "x" }));
    expect(await codeOf(extractArchive(rawArchive(entries)))).toBe("payload_too_large");
    expect(await extractArchive(rawArchive(entries.slice(0, LIMITS.files)))).toHaveLength(LIMITS.files);
  });

  it("rejects a file over 1 MiB after decompression (gzip bomb)", async () => {
    const bomb = rawArchive([{ path: "big.proto", content: Buffer.alloc(2 * 1024 * 1024, 0x61) }]);
    expect(bomb.length).toBeLessThan(LIMITS.archiveBytes);
    expect(await codeOf(extractArchive(bomb))).toBe("payload_too_large");
  });
});
