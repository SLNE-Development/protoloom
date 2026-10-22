import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test/harness.js";
import { startFakeRegistry, type FakeRegistry } from "./test/fake-registry.js";
import { makeTarball, publishBody } from "./test/fixtures.js";
import type { SearchResult } from "./search.js";
import { NO_ADVISORIES_QUICK } from "./security.js";

let h: Harness;
let fake: FakeRegistry;
let second: FakeRegistry;
let gzip: FakeRegistry;
let down: FakeRegistry;

/** Publishes `name@1.0.0` to `repo` with a description and keywords. */
async function publish(repo: string, name: string, description: string, keywords: string[]): Promise<void> {
  const body = publishBody(name, "1.0.0", await makeTarball(name, "1.0.0")) as Record<string, unknown> & {
    versions: Record<string, Record<string, unknown>>;
  };
  body["description"] = description;
  body.versions["1.0.0"]!["description"] = description;
  body.versions["1.0.0"]!["keywords"] = keywords;
  const res = await h.call("PUT", `${repo}/${name.replace("/", "%2f")}`, { token: h.tokens.writer, json: body });
  expect(res.status).toBe(201);
}

/** The package names of a search answer, in order. */
async function names(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as SearchResult).objects.map((o) => o.package.name);
}

const AUDIT_BODY = JSON.stringify({ "left-pad": ["1.3.0"], react: ["18.0.0"] });

beforeAll(async () => {
  h = await createHarness();
  fake = await startFakeRegistry([
    { name: "react", versions: ["18.0.0"] },
    { name: "react-dom", versions: ["18.0.0"] },
    { name: "left-pad", versions: ["1.3.0"] },
  ]);
  second = await startFakeRegistry([{ name: "react", versions: ["18.0.0"] }]);
  gzip = await startFakeRegistry([{ name: "react", versions: ["18.0.0"] }], { gzip: true });
  down = await startFakeRegistry([]);
  down.setOffline(true);

  await h.createRepo({ name: "npm-hosted", format: "npm", kind: "hosted", visibility: "public" });
  await h.createRepo({ name: "npm-private", format: "npm", kind: "hosted", visibility: "private" });
  const mirror = (name: string, url: string, config?: unknown) =>
    h.createRepo({ name, format: "npm", kind: "mirror", visibility: "public", upstreams: [{ url, authType: "none" }], config });
  await mirror("npm-mirror", fake.url);
  await mirror("npm-second", second.url);
  await mirror("npm-gzip", gzip.url);
  await mirror("npm-down", down.url);
  await mirror("npm-offline", fake.url, { offline: true });
  await h.createRepo({ name: "npm-group", format: "npm", kind: "group", visibility: "public", members: ["npm-hosted", "npm-mirror", "npm-second"] });
  await h.createRepo({ name: "npm-group-hosted", format: "npm", kind: "group", visibility: "public", members: ["npm-hosted"] });
  await h.createRepo({ name: "npm-group-down", format: "npm", kind: "group", visibility: "public", members: ["npm-hosted", "npm-down"] });

  await publish("npm-hosted", "react", "the real thing", ["ui"]);
  await publish("npm-hosted", "alpha", "helpers for React apps", []);
  await publish("npm-hosted", "@acme/widgets", "widgets", ["react", "ui"]);
  await publish("npm-hosted", "zeta-react", "z", []);
  await publish("npm-hosted", "unrelated", "nothing to see", ["misc"]);
  await publish("npm-private", "secret-react", "private", []);
}, 180_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
  await second?.close();
  await gzip?.close();
  await down?.close();
});

