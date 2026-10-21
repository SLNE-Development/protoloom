export type Role = "admin" | "maintainer" | "viewer";
export type Access = "read" | "write";

/** One scope entry of an API key: a repository, an optional group prefix, and an access level. */
export interface KeyPermission {
  repository: string;
  groupPrefix: string | null;
  access: Access;
}

export type Principal =
  | { kind: "anonymous" }
  | { kind: "user"; userId: string; role: Role }
  | { kind: "apikey"; keyId: string; userId: string; role: Role; permissions: KeyPermission[] };

export interface RepoRef {
  name: string;
  visibility: "public" | "private";
}

/**
 * Whether `group` is covered by `prefix`. A null prefix covers every group; otherwise the group
 * must equal the prefix or continue it at a dot boundary (`dev.surf` covers `dev.surf.economy`
 * but not `dev.surfboard`).
 */
export function groupMatches(prefix: string | null, group: string): boolean {
  if (prefix === null) return true;
  return group === prefix || group.startsWith(`${prefix}.`);
}

/** The highest access a key can effectively hold for its owner's current role. */
export function maxKeyAccess(role: Role): Access {
  return role === "viewer" ? "read" : "write";
}

/** Whether an API key principal holds `access` on the repository and group via its entries, capped by the owner's current role. */
function keyGrants(
  p: Extract<Principal, { kind: "apikey" }>,
  repo: RepoRef,
  group: string,
  access: Access,
): boolean {
  const ceiling = maxKeyAccess(p.role);
  return p.permissions.some((entry) => {
    if (entry.repository !== repo.name || !groupMatches(entry.groupPrefix, group)) return false;
    const effective: Access = ceiling === "read" ? "read" : entry.access;
    return access === "read" || effective === "write";
  });
}

/**
 * Whether the principal may read or write the given group of a repository. Users read everything
 * but never write directly (publishing goes through keys); keys are limited to their entries,
 * capped by the owner's role at request time.
 */
export function canAccess(p: Principal, repo: RepoRef, group: string, access: Access): boolean {
  if (access === "read" && repo.visibility === "public") return true;
  switch (p.kind) {
    case "anonymous":
      return false;
    case "user":
      return access === "read";
    case "apikey":
      return keyGrants(p, repo, group, access);
  }
}

/** Whether the principal may delete versions in the group: a maintainer or admin user, or a key with write access owned by one. */
export function canDeleteVersions(p: Principal, repo: RepoRef, group: string): boolean {
  switch (p.kind) {
    case "anonymous":
      return false;
    case "user":
      return p.role !== "viewer";
    case "apikey":
      return p.role !== "viewer" && keyGrants(p, repo, group, "write");
  }
}

/** Whether the principal is an admin user or a key owned by one. */
export function isAdmin(p: Principal): boolean {
  return p.kind !== "anonymous" && p.role === "admin";
}

/** Whether the principal may override dependent checks with `force`. */
export function canForce(p: Principal): boolean {
  return isAdmin(p);
}
