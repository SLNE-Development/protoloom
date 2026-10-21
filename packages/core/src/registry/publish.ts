import { randomUUID } from "node:crypto";
import { eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { artifact, build, buildFile, dependency, version } from "@protoloom/db";
import { recordAudit } from "../audit.js";
import { extractArchive, sha256 } from "../archive.js";
import {
  formatCoordinate,
  isSnapshot,
  isValidGroup,
  isValidName,
  isValidVersion,
  parseCoordinate,
  type Coordinate,
} from "../coordinates.js";
import { RegistryError } from "../errors.js";
import { canAccess, type Principal } from "../permissions.js";
import { findPathCollisions, resolveGraph, type Resolution } from "../resolution.js";
import {
  createLookup,
  findLatestBuild,
  findRepository,
  loadFiles,
  publishRepositoryOrder,
  versionLockKey,
  type BuildRow,
  type Queryable,
  type RegistryContext,
  type RepositoryRow,
} from "./lookup.js";
import { assertNoDependents, listDependents, type Dependent } from "./read.js";

function isCoordinateString(s: string): boolean {
  try {
    parseCoordinate(s);
    return true;
  } catch {
    return false;
  }
}

/** The publish manifest: the artifact's coordinate and its declared direct dependencies. */
export const manifestSchema = z
  .object({
    group: z.string().refine(isValidGroup, "Invalid group"),
    name: z.string().refine(isValidName, "Invalid name"),
    version: z.string().refine(isValidVersion, "Invalid version"),
    dependencies: z.array(z.string().refine(isCoordinateString, "Expected group:name:version")),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.dependencies.forEach((dep, i) => {
      if (!isCoordinateString(dep)) return;
      const { group, name } = parseCoordinate(dep);
      const key = `${group}:${name}`;
      if (key === `${m.group}:${m.name}`) {
        ctx.addIssue({ code: "custom", path: ["dependencies", i], message: "An artifact cannot depend on itself" });
      } else if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["dependencies", i], message: `Duplicate dependency on ${key}` });
      }
      seen.add(key);
    });
  });

export type Manifest = z.infer<typeof manifestSchema>;

/** Input of {@link publish}. */
export interface PublishInput {
  repository: string;
  manifest: Manifest;
  archive: Buffer;
  force?: boolean;
}

/** Outcome of a successful publish. */
export interface PublishResult {
  coordinate: Coordinate;
  buildNumber: number;
  sha256: string;
  redeployed: boolean;
}

function validationFailed(message: string, details?: unknown): RegistryError {
  return new RegistryError("validation_failed", message, details);
}

