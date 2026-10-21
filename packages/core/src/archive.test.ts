import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Header } from "tar";
import { LIMITS, extractArchive, packArchive, sha256, type ProtoFile } from "./archive.js";
import { RegistryError } from "./errors.js";

interface RawEntry {
  path: string;
  content?: string | Buffer;
  type?: "File" | "SymbolicLink" | "Link" | "Directory";
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

  const rejected: [string, () => Buffer][] = [
    ["dot-dot prefix", () => rawArchive([{ path: "../evil.proto", content: "x" }])],
    ["dot-dot inside", () => rawArchive([{ path: "a/../../evil.proto", content: "x" }])],
    ["absolute path", () => rawArchive([{ path: "/abs.proto", content: "x" }])],
    ["drive letter", () => rawArchive([{ path: "C:/abs.proto", content: "x" }])],
    ["backslash in header path", () => rawArchive([{ path: "a\\b.proto", content: "x" }])],
    ["backslash in pax path", () => rawArchive([{ path: `${"d/".repeat(60)}a\\b.proto`, content: "x" }])],
    ["symlink", () => rawArchive([{ path: "link.proto", type: "SymbolicLink", linkpath: "/etc/passwd" }])],
    ["hardlink", () => rawArchive([{ path: "link.proto", type: "Link", linkpath: "other.proto" }])],
    ["non-proto file", () => rawArchive([{ path: "readme.md", content: "x" }])],
    ["empty archive", () => rawArchive([])],
    ["traversal in a directory entry", () => rawArchive([{ path: "../x/", type: "Directory" }, { path: "a.proto", content: "x" }])],
    ["absolute directory entry", () => rawArchive([{ path: "/x/", type: "Directory" }, { path: "a.proto", content: "x" }])],
    ["backslash in directory entry", () => rawArchive([{ path: "x\\y/", type: "Directory" }, { path: "a.proto", content: "x" }])],
    ["directory-only archive", () => rawArchive([{ path: "d", type: "Directory" }])],
    ["invalid UTF-8", () => rawArchive([{ path: "bad.proto", content: Buffer.from([0xff, 0xfe]) }])],
    ["not gzip", () => Buffer.from("not a gzip")],
  ];
  it.each(rejected)("rejects %s with invalid_request", async (_name, build) => {
    expect(await codeOf(extractArchive(build()))).toBe("invalid_request");
  });

  it("round-trips a path segment over 100 characters and a path over 255", async () => {
    const seg = { path: `${"s".repeat(150)}.proto`, content: "seg" };
    const deep = { path: `${"dir/".repeat(70)}file.proto`, content: "deep" };
    expect(deep.path.length).toBeGreaterThan(255);
    const out = await extractArchive(await packArchive([seg, deep]));
    expect(out).toEqual([deep, seg].sort((a, b) => (a.path < b.path ? -1 : 1)));
  });

  it("pins the gzip OS byte so output is platform independent", async () => {
    expect((await packArchive(files))[9]).toBe(0xff);
  });

  it("packArchive validates paths and duplicates", async () => {
    expect(await codeOf(packArchive([{ path: "../x.proto", content: "" }]))).toBe("invalid_request");
    expect(await codeOf(packArchive([{ path: "x.txt", content: "" }]))).toBe("invalid_request");
    expect(
      await codeOf(packArchive([{ path: "./a.proto", content: "" }, { path: "a.proto", content: "" }])),
    ).toBe("invalid_request");
  });

  it("rejects total content over the cap even when each file is small enough", async () => {
    const count = LIMITS.totalBytes / LIMITS.fileBytes + 8;
    const entries = Array.from({ length: count }, (_, i) => ({
      path: `f${i}.proto`,
      content: Buffer.alloc(LIMITS.fileBytes, 0x61),
    }));
    const archive = rawArchive(entries);
    expect(archive.length).toBeLessThan(LIMITS.archiveBytes);
    expect(await codeOf(extractArchive(archive))).toBe("payload_too_large");
  });

  it("skips directory entries alongside files", async () => {
    const out = await extractArchive(
      rawArchive([
        { path: "b/", type: "Directory" },
        { path: "b/v1/", type: "Directory" },
        { path: "b/v1/a.proto", content: "x" },
      ]),
    );
    expect(out).toEqual([{ path: "b/v1/a.proto", content: "x" }]);
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
