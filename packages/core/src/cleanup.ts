import { and, asc, eq, inArray, max } from "drizzle-orm";
import { artifact, build, cleanupPolicy, repository, version, type Db } from "@weaver/db";
import { recordAudit } from "./audit.js";
import { formatCoordinate, type Coordinate } from "./coordinates.js";
import { RegistryError } from "./errors.js";
import { groupMatches } from "./permissions.js";
import { deleteBuildRow, deleteVersionRows, findVersionTarget, lockVersion } from "./registry/delete.js";
import { deleteBlobLogged, findRepository, type RepositoryRow } from "./registry/lookup.js";
import { findDependents, type Dependent } from "./registry/read.js";
import type { StoreSet } from "./storage/index.js";

/** Advisory lock key held by {@link runAllCleanups} so overlapping runs skip instead of racing. */
const CLEANUP_LOCK_KEY = 727001;
const DAY_MS = 86_400_000;

/** One thing a cleanup run deletes: a single snapshot build, or a whole version when `buildNumber` is null. */
export interface CleanupCandidate {
  repository: string;
  coordinate: Coordinate;
  /** null = the whole version. */
  buildNumber: number | null;
  reason: string;
}

type PolicyRow = typeof cleanupPolicy.$inferSelect;

interface VersionRow {
  versionId: string;
  coordinate: Coordinate;
  isSnapshot: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastDownloadedAt: Date | null;
}

/** A candidate plus the row state it was planned against, re-checked under the version lock. */
interface PlannedCandidate extends CleanupCandidate {
  updatedAt: Date;
}

const coordinateKey = (c: Coordinate) => formatCoordinate(c);

function compareCandidates(a: CleanupCandidate, b: CleanupCandidate): number {
  const byCoordinate = coordinateKey(a.coordinate).localeCompare(coordinateKey(b.coordinate));
  if (byCoordinate !== 0) return byCoordinate;
  return (a.buildNumber ?? Number.MAX_SAFE_INTEGER) - (b.buildNumber ?? Number.MAX_SAFE_INTEGER);
}

async function loadVersions(db: Db, repositoryId: string): Promise<VersionRow[]> {
  const rows = await db
    .select({
      versionId: version.id,
      group: artifact.group,
      name: artifact.name,
      version: version.version,
      isSnapshot: version.isSnapshot,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
      lastDownloadedAt: max(build.lastDownloadedAt),
    })
    .from(version)
    .innerJoin(artifact, eq(artifact.id, version.artifactId))
    .leftJoin(build, eq(build.versionId, version.id))
    .where(eq(artifact.repositoryId, repositoryId))
    .groupBy(version.id, artifact.group, artifact.name);
  return rows.map((r) => ({
    versionId: r.versionId,
    coordinate: { group: r.group, name: r.name, version: r.version },
    isSnapshot: r.isSnapshot,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastDownloadedAt: r.lastDownloadedAt,
  }));
}

/** Build numbers of the given versions, newest first, keyed by version id. */
async function loadBuildNumbers(db: Db, versionIds: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (versionIds.length === 0) return out;
  const rows = await db
    .select({ versionId: build.versionId, buildNumber: build.buildNumber })
    .from(build)
    .where(inArray(build.versionId, versionIds))
    .orderBy(asc(build.versionId), asc(build.buildNumber));
  for (const r of rows) {
    const list = out.get(r.versionId) ?? [];
    list.unshift(r.buildNumber);
    out.set(r.versionId, list);
  }
  return out;
}

/** Days-based rules use at least one day, so a misconfigured 0 never sweeps everything. */
const cutoff = (now: Date, days: number) => new Date(now.getTime() - Math.max(1, days) * DAY_MS);

/** Whole versions a single days-based rule targets, with the rule's reason. Releases only via an explicit `includeReleases`. */
function wholeVersionTargets(policy: PolicyRow, versions: VersionRow[], now: Date): { v: VersionRow; reason: string }[] {
  const before = cutoff(now, policy.value);
  switch (policy.kind) {
    case "delete_stale_snapshots":
      return versions
        .filter((v) => v.isSnapshot && v.updatedAt < before)
        .map((v) => ({ v, reason: `snapshot not published for ${policy.value} days` }));
    case "delete_not_downloaded":
      return versions
        .filter((v) => (v.isSnapshot || policy.includeReleases) && (v.lastDownloadedAt ?? v.createdAt) < before)
        .map((v) => ({ v, reason: `not downloaded for ${policy.value} days` }));
    case "keep_last_snapshot_builds":
      return [];
  }
}

