import { describe, expect, it } from "vitest";
import { validateProtos } from "./validation.js";

const header = 'syntax = "proto3";\n';

describe("validateProtos", () => {
  it("accepts a valid file importing a well-known type", async () => {
    const issues = await validateProtos({
      files: [
        {
          path: "a/v1/a.proto",
          content: `${header}package a.v1;\nimport "google/protobuf/timestamp.proto";\nmessage A { google.protobuf.Timestamp t = 1; }\n`,
        },
      ],
      dependencyFiles: [],
    });
    expect(issues).toEqual([]);
  });

  it("reports a syntax error with path and line", async () => {
    const issues = await validateProtos({
      files: [{ path: "a/v1/a.proto", content: `${header}package a.v1;\nmessage A { string = 1; }\n` }],
      dependencyFiles: [],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("a/v1/a.proto");
    expect(issues[0]?.line).toBeDefined();
  });

  const a = {
    path: "a/v1/a.proto",
    content: `${header}package a.v1;\nimport "b/v1/b.proto";\nmessage A { b.v1.B b = 1; }\n`,
  };
  const b = { path: "b/v1/b.proto", content: `${header}package b.v1;\nmessage B {}\n` };

  it("reports a missing import", async () => {
    const issues = await validateProtos({ files: [a], dependencyFiles: [] });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe("a/v1/a.proto");
    expect(issues[0]?.message).toContain("b/v1/b.proto");
  });

  it("resolves an import from dependencyFiles", async () => {
    expect(await validateProtos({ files: [a], dependencyFiles: [b] })).toEqual([]);
  });

  it("resolves transitive dependencies", async () => {
    const bt = {
      path: "b/v1/b.proto",
      content: `${header}package b.v1;\nimport "c/v1/c.proto";\nmessage B { c.v1.C c = 1; }\n`,
    };
    const c = { path: "c/v1/c.proto", content: `${header}package c.v1;\nmessage C {}\n` };
    expect(await validateProtos({ files: [a], dependencyFiles: [bt, c] })).toEqual([]);
  });

  it("reports a path present in both files and dependencyFiles", async () => {
    const issues = await validateProtos({ files: [b], dependencyFiles: [b] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("b/v1/b.proto");
    expect(issues[0]?.message).toMatch(/duplicate/i);
  });

  it("validates 1000 files without exceeding the command line limit", async () => {
    const files = Array.from({ length: 1000 }, (_, i) => ({
      path: `many/v1/f${i}.proto`,
      content: `${header}package many.v1;\nmessage M${i} {}\n`,
    }));
    expect(await validateProtos({ files, dependencyFiles: [] })).toEqual([]);
  }, 60_000);

  it.each([
    ["files", "google/protobuf/timestamp.proto"],
    ["dependencyFiles", "google/protobuf/timestamp.proto"],
    ["files", "Google/Protobuf/x.proto"],
  ] as const)(
    "rejects a well-known type path in %s (%s)",
    async (key, path) => {
      const shadow = { path, content: `${header}message T {}\n` };
      const input = { files: [a], dependencyFiles: [b] };
      input[key] = [...input[key], shadow];
      const issues = await validateProtos(input);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe(shadow.path);
      expect(issues[0]?.message).toMatch(/reserved for protobuf well-known types/);
    },
  );

  it.each(["../../escaped.proto", "/abs/x.proto", "a\\b.proto", "a/../b.proto"])(
    "rejects the unsafe path %s",
    async (path) => {
      const issues = await validateProtos({
        files: [{ path, content: `${header}message X {}\n` }],
        dependencyFiles: [],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe(path);
      expect(issues[0]?.message).toMatch(/invalid path/i);
    },
  );

  it("maps issues in dependency files to their real path", async () => {
    const broken = { path: "b/v1/b.proto", content: `${header}package b.v1;\nmessage B { string = 1; }\n` };
    const issues = await validateProtos({ files: [a], dependencyFiles: [broken] });
    expect(issues.length).toBeGreaterThan(0);
    const issue = issues.find((i) => i.path === "b/v1/b.proto");
    expect(issue?.message).toMatch(/^in dependency: /);
    expect(issue?.line).toBeDefined();
  });
});
