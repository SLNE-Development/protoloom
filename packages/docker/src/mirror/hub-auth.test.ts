import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UpstreamView } from "@weaver/core";
import { createHubAuth, parseChallenge } from "./hub-auth.js";

type Upstream = UpstreamView & { secret: string | null };

const anonymous: Upstream = { id: "up-anon", url: "http://registry", authType: "none", username: null, hasSecret: false, secret: null };
const withCredentials: Upstream = {
  id: "up-basic",
  url: "http://registry",
  authType: "basic",
  username: "hubuser",
  hasSecret: true,
  secret: "hub-access-token",
};

describe("hub auth", () => {
  let realm: Server;
  let realmUrl: string;
  let requests: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  let status = 200;

  beforeAll(async () => {
    realm = createServer((req, res) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: `tok-${requests.length}`, expires_in: 300, issued_at: new Date().toISOString() }));
    });
    await new Promise<void>((resolve) => realm.listen(0, "127.0.0.1", resolve));
    realmUrl = `http://127.0.0.1:${(realm.address() as AddressInfo).port}/token`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => realm.close(() => resolve()));
  });
  beforeEach(() => {
    requests = [];
    status = 200;
  });

  const challengeFor = (scope: string) => `Bearer realm="${realmUrl}",service="registry.docker.io",scope="${scope}"`;

  it("parses a Docker Hub challenge", () => {
    expect(
      parseChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"'),
    ).toEqual({ realm: "https://auth.docker.io/token", service: "registry.docker.io", scope: "repository:library/nginx:pull" });
    expect(parseChallenge('bearer realm="https://ghcr.io/token"')).toEqual({ realm: "https://ghcr.io/token" });
    expect(parseChallenge('Basic realm="registry"')).toBeNull();
    expect(parseChallenge("Bearer service=x")).toBeNull();
  });

  it("fetches a token with basic upstream credentials and caches it until expires_in - 30 s", async () => {
    let clock = new Date("2026-10-22T10:00:00Z");
    const hub = createHubAuth(fetch, () => clock);
    const scope = "repository:library/nginx:pull";
    expect(await hub.authorize(withCredentials, scope)).toBeNull();

    expect(await hub.onChallenge(challengeFor(scope), withCredentials)).toBe("Bearer tok-1");
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url, "http://x");
    expect(url.searchParams.get("service")).toBe("registry.docker.io");
    expect(url.searchParams.get("scope")).toBe(scope);
    expect(requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from("hubuser:hub-access-token").toString("base64")}`);

    clock = new Date(clock.getTime() + 269_000);
    expect(await hub.authorize(withCredentials, scope)).toBe("Bearer tok-1");
    expect(await hub.authorize(anonymous, scope)).toBeNull();
    expect(await hub.authorize(withCredentials, "repository:library/redis:pull")).toBeNull();
    clock = new Date(clock.getTime() + 1_000);
    expect(await hub.authorize(withCredentials, scope)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("anonymous token request sends no authorization", async () => {
    const hub = createHubAuth(fetch, () => new Date());
    expect(await hub.onChallenge(challengeFor("repository:library/nginx:pull"), anonymous)).toBe("Bearer tok-1");
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });

  it("token endpoint failure → null", async () => {
    const hub = createHubAuth(fetch, () => new Date());
    status = 401;
    expect(await hub.onChallenge(challengeFor("repository:library/nginx:pull"), withCredentials)).toBeNull();
    status = 500;
    expect(await hub.onChallenge(challengeFor("repository:library/nginx:pull"), anonymous)).toBeNull();
    expect(await hub.onChallenge('Bearer realm="http://127.0.0.1:1/token"', anonymous)).toBeNull();
    expect(await hub.onChallenge('Basic realm="x"', anonymous)).toBeNull();
    expect(await hub.authorize(anonymous, "repository:library/nginx:pull")).toBeNull();
  });
});