/**
 * Drops whole-version candidates that a retained version (any repository) depends on, repeating
 * until stable, since dropping one candidate retains it and may protect its own dependencies.
 */
async function excludeDepended(
  db: Db,
  repo: RepositoryRow,
  wholes: Map<string, PlannedCandidate>,
): Promise<void> {
  const dependentsOf = new Map<string, Dependent[]>();
  for (const [key, candidate] of wholes) dependentsOf.set(key, await findDependents(db, candidate.coordinate));
  const isRetained = (d: Dependent) => d.repository !== repo.name || !wholes.has(coordinateKey(d.coordinate));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, dependents] of dependentsOf) {
      if (!wholes.has(key)) continue;
      if (dependents.some(isRetained)) {
        wholes.delete(key);
        changed = true;
      }
    }
  }
}

async function planFor(db: Db, repo: RepositoryRow, now: Date): Promise<PlannedCandidate[]> {
  const policies = await db
    .select()
    .from(cleanupPolicy)
    .where(and(eq(cleanupPolicy.repositoryId, repo.id), eq(cleanupPolicy.enabled, true)))
    .orderBy(asc(cleanupPolicy.createdAt), asc(cleanupPolicy.id));
  if (policies.length === 0) return [];

  const versions = await loadVersions(db, repo.id);
  const inScope = (p: PolicyRow) => versions.filter((v) => groupMatches(p.groupPrefix, v.coordinate.group));

  const wholes = new Map<string, PlannedCandidate>();
  for (const policy of policies) {
    for (const { v, reason } of wholeVersionTargets(policy, inScope(policy), now)) {
      const key = coordinateKey(v.coordinate);
      if (wholes.has(key)) continue;
      wholes.set(key, { repository: repo.name, coordinate: v.coordinate, buildNumber: null, reason, updatedAt: v.updatedAt });
    }
  }
  await excludeDepended(db, repo, wholes);

  const builds: PlannedCandidate[] = [];
  const seenBuilds = new Set<string>();
  const keepRules = policies.filter((p) => p.kind === "keep_last_snapshot_builds");
  if (keepRules.length > 0) {
    const snapshots = versions.filter((v) => v.isSnapshot);
    const numbers = await loadBuildNumbers(db, snapshots.map((v) => v.versionId));
    for (const policy of keepRules) {
      const keep = Math.max(1, policy.value);
      for (const v of inScope(policy).filter((x) => x.isSnapshot)) {
        if (wholes.has(coordinateKey(v.coordinate))) continue;
        for (const buildNumber of (numbers.get(v.versionId) ?? []).slice(keep)) {
          const key = `${coordinateKey(v.coordinate)}#${buildNumber}`;
          if (seenBuilds.has(key)) continue;
          seenBuilds.add(key);
          builds.push({
            repository: repo.name,
            coordinate: v.coordinate,
            buildNumber,
            reason: `keep last ${keep} snapshot builds`,
            updatedAt: v.updatedAt,
          });
        }
      }
    }
  }
  return [...wholes.values(), ...builds].sort(compareCandidates);
}

async function requireRepository(db: Db, name: string): Promise<RepositoryRow> {
  const repo = await findRepository(db, name);
  if (!repo) throw new RegistryError("not_found", `Repository ${name} was not found`);
  return repo;
}

const publicCandidate = ({ repository: r, coordinate, buildNumber, reason }: PlannedCandidate): CleanupCandidate => ({
  repository: r,
  coordinate,
  buildNumber,
  reason,
});

/**
 * Lists what the repository's enabled cleanup policies would delete at `now` (a dry run).
 * Releases are only planned by a `delete_not_downloaded` rule with `includeReleases`; the newest
 * build of a snapshot is never planned on its own; and a version that a retained version in any
 * repository depends on is never planned. Throws `not_found` for an unknown repository.
 */
export async function planCleanup(db: Db, repositoryName: string, now: Date): Promise<CleanupCandidate[]> {
  const repo = await requireRepository(db, repositoryName);
  return (await planFor(db, repo, now)).map(publicCandidate);
}

