import { describe, expect, it } from "vitest";
import { RegistryError } from "./errors.js";
import { formatCoordinate, type Coordinate } from "./coordinates.js";
import { findPathCollisions, resolveGraph, type Lookup, type ResolvedNode } from "./resolution.js";

const c = (name: string, version: string): Coordinate => ({ group: "g", name, version });

function memoryLookup(graph: Record<string, string[]>, calls: string[] = []): Lookup {
  return async (coord) => {
    const key = formatCoordinate(coord);
    calls.push(key);
    const deps = graph[key];
    if (!deps) return null;
    const node: ResolvedNode = {
      coordinate: coord,
      repository: "main",
      buildNumber: 1,
      sha256: "x".repeat(64),
      dependencies: deps.map((d) => {
        const [group, name, version] = d.split(":") as [string, string, string];
        return { group, name, version };
      }),
    };
    return node;
  };
}

describe("resolveGraph", () => {
  it("resolves a linear chain", async () => {
    const lookup = memoryLookup({ "g:a:1": ["g:b:1"], "g:b:1": ["g:c:1"], "g:c:1": [] });
    const r = await resolveGraph([c("a", "1")], lookup);
    expect(r.nodes.map((n) => formatCoordinate(n.coordinate))).toEqual(["g:a:1", "g:b:1", "g:c:1"]);
    expect(r.conflicts).toEqual([]);
  });

  it("selects the highest version in a diamond and drops stale deps", async () => {
    const calls: string[] = [];
    const lookup = memoryLookup(
      {
        "g:a:1": ["g:b:1.0", "g:c:1"],
        "g:b:1.0": ["g:old:1"],
        "g:b:2.0": [],
        "g:c:1": ["g:b:2.0"],
        "g:old:1": [],
      },
      calls,
    );
    const r = await resolveGraph([c("a", "1")], lookup);
    expect(r.nodes.map((n) => formatCoordinate(n.coordinate))).toEqual(["g:a:1", "g:b:2.0", "g:c:1"]);
    expect(r.conflicts).toEqual([{ group: "g", name: "b", requested: ["1.0", "2.0"], selected: "2.0" }]);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("terminates on cycles", async () => {
    const lookup = memoryLookup({ "g:a:1": ["g:b:1"], "g:b:1": ["g:a:1"] });
    const r = await resolveGraph([c("a", "1")], lookup);
    expect(r.nodes).toHaveLength(2);
  });

  it("throws not_found with the dependency path for a missing dep", async () => {
    const lookup = memoryLookup({ "g:a:1": ["g:missing:1"] });
    const err = await resolveGraph([c("a", "1")], lookup).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).code).toBe("not_found");
    expect((err as RegistryError).details).toMatchObject({ path: ["g:a:1", "g:missing:1"] });
  });

  it("selects the highest version when roots request two versions", async () => {
    const lookup = memoryLookup({ "g:a:1": [], "g:a:2": [] });
    const r = await resolveGraph([c("a", "1"), c("a", "2")], lookup);
    expect(r.nodes.map((n) => formatCoordinate(n.coordinate))).toEqual(["g:a:2"]);
    expect(r.conflicts).toEqual([{ group: "g", name: "a", requested: ["1", "2"], selected: "2" }]);
  });
});

describe("findPathCollisions", () => {
  it("reports a path claimed by two coordinates", () => {
    const result = findPathCollisions([
      { coordinate: c("a", "1"), paths: ["x/y.proto", "a.proto"] },
      { coordinate: c("b", "1"), paths: ["x/y.proto"] },
    ]);
    expect(result).toEqual([{ path: "x/y.proto", coordinates: ["g:a:1", "g:b:1"] }]);
  });

  it("reports nothing without overlap", () => {
    expect(
      findPathCollisions([
        { coordinate: c("a", "1"), paths: ["a.proto"] },
        { coordinate: c("b", "1"), paths: ["b.proto"] },
      ]),
    ).toEqual([]);
  });
});
