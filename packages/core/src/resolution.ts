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
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const MAX_ITERATIONS = 10_000;

function addRequest(requests: Map<string, Set<string>>, c: Coordinate): void {
  let versions = requests.get(keyOf(c));
  if (!versions) requests.set(keyOf(c), (versions = new Set()));
  versions.add(c.version);
}

function highest(requests: Map<string, Set<string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, versions] of requests) {
    out.set(key, [...versions].sort(compareVersions).at(-1) as string);
  }
  return out;
}

/**
 * Resolves the transitive dependency closure of `roots`, selecting the highest
 * version of every `group:name` requested by the live graph (the roots plus the
 * dependencies of live nodes). Requests from superseded versions are ignored, so
 * the result does not depend on declaration order. Iterates to a fixpoint; each
 * exact coordinate is looked up at most once and cycles terminate. Throws
 * `RegistryError("not_found")` with `details.path` (root to missing coordinate)
 * when a coordinate of the live closure does not exist.
 */
export async function resolveGraph(roots: Coordinate[], lookup: Lookup): Promise<Resolution> {
  const cache = new Map<string, ResolvedNode | null>();

  let requested = new Map<string, Set<string>>();
  for (const root of roots) addRequest(requested, root);
  let selected = highest(requested);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Walk the live closure under the current selection.
    const live = new Map<string, ResolvedNode>();
    const parents = new Map<string, string | null>();
    const seen = new Set<string>();
    const queue: Coordinate[] = [];
    const missing: { id: string; path: string[] }[] = [];
    const reach = (key: string, parent: string | null): void => {
      if (seen.has(key)) return;
      seen.add(key);
      const sep = key.lastIndexOf(":");
      const c = { group: key.slice(0, sep), name: key.slice(sep + 1), version: selected.get(key) as string };
      parents.set(formatCoordinate(c), parent);
      queue.push(c);
    };
    for (const root of roots) reach(keyOf(root), null);
    for (let c = queue.shift(); c; c = queue.shift()) {
      const id = formatCoordinate(c);
      let node = cache.get(id);
      if (node === undefined) {
        node = await lookup(c);
        cache.set(id, node);
      }
      if (!node) {
        // Only an error if this coordinate is still live once the selection is stable.
        const path: string[] = [];
        for (let cur: string | null | undefined = id; cur; cur = parents.get(cur)) path.unshift(cur);
        missing.push({ id, path });
        continue;
      }
      live.set(keyOf(c), node);
      for (const dep of node.dependencies) {
        if (selected.has(keyOf(dep))) reach(keyOf(dep), id); // new keys are picked up after the recompute
      }
    }

    // Recompute requests from the roots and live nodes only.
    requested = new Map();
    for (const root of roots) addRequest(requested, root);
    for (const node of live.values()) for (const dep of node.dependencies) addRequest(requested, dep);
    const next = highest(requested);

    const stable = next.size === selected.size && [...next].every(([k, v]) => selected.get(k) === v);
    if (stable) {
      const first = missing.sort((a, b) => byString(a.id, b.id))[0];
      if (first) {
        throw new RegistryError("not_found", `Dependency ${first.id} was not found`, { path: first.path });
      }
      const conflicts: Conflict[] = [];
      for (const [key, versions] of requested) {
        if (versions.size < 2) continue;
        const { group, name } = (live.get(key) as ResolvedNode).coordinate;
        conflicts.push({
          group,
          name,
          requested: [...versions].sort(compareVersions),
          selected: selected.get(key) as string,
        });
      }
      return {
        nodes: [...live.entries()].sort(([a], [b]) => byString(a, b)).map(([, n]) => n),
        conflicts: conflicts.sort((a, b) => byString(`${a.group}:${a.name}`, `${b.group}:${b.name}`)),
      };
    }
    selected = next;
  }
  throw new RegistryError("invalid_request", "Dependency resolution did not converge");
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
    .sort((a, b) => byString(a.path, b.path));
}
