/** A parsed npm package name. */
export interface PackageName {
  /** Full name as published, e.g. `@acme/ui` or `left-pad`. */
  full: string;
  /** Scope without the leading `@`; empty for unscoped packages. */
  scope: string;
  /** Name without the scope. */
  bare: string;
}

const MAX_NAME_LENGTH = 214;
const NEW_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Parses a package name for reading; accepts any non-empty name of at most 214 characters, or null when it is not shaped like one. */
export function parsePackageName(full: string): PackageName | null {
  if (full.length === 0 || full.length > MAX_NAME_LENGTH) return null;
  if (full.startsWith("@")) {
    const parts = full.slice(1).split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { full, scope: parts[0], bare: parts[1] };
  }
  if (full.includes("/")) return null;
  return { full, scope: "", bare: full };
}

/** Whether a name may be used for a newly published package (npm's naming rules, at most 214 characters). */
export function isValidNewPackageName(full: string): boolean {
  return full.length <= MAX_NAME_LENGTH && NEW_NAME.test(full);
}

/** The tarball file name npm uses for a version: `<bare>-<version>.tgz`. */
export function tarballFile(name: PackageName, version: string): string {
  return `${name.bare}-${version}.tgz`;
}

/** Extracts the version from a tarball file name of this package, or null when the file belongs to another name. */
export function versionFromTarball(name: PackageName, file: string): string | null {
  const prefix = `${name.bare}-`;
  if (!file.startsWith(prefix) || !file.endsWith(".tgz")) return null;
  const version = file.slice(prefix.length, -".tgz".length);
  return version.length > 0 ? version : null;
}

/** The package path used against an upstream registry, with the scope slash encoded (`@acme%2fui`). */
export function upstreamPackagePath(name: PackageName): string {
  return name.scope ? `@${name.scope}%2f${name.bare}` : name.bare;
}
