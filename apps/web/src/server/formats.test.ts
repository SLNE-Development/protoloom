import { describe, expect, it } from "vitest";
import config from "../../next.config";
import { config as proxyConfig } from "../proxy";
import { getFormatHandler, mountRest } from "./formats";

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