function parseManifest(input: unknown): Manifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RegistryError("invalid_request", "Invalid manifest", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/**
 * Checks publishing over an existing release: rejects it as `immutable` unless the repository
 * allows redeploy, and applies the dependents rule. Returns the build being replaced (null for
 * snapshots and new releases) and whether the replacement is forced.
 */
async function checkExistingRelease(
  db: Queryable,
  p: Principal,
  repo: RepositoryRow,
  c: Coordinate,
  force: boolean | undefined,
): Promise<{ existing: BuildRow | null; forced: boolean; dependents: Dependent[] }> {
  const none = { existing: null, forced: false, dependents: [] };
  if (isSnapshot(c.version)) return none;
  const existing = await findLatestBuild(db, repo.id, c);
  if (!existing) return none;
  if (!repo.allowRedeploy) {
    throw new RegistryError("immutable", `${formatCoordinate(c)} already exists in ${repo.name} and releases are immutable`);
  }
  const dependents = await listDependents(db, c);
  return { existing, forced: assertNoDependents(p, c, dependents, force), dependents };
}

/** Resolves the declared dependencies the way publishing does and rejects unusable graphs. */
async function resolveDependencies(
  ctx: RegistryContext,
  p: Principal,
  repo: RepositoryRow,
  c: Coordinate,
  declared: Coordinate[],
): Promise<{ resolution: Resolution; buildIds: Map<string, string> }> {
  if (!isSnapshot(c.version)) {
    const snapshot = declared.find((d) => isSnapshot(d.version));
    if (snapshot) throw validationFailed(`A release may not depend on snapshot ${formatCoordinate(snapshot)}`);
  }
  const { lookup, buildIds } = createLookup(ctx.db, p, await publishRepositoryOrder(ctx.db, repo));
  let resolution: Resolution;
  try {
    resolution = await resolveGraph(declared, lookup);
  } catch (error) {
    if (error instanceof RegistryError && error.code === "not_found") {
      const path = (error.details as { path?: string[] } | undefined)?.path ?? [];
      throw validationFailed(`Dependency not found: ${path.at(-1) ?? error.message}`, { path });
    }
    throw error;
  }
  for (const node of resolution.nodes) {
    if (node.coordinate.group === c.group && node.coordinate.name === c.name) {
      throw validationFailed(`${c.group}:${c.name} depends on itself through ${formatCoordinate(node.coordinate)}`);
    }
    if (!isSnapshot(c.version) && isSnapshot(node.coordinate.version)) {
      throw validationFailed(`A release may not depend on snapshot ${formatCoordinate(node.coordinate)}`);
    }
  }
  return { resolution, buildIds };
}

/**
 * Publishes an archive: checks permissions and the manifest, validates the protos against the
 * resolved dependencies, stores the blob, then records the build in one transaction serialized
 * per version by an advisory lock. A redeploy replaces build 1 and drops the old blob afterwards.
 */
export async function publish(ctx: RegistryContext, p: Principal, input: PublishInput): Promise<PublishResult> {
  if (p.kind === "anonymous") throw new RegistryError("unauthorized", "Publishing requires an API key");
  const manifest = parseManifest(input.manifest);
  const c: Coordinate = { group: manifest.group, name: manifest.name, version: manifest.version };
  const repo = await findRepository(ctx.db, input.repository);
  if (!repo) throw new RegistryError("not_found", `Repository ${input.repository} was not found`);
  if (!canAccess(p, repo, c.group, "write")) {
    throw new RegistryError("forbidden", `No write access to ${c.group} in ${repo.name}`);
  }
  const snapshot = isSnapshot(c.version);
  if (snapshot && !repo.allowSnapshots) {
    throw new RegistryError("invalid_request", `Repository ${repo.name} does not accept snapshots`);
  }
  if (!snapshot && !repo.allowReleases) {
    throw new RegistryError("invalid_request", `Repository ${repo.name} does not accept releases`);
  }

  const files = await extractArchive(input.archive);
  if (files.length === 0) throw new RegistryError("invalid_request", "The archive contains no .proto files");
  await checkExistingRelease(ctx.db, p, repo, c, input.force);

  const declared = manifest.dependencies.map(parseCoordinate);
  const { resolution, buildIds } = await resolveDependencies(ctx, p, repo, c, declared);
  const depBuildIds = resolution.nodes.map((n) => buildIds.get(formatCoordinate(n.coordinate)) as string);
  const depFiles = await loadFiles(ctx.db, depBuildIds);

  const collisions = findPathCollisions([
    { coordinate: c, paths: files.map((f) => f.path) },
    ...resolution.nodes.map((n, i) => ({
      coordinate: n.coordinate,
      paths: (depFiles.get(depBuildIds[i] as string) ?? []).map((f) => f.path),
    })),
  ]);
  if (collisions.length > 0) {
    throw validationFailed(`${collisions.length} file path(s) are provided by more than one artifact`, { collisions });
  }
  const issues = await ctx.validate({ files, dependencyFiles: [...depFiles.values()].flat() });
  if (issues.length > 0) throw validationFailed("Proto validation failed", { issues });

  const digest = sha256(input.archive);
  const storageKey = `${repo.name}/${c.group}/${c.name}/${c.version}/${randomUUID()}.tar.gz`;
  await ctx.blobs.put(storageKey, input.archive);

  let outcome: { buildNumber: number; replaced: BuildRow | null };
  try {
    outcome = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${versionLockKey(repo.name, c)}))`);
      // Hold every dependency still while this build commits, and make sure none vanished meanwhile.
      for (const node of resolution.nodes) {
        const key = versionLockKey(node.repository, node.coordinate);
        await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${key}))`);
      }
      if (depBuildIds.length > 0) {
        const present = await tx.select({ id: build.id }).from(build).where(inArray(build.id, depBuildIds));
        if (present.length !== depBuildIds.length) {
          throw validationFailed("A dependency was removed or replaced during publishing; retry");
        }
      }
      const { existing, forced, dependents } = await checkExistingRelease(tx, p, repo, c, input.force);

      const [art] = await tx
        .insert(artifact)
        .values({ repositoryId: repo.id, group: c.group, name: c.name })
        .onConflictDoUpdate({
          target: [artifact.repositoryId, artifact.group, artifact.name],
          set: { name: sql`excluded.name` },
        })
        .returning({ id: artifact.id });
      const now = new Date();
      const [ver] = await tx
        .insert(version)
        .values({ artifactId: art!.id, version: c.version, isSnapshot: snapshot })
        .onConflictDoUpdate({ target: [version.artifactId, version.version], set: { updatedAt: now } })
        .returning({ id: version.id });
      const versionId = ver!.id;

      let buildNumber = 1;
      if (existing) {
        await tx.delete(build).where(eq(build.id, existing.id));
      } else if (snapshot) {
        const [row] = await tx
          .select({ highest: max(build.buildNumber) })
          .from(build)
          .where(eq(build.versionId, versionId));
        buildNumber = (row?.highest ?? 0) + 1;
      }

      const [created] = await tx
        .insert(build)
        .values({
          versionId,
          buildNumber,
          storageKey,
          sha256: digest,
          sizeBytes: input.archive.length,
          publishedByUserId: p.userId,
          publishedByKeyId: p.kind === "apikey" ? p.keyId : null,
        })
        .returning({ id: build.id });
      const buildId = created!.id;
      await tx.insert(buildFile).values(files.map((f) => ({ buildId, path: f.path, content: f.content })));
      if (declared.length > 0) {
        await tx
          .insert(dependency)
          .values(declared.map((d) => ({ buildId, depGroup: d.group, depName: d.name, depVersion: d.version })));
      }
      await recordAudit(tx, {
        actor: p,
        action: existing ? "redeploy" : "publish",
        target: `${repo.name}/${formatCoordinate(c)}`,
        details: forced ? { buildNumber, sha256: digest, dependents } : { buildNumber, sha256: digest },
        forced,
      });
      return { buildNumber, replaced: existing };
    });
  } catch (error) {
    await ctx.blobs.delete(storageKey).catch(() => undefined);
    throw error;
  }

  if (outcome.replaced) {
    // The new build is committed; a failure here only leaves an orphaned blob behind.
    await ctx.blobs.delete(outcome.replaced.storageKey).catch(() => undefined);
  }
  return { coordinate: c, buildNumber: outcome.buildNumber, sha256: digest, redeployed: outcome.replaced !== null };
}
