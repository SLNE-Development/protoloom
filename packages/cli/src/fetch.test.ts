import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packArchive, sha256, type ProtoFile } from "@protoloom/core";
import { fetchProtos } from "./fetch.js";
import { run } from "./cli.js";

interface StubArtifact {
  group: string;
  name: string;
  version: string;
  files: ProtoFile[];
  /** Overrides for tampering tests. */
  headerSha?: string;
  resolveSha?: string;
  archiveHost?: string;
}

interface Logged {
  method: string;
  path: string;
  authorization?: string;
}

let server: Server;
let baseUrl: string;
let requests: Logged[];
let artifacts: StubArtifact[];
let archives: Map<string, Buffer>;
let work: string;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const coord = (a: StubArtifact): string => `${a.group}:${a.name}:${a.version}`;
const archivePath = (a: StubArtifact): string =>
  `/api/v1/repos/main/artifacts/${a.group}/${a.name}/${a.version}/archive`;

beforeEach(async () => {
  requests = [];
  artifacts = [];
  archives = new Map();
  work = await mkdtemp(join(tmpdir(), "protoloom-cli-"));
  server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0] as string;
      requests.push({ method: req.method ?? "", path, authorization: req.headers.authorization });
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization === "Bearer bad") {
        json(401, { error: { code: "unauthorized", message: "Invalid API key" } });
        return;
      }
      if (req.method === "POST" && path === "/api/v1/resolve") {
        await readBody(req);
        const out = [];
        for (const a of artifacts) {
          const archive = await packArchive(a.files);
          archives.set(archivePath(a), archive);
          out.push({
            repository: "main",
            coordinate: coord(a),
            group: a.group,
            name: a.name,
            version: a.version,
            buildNumber: 1,
            sha256: a.resolveSha ?? sha256(archive),
            archiveUrl: `${a.archiveHost ?? baseUrl}${archivePath(a)}`,
          });
        }
        json(200, { artifacts: out, conflicts: [] });
        return;
      }
      const archive = archives.get(path);
      if (req.method === "GET" && archive) {
        const a = artifacts.find((x) => archivePath(x) === path) as StubArtifact;
        res.writeHead(200, {
          "content-type": "application/gzip",
          "x-protoloom-sha256": a.headerSha ?? sha256(archive),
        });
        res.end(archive);
        return;
      }
      json(404, { error: { code: "not_found", message: "Not found" } });
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(work, { recursive: true, force: true });
});

const proto = (path: string, body = "syntax = \"proto3\";\n"): ProtoFile => ({ path, content: body });

function options(over: Partial<Parameters<typeof fetchProtos>[0]> = {}): Parameters<typeof fetchProtos>[0] {
  return {
    url: baseUrl,
    repositories: ["main"],
    dependencies: ["com.acme:a:1.0.0"],
    outDir: join(work, "out"),
    cacheDir: join(work, "cache"),
    ...over,
  };
}

async function tree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await tree(join(dir, e.name), `${prefix}${e.name}/`)));
    else out.push(`${prefix}${e.name}`);
  }
  return out.sort();
}

