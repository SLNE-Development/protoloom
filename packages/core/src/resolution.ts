import { compareVersions, formatCoordinate, type Coordinate } from "./coordinates.js";
import { RegistryError } from "./errors.js";

/** A published artifact version together with its direct dependencies. */
export interface ResolvedNode {
  coordinate: Coordinate;
  repository: string;
  buildNumber: number;
  sha256: string;
  dependencies: Coordinate[];
}

/** Looks up one exact coordinate; resolves to null when it does not exist. */
export type Lookup = (c: Coordinate) => Promise<ResolvedNode | null>;

/** An artifact requested at several versions; `selected` is the highest. */
export interface Conflict {
  group: string;
  name: string;
  requested: string[];
  selected: string;
}

/** Final dependency closure (sorted by `group:name`) and the version conflicts met on the way. */
export interface Resolution {
  nodes: ResolvedNode[];
  conflicts: Conflict[];
}

const keyOf = (c: Coordinate): string => `${c.group}:${c.name}`;

/**
 * Resolves the transitive dependency closure of `roots`, selecting the highest
 * requested version of every `group:name`. Each exact coordinate is looked up at
 * most once; cycles terminate. Throws `RegistryError("not_found")` with
 * `details.path` (root to missing coordinate) when a dependency does not exist.
 */
export async function resolveGraph(roots: Coordinate[], lookup: Lookup): Promise<Resolution> {
  const selected = new Map<string, string>();
  const requested = new Map<string, Set<string>>();
  const parents = new Map<string, string | null>();
  const nodes = new Map<string, ResolvedNode>();
  const worklist: Coordinate[] = [];

  const request = (c: Coordinate, parent: string | null): void => {
    const key = keyOf(c);
    let versions = requested.get(key);
    if (!versions) requested.set(key, (versions = new Set()));
    versions.add(c.version);
    const current = selected.get(key);
    if (current === undefined || compareVersions(c.version, current) > 0) {
      selected.set(key, c.version);
      parents.set(formatCoordinate(c), parent);
      worklist.push(c);
    }
  };

  const pathTo = (c: Coordinate): string[] => {
    const path: string[] = [];
    let cur: string | null | undefined = formatCoordinate(c);
    while (cur) {
      path.unshift(cur);
      cur = parents.get(cur);
    }
    return path;
  };

  for (const root of roots) request(root, null);

  for (let c = worklist.shift(); c; c = worklist.shift()) {
    if (selected.get(keyOf(c)) !== c.version) continue; // superseded by a higher version
    const id = formatCoordinate(c);
    if (nodes.has(id)) continue;
    const node = await lookup(c);
    if (!node) {
      throw new RegistryError("not_found", `Dependency ${id} was not found`, { path: pathTo(c) });
    }
    nodes.set(id, node);
    for (const dep of node.dependencies) request(dep, id);
  }

  // Walk again following only selected versions, so deps of superseded versions drop out.
  const final = new Map<string, ResolvedNode>();
  const stack = roots.map(keyOf);
  while (stack.length > 0) {
    const key = stack.pop() as string;
    if (final.has(key)) continue;
    const version = selected.get(key) as string;
    const [group, name] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
    const node = nodes.get(formatCoordinate({ group, name, version })) as ResolvedNode;
    final.set(key, node);
    for (const dep of node.dependencies) stack.push(keyOf(dep));
  }

  const conflicts: Conflict[] = [];
  for (const [key, versions] of requested) {
    if (versions.size < 2 || !final.has(key)) continue;
    const node = final.get(key) as ResolvedNode;
    conflicts.push({
      group: node.coordinate.group,
      name: node.coordinate.name,
      requested: [...versions].sort(compareVersions),
      selected: selected.get(key) as string,
    });
  }

  const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    nodes: [...final.entries()].sort(([a], [b]) => byKey(a, b)).map(([, n]) => n),
    conflicts: conflicts.sort((a, b) => byKey(`${a.group}:${a.name}`, `${b.group}:${b.name}`)),
  };
}

/** Finds file paths claimed by more than one coordinate. */
export function findPathCollisions(
  entries: { coordinate: Coordinate; paths: string[] }[],
): { path: string; coordinates: string[] }[] {
  const claims = new Map<string, Set<string>>();
  for (const { coordinate, paths } of entries) {
    const id = formatCoordinate(coordinate);
    for (const path of paths) {
      let owners = claims.get(path);
      if (!owners) claims.set(path, (owners = new Set()));
      owners.add(id);
    }
  }
  return [...claims.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([path, owners]) => ({ path, coordinates: [...owners].sort() }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
