import { describe, expect, it } from "vitest";
import { mirrorSubject, parseMavenPath } from "./path.js";

describe("parseMavenPath", () => {
  it("parses a release jar", () => {
    expect(parseMavenPath("releases/org/example/lib/1.2.0/lib-1.2.0.jar")).toEqual({
      repo: "releases",
      target: {
        type: "file",
        path: "org/example/lib/1.2.0/lib-1.2.0.jar",
        basePath: "org/example/lib/1.2.0/lib-1.2.0.jar",
        groupId: "org.example",
        artifactId: "lib",
        version: "1.2.0",
        snapshot: false,
        stamp: null,
        classifier: null,
        extension: "jar",
        checksum: null,
        signature: false,
      },
    });
  });

  it("parses classifier and compound extension", () => {
    const f = (n: string) => parseMavenPath(`r/org/example/lib/1.2.0/${n}`).target;
    expect(f("lib-1.2.0-sources.jar")).toMatchObject({ classifier: "sources", extension: "jar" });
    expect(f("lib-1.2.0.tar.gz")).toMatchObject({ classifier: null, extension: "tar.gz" });
    expect(f("lib-1.2.0.jar.asc")).toMatchObject({ extension: "jar.asc", signature: true });
  });

  it("parses a timestamped snapshot", () => {
    const t = parseMavenPath("r/org/example/lib/1.0-SNAPSHOT/lib-1.0-20261022.101010-3-sources.jar").target as Record<string, unknown>;
    expect(t).toMatchObject({
      type: "file",
      version: "1.0-SNAPSHOT",
      snapshot: true,
      stamp: { timestamp: "20261022.101010", buildNumber: 3 },
      classifier: "sources",
      extension: "jar",
    });
  });

  it("parses a plain SNAPSHOT file name", () => {
    const t = parseMavenPath("r/org/example/lib/1.0-SNAPSHOT/lib-1.0-SNAPSHOT.jar").target as Record<string, unknown>;
    expect(t).toMatchObject({ snapshot: true, stamp: null, classifier: null, extension: "jar" });
  });

  it("parses a checksum of a file", () => {
    const t = parseMavenPath("r/org/example/lib/1.2.0/lib-1.2.0.pom.sha256").target as Record<string, unknown>;
    expect(t["checksum"]).toBe("sha256");
    expect(String(t["basePath"]).endsWith("lib-1.2.0.pom")).toBe(true);
    expect(t["extension"]).toBe("pom");
  });

  it("parses metadata at artifact and snapshot level", () => {
    expect(parseMavenPath("r/org/example/lib/maven-metadata.xml.sha1").target).toMatchObject({
      type: "metadata",
      dir: "org/example/lib",
      checksum: "sha1",
    });
    expect(parseMavenPath("r/org/example/lib/1.0-SNAPSHOT/maven-metadata.xml").target).toMatchObject({
      type: "metadata",
      dir: "org/example/lib/1.0-SNAPSHOT",
      checksum: null,
    });
  });

  it("parses directories", () => {
    expect(parseMavenPath("releases/").target).toEqual({ type: "directory", path: "" });
    expect(parseMavenPath("releases/org/").target).toEqual({ type: "directory", path: "org/" });
    expect(parseMavenPath("releases")).toEqual({ repo: "releases", target: null });
  });

  it("parses other paths", () => {
    expect(parseMavenPath("releases/archetype-catalog.xml").target).toMatchObject({ type: "other" });
    expect(parseMavenPath("releases/org/x/1.0/README.txt").target).toMatchObject({ type: "other" });
  });

  it("decodes percent-encoded segments", () => {
    expect(parseMavenPath("r/org/a%2Bb/x").target).toMatchObject({ path: "org/a+b/x" });
  });

  it.each(["r/../x", "r/%2e%2e/x", "r/a%2Fb/c", "r/a\\b", "r//a", "r/a/%00", "r/./x"])(
    "rejects traversal and odd segments: %s",
    (raw) => {
      expect(() => parseMavenPath(raw)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    },
  );
});

describe("mirrorSubject", () => {
  it("maps targets to rule subjects", () => {
    const s = (p: string) => mirrorSubject(parseMavenPath(p).target!);
    expect(s("r/org/example/lib/1.2.0/lib-1.2.0.jar")).toBe("org.example:lib");
    expect(s("r/org/example/lib/maven-metadata.xml")).toBe("org.example:lib");
    expect(s("r/org/example/lib/1.0-SNAPSHOT/maven-metadata.xml")).toBe("org.example:lib");
    expect(s("r/archetype-catalog.xml")).toBe("archetype-catalog.xml");
    expect(s("r/org/example/")).toBe("org.example.");
  });
});
