import { describe, expect, it, vi } from "vitest";
import type { FormatFactory } from "@weaver/core";
import config from "../../next.config";
import { config as proxyConfig } from "../proxy";
import { FACTORIES, getFormatHandler, mountRest } from "./formats";

// A server context without a database: every repository lookup misses.
vi.mock("./context", () => ({
  getServerContext: () => ({
    db: {},
    stores: { primary: { id: "local" }, configured: () => ["local"] },
    repos: { get: async () => null },
    assets: {},
    mirror: {},
    secretKey: Buffer.alloc(32, 1),
  }),
}));

const req = (path: string) => new Request(`http://localhost:3000${path}`);

describe("mountRest", () => {
  it("extracts the raw path", () => {
    expect(mountRest(req("/npm/repo/@scope%2fpkg"), "npm")).toBe("repo/@scope%2fpkg");
  });
  it("maps /v2/ and /v2 to the empty string", () => {
    expect(mountRest(req("/v2/"), "docker")).toBe("");
    expect(mountRest(req("/v2"), "docker")).toBe("");
  });
  it("keeps a trailing slash", () => {
    expect(mountRest(req("/maven/r/a/"), "maven")).toBe("r/a/");
  });
});

describe("placeholder mounts", () => {
  it("answers 501 not_implemented", async () => {
    const res = await getFormatHandler("maven")(req("/maven/x"), "x");
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: { code: "not_implemented", message: "maven support is not installed" } });
  });
});

describe("npm mount", () => {
  it("builds the real npm handler from deps carrying the secret key; a missing repo answers 404 JSON", async () => {
    let seen: Buffer | undefined;
    const original = FACTORIES.npm!;
    const factory: FormatFactory = (deps) => {
      seen = deps.secretKey;
      return original(deps);
    };
    FACTORIES.npm = factory;
    let handler;
    try {
      handler = getFormatHandler("npm");
    } finally {
      FACTORIES.npm = original;
    }
    expect(seen?.length).toBe(32);
    const res = await handler(req("/npm/x/-/ping"), "x/-/ping");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("routing config", () => {
  it("skips the trailing-slash redirect", () => {
    expect(config.skipTrailingSlashRedirect).toBe(true);
  });
  it("keeps the proxy off the protocol mounts", () => {
    const re = new RegExp(`^${proxyConfig.matcher[0]!}$`);
    for (const p of ["/v2/x", "/v2/", "/v2", "/maven/x", "/npm/x"]) expect(re.test(p)).toBe(false);
    expect(re.test("/repositories")).toBe(true);
  });
});
