import { describe, expect, it } from "vitest";
import { FORMATS, KINDS, defaultRepositoryConfig } from "@weaver/core";
import {
  EMPTY_UPSTREAM,
  FORMAT_OPTIONS,
  KIND_OPTIONS,
  NEW_REPOSITORY_DEFAULTS,
  createRepositorySchema,
  parsePatterns,
  protoHostedSchema,
  supportsGroupPrefix,
  toCreateRepositoryInput,
  toGeneralPatch,
  toMirrorFormValues,
  toMirrorPatch,
} from "./repository-settings";

describe("format and kind options", () => {
  it("match the formats and kinds of @weaver/core", () => {
    expect(FORMAT_OPTIONS.map((o) => o.value)).toEqual(FORMATS);
    expect(KIND_OPTIONS.map((o) => o.value)).toEqual(KINDS);
  });
});

describe("createRepositorySchema", () => {
  const valid = { ...NEW_REPOSITORY_DEFAULTS, name: "team-private" };

  it("accepts a hosted repository with a valid name and rejects bad names", () => {
    expect(createRepositorySchema.safeParse(valid).success).toBe(true);
    for (const name of ["", "Team", "-x", "a_b", "a".repeat(64)]) {
      expect(createRepositorySchema.safeParse({ ...valid, name }).success, name).toBe(false);
    }
  });

  it("needs an http(s) upstream URL for a mirror and keeps library free for Docker Hub", () => {
    expect(createRepositorySchema.safeParse({ ...valid, kind: "mirror" }).success).toBe(false);
    expect(createRepositorySchema.safeParse({ ...valid, kind: "mirror", upstreamUrl: "ftp://x" }).success).toBe(false);
    expect(createRepositorySchema.safeParse({ ...valid, kind: "mirror", upstreamUrl: "https://registry.npmjs.org" }).success).toBe(true);
    expect(createRepositorySchema.safeParse({ ...valid, format: "docker", name: "library" }).success).toBe(false);
  });

  it("sends only the fields of the chosen kind", () => {
    expect(toCreateRepositoryInput({ ...valid, name: " main ", upstreamUrl: "https://x", members: ["a"] })).toEqual({
      name: "main",
      format: "maven",
      kind: "hosted",
    });
    expect(toCreateRepositoryInput({ ...valid, kind: "mirror", upstreamUrl: " https://x " })).toMatchObject({
      upstreams: [{ url: "https://x", authType: "none" }],
    });
    expect(toCreateRepositoryInput({ ...valid, kind: "group", members: ["a", "b"] })).toMatchObject({ members: ["a", "b"] });
  });
});

describe("settings", () => {
  it("stores an empty description as null", () => {
    expect(toGeneralPatch({ description: "  ", visibility: "public" })).toEqual({ description: null, visibility: "public" });
  });

  it("rejects bad resolution priorities", () => {
    const base = { allowRedeploy: false, allowReleases: true, allowSnapshots: true };
    for (const resolutionPriority of [-1, 1.5, Number.NaN, 100_001]) {
      expect(protoHostedSchema.safeParse({ ...base, resolutionPriority }).success, String(resolutionPriority)).toBe(false);
    }
  });

  it("round-trips a mirror's config, omitting empty secrets and Docker options outside Docker", () => {
    const config = defaultRepositoryConfig("npm", "mirror");
    const values = toMirrorFormValues({ config, dockerRoot: false }, [
      { id: "u1", url: "https://registry.npmjs.org", authType: "bearer", username: null, hasSecret: true },
    ]);
    expect(values).toMatchObject({ cacheEnabled: false, cacheStore: "default", metadataTtlSeconds: 1800, maxAgeDays: null, maxSizeGib: null });
    const patch = toMirrorPatch({ ...values, allow: "@acme/*\n\n  left-pad ", maxSizeGib: 1.5 }, "npm");
    expect(patch.upstreams).toEqual([{ url: "https://registry.npmjs.org", authType: "bearer", username: null }]);
    expect(patch.config).toEqual({
      cache: { enabled: false, store: null, metadataTtlSeconds: 1800, maxAgeDays: null, maxSizeBytes: 1.5 * 1024 ** 3 },
      offline: false,
      rules: { allow: ["@acme/*", "left-pad"], deny: [] },
    });
    expect(patch).not.toHaveProperty("dockerRoot");
    const docker = toMirrorPatch({ ...values, upstreams: [{ ...EMPTY_UPSTREAM, url: "https://x", secret: "t" }], dockerHub: true }, "docker");
    expect(docker).toMatchObject({ dockerRoot: false, config: { dockerHub: true }, upstreams: [{ url: "https://x", authType: "none" }] });
  });

  it("splits patterns by line", () => {
    expect(parsePatterns(" a \r\nb\n\n")).toEqual(["a", "b"]);
  });

  it("allows group prefixes on proto hosted and mirror repositories only", () => {
    expect(supportsGroupPrefix({ format: "proto", kind: "hosted" })).toBe(true);
    expect(supportsGroupPrefix({ format: "proto", kind: "mirror" })).toBe(true);
    expect(supportsGroupPrefix({ format: "proto", kind: "group" })).toBe(false);
    expect(supportsGroupPrefix({ format: "maven", kind: "hosted" })).toBe(false);
  });
});
