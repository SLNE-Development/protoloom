import { RegistryError } from "./errors.js";

/** Maven-style artifact coordinate. */
export interface Coordinate {
  group: string;
  name: string;
  version: string;
}

const REPOSITORY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GROUP_RE = /^[a-z0-9_]+(\.[a-z0-9_-]+)*$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const VERSION_RE = /^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/;
const VERSION_MAX_LENGTH = 64;
const SNAPSHOT_SUFFIX = "-SNAPSHOT";

export function isValidRepositoryName(s: string): boolean {
  return REPOSITORY_RE.test(s);
}

export function isValidGroup(s: string): boolean {
  return GROUP_RE.test(s);
}

export function isValidName(s: string): boolean {
  return NAME_RE.test(s);
}

export function isValidVersion(s: string): boolean {
  return s.length <= VERSION_MAX_LENGTH && VERSION_RE.test(s);
}

/** Parses `group:name:version`; throws `invalid_request` when malformed. */
export function parseCoordinate(s: string): Coordinate {
  const parts = s.split(":");
  const [group, name, version] = parts;
  if (
    parts.length !== 3 ||
    group === undefined ||
    name === undefined ||
    version === undefined ||
    !isValidGroup(group) ||
    !isValidName(name) ||
    !isValidVersion(version)
  ) {
    throw new RegistryError("invalid_request", `Invalid coordinate "${s}", expected group:name:version`);
  }
  return { group, name, version };
}

export function formatCoordinate(c: Coordinate): string {
  return `${c.group}:${c.name}:${c.version}`;
}

export function isSnapshot(version: string): boolean {
  return version.endsWith(SNAPSHOT_SUFFIX);
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function splitVersion(v: string): { numbers: number[]; qualifier: string | undefined } {
  const dash = v.indexOf("-");
  const core = dash === -1 ? v : v.slice(0, dash);
  return {
    numbers: core.split(".").map(Number),
    qualifier: dash === -1 ? undefined : v.slice(dash + 1),
  };
}

function compareQualifiers(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const x = as[i] as string;
    const y = bs[i] as string;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const c = numeric ? compareNumbers(Number(x), Number(y)) : x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return c;
  }
  return compareNumbers(as.length, bs.length);
}

/** Orders versions: numeric parts, then release above qualified, then qualifier segments. */
export function compareVersions(a: string, b: string): number {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  const len = Math.max(va.numbers.length, vb.numbers.length);
  for (let i = 0; i < len; i++) {
    const c = compareNumbers(va.numbers[i] ?? 0, vb.numbers[i] ?? 0);
    if (c !== 0) return c;
  }
  if (va.qualifier === undefined && vb.qualifier === undefined) return 0;
  if (va.qualifier === undefined) return 1;
  if (vb.qualifier === undefined) return -1;
  return compareQualifiers(va.qualifier, vb.qualifier);
}
