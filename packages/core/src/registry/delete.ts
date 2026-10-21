import { and, eq, sql } from "drizzle-orm";
import { artifact, build, version } from "@protoloom/db";
import { recordAudit } from "../audit.js";
import { formatCoordinate, type Coordinate } from "../coordinates.js";
import { RegistryError } from "../errors.js";
import { canDeleteVersions, type Principal } from "../permissions.js";
import { deleteBlobLogged, versionLockKey, type RegistryContext } from "./lookup.js";
import { assertNoDependents, findDependents, readableRepository } from "./read.js";

/**
 * Deletes a version with all its builds, files and dependency edges, then removes the archive
 * blobs after commit. Blocked by dependents in any repository unless an admin passes `force`.
 * The artifact row goes too once its last version is gone.
 */
export async function deleteVersion(
  ctx: RegistryContext,
  p: Principal,
  repositoryName: string,
  c: Coordinate,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (p.kind === "anonymous") throw new RegistryError("unauthorized", "Deleting requires authentication");
  const repo = await readableRepository(ctx.db, p, repositoryName, c.group);
  if (!canDeleteVersions(p, repo, c.group)) {
    throw new RegistryError("forbidden", `Not allowed to delete versions of ${c.group} in ${repo.name}`);
  }

  const storageKeys = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${versionLockKey(repo.name, c)}))`);
    const [target] = await tx
      .select({ versionId: version.id, artifactId: artifact.id })
      .from(version)
      .innerJoin(artifact, eq(artifact.id, version.artifactId))
      .where(
        and(
          eq(artifact.repositoryId, repo.id),
          eq(artifact.group, c.group),
          eq(artifact.name, c.name),
          eq(version.version, c.version),
        ),
      );
    if (!target) throw new RegistryError("not_found", `Version ${formatCoordinate(c)} was not found`);
    const dependents = await findDependents(tx, c);
    const forced = assertNoDependents(p, c, dependents, opts.force);

    const builds = await tx
      .select({ storageKey: build.storageKey })
      .from(build)
      .where(eq(build.versionId, target.versionId));
    await tx.delete(version).where(eq(version.id, target.versionId));
    const [remaining] = await tx
      .select({ id: version.id })
      .from(version)
      .where(eq(version.artifactId, target.artifactId))
      .limit(1);
    if (!remaining) await tx.delete(artifact).where(eq(artifact.id, target.artifactId));

    await recordAudit(tx, {
      actor: p,
      action: "delete",
      target: `${repo.name}/${formatCoordinate(c)}`,
      details: forced
        ? { builds: builds.length, dependents: dependents.map(({ repository, coordinate }) => ({ repository, coordinate })) }
        : { builds: builds.length },
      forced,
    });
    return builds.map((b) => b.storageKey);
  });

  await Promise.all(storageKeys.map((key) => deleteBlobLogged(ctx.blobs, key)));
}
