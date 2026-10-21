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
});