/**
 * Deletes one planned candidate under its version lock, re-checking that the version was not
 * published again since planning and, for whole versions, that nothing depends on it now.
 * Returns the storage keys to remove after commit, or null when the candidate was skipped.
 */
async function applyOne(db: Db, repo: RepositoryRow, candidate: PlannedCandidate): Promise<string[] | null> {
  return db.transaction(async (tx) => {
    await lockVersion(tx, repo.name, candidate.coordinate);
    const target = await findVersionTarget(tx, repo.id, candidate.coordinate);
    if (!target || target.updatedAt.getTime() !== candidate.updatedAt.getTime()) return null;

    let keys: string[];
    if (candidate.buildNumber === null) {
      if ((await findDependents(tx, candidate.coordinate)).length > 0) return null;
      keys = await deleteVersionRows(tx, target);
    } else {
      const key = await deleteBuildRow(tx, target.versionId, candidate.buildNumber);
      if (key === null) return null;
      keys = [key];
    }
    const suffix = candidate.buildNumber === null ? "" : `#${candidate.buildNumber}`;
    await recordAudit(tx, {
      actor: "system",
      action: "cleanup.delete",
      target: `${repo.name}/${formatCoordinate(candidate.coordinate)}${suffix}`,
      details: { reason: candidate.reason, buildNumber: candidate.buildNumber, builds: keys.length },
    });
    return keys;
  });
}

/**
 * Runs the repository's cleanup policies: plans as {@link planCleanup}, then deletes each
 * candidate in its own transaction (rows, then blobs after commit) with a `cleanup.delete` audit
 * entry by the system. Dependents are deleted before what they depend on; a candidate that changed
 * since planning is skipped. Returns the candidates actually deleted.
 */
export async function applyCleanup(
  db: Db,
  stores: StoreSet,
  repositoryName: string,
  now: Date,
): Promise<CleanupCandidate[]> {
  const repo = await requireRepository(db, repositoryName);
  const applied: PlannedCandidate[] = [];
  // Whole versions blocked only by another candidate become deletable once that one is gone,
  // so retry them while each pass makes progress.
  let pending = await planFor(db, repo, now);
  while (pending.length > 0) {
    const retry: PlannedCandidate[] = [];
    for (const candidate of pending) {
      const keys = await applyOne(db, repo, candidate);
      if (keys === null) {
        if (candidate.buildNumber === null) retry.push(candidate);
        continue;
      }
      applied.push(candidate);
      await Promise.all(keys.map((key) => deleteBlobLogged(stores.primary, key)));
    }
    if (retry.length === pending.length) break;
    pending = retry;
  }
  return applied.sort(compareCandidates).map(publicCandidate);
}

/**
 * Applies the cleanup policies of every repository that has an enabled policy and returns the
 * number of deletions. Holds the session advisory lock {@link CLEANUP_LOCK_KEY} for the run and
 * returns 0 at once when another run holds it. A failing repository does not stop the others;
 * its error is rethrown (aggregated) after the rest ran.
 */
export async function runAllCleanups(db: Db, stores: StoreSet, now: Date): Promise<number> {
  const lockClient = await db.$client.connect();
  // Set when unlocking fails: releasing with it destroys the connection, which drops the session lock.
  let unlockError: Error | undefined;
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [
      CLEANUP_LOCK_KEY,
    ]);
    if (!rows[0]?.locked) return 0;
    try {
      const repos = await db
        .selectDistinct({ name: repository.name })
        .from(repository)
        .innerJoin(cleanupPolicy, eq(cleanupPolicy.repositoryId, repository.id))
        .where(eq(cleanupPolicy.enabled, true))
        .orderBy(asc(repository.name));
      let deleted = 0;
      const errors: unknown[] = [];
      for (const { name } of repos) {
        try {
          deleted += (await applyCleanup(db, stores, name, now)).length;
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `Cleanup failed for ${errors.length} repositories`);
      return deleted;
    } finally {
      try {
        await lockClient.query("select pg_advisory_unlock($1)", [CLEANUP_LOCK_KEY]);
      } catch (error) {
        unlockError = error instanceof Error ? error : new Error(String(error));
        console.warn("weaver: releasing the cleanup lock failed; discarding its connection", unlockError);
      }
    }
  } finally {
    lockClient.release(unlockError);
  }
}