describe("fetchProtos", () => {
  it("writes the files of every resolved artifact with their paths intact", async () => {
    artifacts.push(
      { group: "com.acme", name: "a", version: "1.0.0", files: [proto("acme/a/a.proto", "A")] },
      { group: "com.acme", name: "b", version: "2.0.0", files: [proto("acme/b/b.proto", "B"), proto("acme/b/c.proto")] },
    );
    const result = await fetchProtos(options());
    expect(result).toEqual({ artifacts: 2, files: 3 });
    expect(await tree(join(work, "out"))).toEqual(["acme/a/a.proto", "acme/b/b.proto", "acme/b/c.proto"]);
    expect(await readFile(join(work, "out", "acme/a/a.proto"), "utf8")).toBe("A");
  });

  it("removes stale files left by a previous run", async () => {
    await mkdir(join(work, "out", "old"), { recursive: true });
    await writeFile(join(work, "out", "old", "gone.proto"), "x");
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")] });
    await fetchProtos(options());
    expect(await tree(join(work, "out"))).toEqual(["a.proto"]);
  });

  it("reuses the cached archive when the sha is unchanged", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")] });
    await fetchProtos(options());
    const archiveRequests = (): number => requests.filter((r) => r.path.endsWith("/archive")).length;
    expect(archiveRequests()).toBe(1);
    await fetchProtos(options());
    expect(archiveRequests()).toBe(1);
    expect(requests.filter((r) => r.path === "/api/v1/resolve")).toHaveLength(2);
    expect((await readdir(join(work, "cache"))).some((f) => f.endsWith(".tar.gz"))).toBe(true);
  });

  it("re-downloads when a cached archive is corrupt", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")] });
    await fetchProtos(options());
    const [cached] = await readdir(join(work, "cache"));
    await writeFile(join(work, "cache", cached as string), "garbage");
    await fetchProtos(options());
    expect(requests.filter((r) => r.path.endsWith("/archive"))).toHaveLength(2);
  });

  it("fails naming the coordinate when the archive sha differs from x-protoloom-sha256", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")], headerSha: "0".repeat(64) });
    await expect(fetchProtos(options())).rejects.toThrow(/Checksum mismatch for com\.acme:a:1\.0\.0/);
  });

  it("fails naming the coordinate when the archive sha differs from the resolve sha", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")], resolveSha: "1".repeat(64) });
    await expect(fetchProtos(options())).rejects.toThrow(/Checksum mismatch for com\.acme:a:1\.0\.0/);
  });

  it("fails naming both artifacts when two share a path", async () => {
    artifacts.push(
      { group: "com.acme", name: "a", version: "1.0.0", files: [proto("shared/x.proto")] },
      { group: "com.acme", name: "b", version: "1.0.0", files: [proto("shared/x.proto")] },
    );
    await expect(fetchProtos(options())).rejects.toThrow(/shared\/x\.proto.*com\.acme:a:1\.0\.0.*com\.acme:b:1\.0\.0/);
  });

  it("fails naming both artifacts when paths collide case-insensitively", async () => {
    artifacts.push(
      { group: "com.acme", name: "a", version: "1.0.0", files: [proto("Shared/X.proto")] },
      { group: "com.acme", name: "b", version: "1.0.0", files: [proto("shared/x.proto")] },
    );
    await expect(fetchProtos(options())).rejects.toThrow(/com\.acme:a:1\.0\.0.*com\.acme:b:1\.0\.0.*case-insensitive/);
  });

  it.each([
    ["dir/a:b.proto", "illegal character"],
    ["dir/a*b.proto", "illegal character"],
    ["dir/a?.proto", "illegal character"],
    ["dir/a<b>.proto", "illegal character"],
    ['dir/a"b.proto', "illegal character"],
    ["dir/a|b.proto", "illegal character"],
    ["CON/x.proto", "reserved"],
    ["dir/nul.proto", "reserved"],
    ["dir/COM1/x.proto", "reserved"],
    ["dir./x.proto", "trailing"],
    ["dir /x.proto", "trailing"],
  ])("rejects the Windows-unsafe path %s", async (path, reason) => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto(path)] });
    await expect(fetchProtos(options())).rejects.toThrow(new RegExp(`com\\.acme:a:1\\.0\\.0.*${reason}`));
    await expect(readdir(join(work, "out"))).rejects.toThrow();
  });

  it("sends the token to the configured host only and rebases foreign archive URLs", async () => {
    artifacts.push({
      group: "com.acme",
      name: "a",
      version: "1.0.0",
      files: [proto("a.proto")],
      archiveHost: "http://evil.invalid:9",
    });
    await fetchProtos(options({ token: "secret" }));
    const archiveReq = requests.find((r) => r.path.endsWith("/archive"));
    expect(archiveReq?.authorization).toBe("Bearer secret");
  });

  it("sends the token only to same-origin archive URLs (port counts)", async () => {
    artifacts.push({
      group: "com.acme",
      name: "a",
      version: "1.0.0",
      files: [proto("a.proto")],
      archiveHost: baseUrl.replace("127.0.0.1", "localhost"),
    });
    await fetchProtos(options({ token: "secret" }));
    // localhost is a different host than 127.0.0.1, so it was rebased onto the configured url.
    expect(requests.filter((r) => r.path.endsWith("/archive"))).toHaveLength(1);
  });

  it("refuses an outDir that is the working directory or contains it", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")] });
    await expect(fetchProtos(options({ outDir: process.cwd() }))).rejects.toThrow(/working directory/);
  });
});

describe("run", () => {
  function capture(): { io: { out: (s: string) => void; err: (s: string) => void }; err: string[] } {
    const err: string[] = [];
    return { io: { out: () => undefined, err: (s) => err.push(s) }, err };
  }

  it("prints the server error message and returns exit code 1 on 401", async () => {
    await writeFile(
      join(work, "protoloom.json"),
      JSON.stringify({ url: baseUrl, repositories: ["main"], dependencies: ["com.acme:a:1.0.0"] }),
    );
    const { io, err } = capture();
    const code = await run(
      ["fetch", "--config", join(work, "protoloom.json"), "--out", join(work, "out")],
      { PROTOLOOM_TOKEN: "bad" },
      io,
      work,
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("Invalid API key");
    expect(err.join("")).not.toMatch(/\n\s+at /);
  });

  it("lets PROTOLOOM_URL override the config url and fetches successfully", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")] });
    await writeFile(
      join(work, "protoloom.json"),
      JSON.stringify({ url: "http://127.0.0.1:1", repositories: ["main"], dependencies: ["com.acme:a:1.0.0"] }),
    );
    const { io } = capture();
    const code = await run(
      ["fetch", "--config", join(work, "protoloom.json"), "--out", join(work, "out")],
      { PROTOLOOM_URL: baseUrl },
      io,
      work,
    );
    expect(code).toBe(0);
    expect(await tree(join(work, "out"))).toEqual(["a.proto"]);
  });

  it("fails when neither the config nor PROTOLOOM_URL provides a url", async () => {
    await writeFile(join(work, "protoloom.json"), JSON.stringify({ repositories: [], dependencies: [] }));
    const { io, err } = capture();
    const code = await run(["fetch", "--config", join(work, "protoloom.json")], {}, io, work);
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/PROTOLOOM_URL/);
  });

  it("lists fetch in --help", async () => {
    const out: string[] = [];
    const code = await run(["--help"], {}, { out: (s) => out.push(s), err: () => undefined }, work);
    expect(code).toBe(0);
    expect(out.join("")).toContain("fetch");
  });
});
