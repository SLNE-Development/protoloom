import { describe, expect, it, vi } from "vitest";
import type { FormatFactory } from "@weaver/core";
import config from "../../next.config";
import { config as proxyConfig } from "../proxy";
import { FACTORIES, getFormatHandler, mountRest } from "./formats";

vi.mock("./context", () => ({
  getServerContext: () => ({ secretKey: Buffer.alloc(32, 1), stores: {}, db: {}, repos: {}, assets: {}, mirror: {} }),
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

describe("format deps", () => {
  it("carry the secret key", () => {
    let seen: Buffer | undefined;
    const factory: FormatFactory = (deps) => {
      seen = deps.secretKey;
      return async () => new Response(null, { status: 204 });
    };
    FACTORIES.npm = factory;
    try {
      getFormatHandler("npm");
    } finally {
      FACTORIES.npm = undefined;
    }
    expect(seen?.length).toBe(32);
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