describe("npm search", () => {
  it("hosted search finds by name, description and keyword", async () => {
    const res = await h.call("GET", "npm-hosted/-/v1/search?text=react");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as SearchResult;
    expect(body.objects.map((o) => o.package.name).sort()).toEqual(["@acme/widgets", "alpha", "react", "zeta-react"]);
    expect(body.total).toBe(4);
    expect(typeof body.time).toBe("string");
    const react = body.objects.find((o) => o.package.name === "react")!;
    expect(react.package).toMatchObject({ name: "react", version: "1.0.0", description: "the real thing", keywords: ["ui"] });
    expect(react.package.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(react.score).toEqual({ final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } });
    expect(react.searchScore).toBe(1);
  });

  it("exact name ranks first", async () => {
    expect(await names(await h.call("GET", "npm-hosted/-/v1/search?text=react"))).toEqual(["react", "@acme/widgets", "alpha", "zeta-react"]);
  });

  it("pages with size and from", async () => {
    const res = await h.call("GET", "npm-hosted/-/v1/search?text=react&size=2&from=1");
    const body = (await res.json()) as SearchResult;
    expect(body.objects.map((o) => o.package.name)).toEqual(["@acme/widgets", "alpha"]);
    expect(body.total).toBe(4);
    expect(await names(await h.call("GET", "npm-hosted/-/v1/search?text=react&size=abc&from=-3"))).toHaveLength(4);
  });

  it("needs read access", async () => {
    expect((await h.call("GET", "npm-private/-/v1/search?text=react")).status).toBe(401);
    expect(await names(await h.call("GET", "npm-private/-/v1/search?text=react", { token: h.tokens.reader }))).toEqual(["secret-react"]);
  });

  it("answers GET and HEAD only", async () => {
    const res = await h.call("POST", "npm-hosted/-/v1/search?text=react", { body: "{}" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("mirror search is forwarded with the query string", async () => {
    const res = await h.call("GET", "npm-mirror/-/v1/search?text=react&size=5", { token: h.tokens.reader });
    expect(await names(res)).toEqual(["react", "react-dom"]);
    expect(fake.hits).toContain("/-/v1/search?text=react&size=5");
    const forwarded = fake.requests.find((r) => r.url === "/-/v1/search?text=react&size=5")!;
    expect(forwarded.headers.authorization).toBeUndefined();
  });

  it("an offline mirror answers an empty search", async () => {
    const res = await h.call("GET", "npm-offline/-/v1/search?text=react");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ objects: [], total: 0 });
  });

  it("group search lists hosted results before upstream and dedups", async () => {
    const before = second.hits.length;
    const res = await h.call("GET", "npm-group/-/v1/search?text=react");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResult;
    expect(body.objects.map((o) => o.package.name)).toEqual(["react", "@acme/widgets", "alpha", "zeta-react", "react-dom"]);
    expect(body.objects[0]!.package.description).toBe("the real thing");
    expect(body.total).toBe(4 + 2);
    expect(second.hits.length).toBe(before);
  });

  it("group search keeps hosted results when the mirror member is down", async () => {
    expect(await names(await h.call("GET", "npm-group-down/-/v1/search?text=react"))).toEqual(["react", "@acme/widgets", "alpha", "zeta-react"]);
  });

  it("gzip upstream is passed through decoded", async () => {
    const res = await h.call("GET", "npm-gzip/-/v1/search?text=react", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await names(res)).toEqual(["react"]);
    const audit = await h.call("POST", "npm-gzip/-/npm/v1/security/advisories/bulk", {
      body: AUDIT_BODY,
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
    });
    expect(audit.status).toBe(200);
    expect(audit.headers.get("content-encoding")).toBeNull();
    expect(await audit.json()).toEqual({});
  });
});

describe("npm audit", () => {
  it("hosted bulk advisory answers {}", async () => {
    const res = await h.call("POST", "npm-hosted/-/npm/v1/security/advisories/bulk", { body: AUDIT_BODY, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("hosted audits answer no advisories", async () => {
    for (const path of ["audits", "audits/quick"]) {
      const res = await h.call("POST", `npm-hosted/-/npm/v1/security/${path}`, { body: "{}", headers: { "content-type": "application/json" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(NO_ADVISORIES_QUICK);
    }
    expect((await h.call("POST", "npm-hosted/-/npm/v1/security/other", { body: "{}" })).status).toBe(404);
    const get = await h.call("GET", "npm-hosted/-/npm/v1/security/advisories/bulk");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("needs read access", async () => {
    expect((await h.call("POST", "npm-private/-/npm/v1/security/advisories/bulk", { body: "{}" })).status).toBe(401);
    expect((await h.call("POST", "npm-private/-/npm/v1/security/advisories/bulk", { body: "{}", token: h.tokens.reader })).status).toBe(200);
  });

  it("mirror bulk advisory forwards the gzip body unchanged", async () => {
    const gz = gzipSync(Buffer.from(AUDIT_BODY));
    const res = await h.call("POST", "npm-mirror/-/npm/v1/security/advisories/bulk", {
      body: gz,
      token: h.tokens.reader,
      headers: { "content-type": "application/json", "content-encoding": "gzip", "x-forwarded-for": "10.0.0.1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const forwarded = fake.requests.filter((r) => r.url === "/-/npm/v1/security/advisories/bulk").at(-1)!;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers["content-encoding"]).toBe("gzip");
    expect(forwarded.headers["content-type"]).toBe("application/json");
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(forwarded.headers["x-forwarded-for"]).toBeUndefined();
    expect(forwarded.body.equals(gz)).toBe(true);
  });

  it("group audit goes to the first mirror member", async () => {
    const before = { fake: fake.hits.length, second: second.hits.length };
    const res = await h.call("POST", "npm-group/-/npm/v1/security/audits/quick", { body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(fake.hits.slice(before.fake)).toEqual(["/-/npm/v1/security/audits/quick"]);
    expect(second.hits.length).toBe(before.second);
  });

  it("a group without a mirror member and an offline mirror give the hosted answer", async () => {
    for (const repo of ["npm-group-hosted", "npm-offline"]) {
      const res = await h.call("POST", `${repo}/-/npm/v1/security/audits/quick`, { body: "{}", headers: { "content-type": "application/json" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(NO_ADVISORIES_QUICK);
    }
  });

  it("an unreachable mirror is a 502, not a silent all-clear", async () => {
    const res = await h.call("POST", "npm-down/-/npm/v1/security/advisories/bulk", { body: AUDIT_BODY });
    expect(res.status).toBe(502);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});
