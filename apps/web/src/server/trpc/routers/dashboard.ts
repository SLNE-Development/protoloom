import { count, desc, eq, inArray } from "drizzle-orm";
import { artifact, build, user, version } from "@protoloom/db";
import { browseProcedure, router } from "../init";
import { browsableRepositories, canReadGroup, coordinateText } from "../helpers";

/** How many recent publishes the dashboard shows. */
const RECENT_PUBLISHES = 10;

/** One recent publish (a build) on the dashboard. */
export interface RecentPublish {
  repository: string;
  coordinate: string;
  buildNumber: number;
  publishedBy: string | null;
  createdAt: Date;
}

/** Overview numbers for the dashboard. */
export interface DashboardStats {
  repositories: number;
  artifacts: number;
  versions: number;
  recentPublishes: RecentPublish[];
}

export const dashboardRouter = router({
  /** Counts and the newest publishes, over the repositories the caller may browse. */
  stats: browseProcedure.query(async ({ ctx }): Promise<DashboardStats> => {
    const repos = await browsableRepositories(ctx.db, ctx.principal);
    if (repos.length === 0) return { repositories: 0, artifacts: 0, versions: 0, recentPublishes: [] };
    const byId = new Map(repos.map((r) => [r.id, r]));
    const ids = [...byId.keys()];

    const [artifactRows, versionRows, recent] = await Promise.all([
      ctx.db
        .select({ repositoryId: artifact.repositoryId, group: artifact.group, artifacts: count() })
        .from(artifact)
        .where(inArray(artifact.repositoryId, ids))
        .groupBy(artifact.repositoryId, artifact.group),
      ctx.db
        .select({ repositoryId: artifact.repositoryId, group: artifact.group, versions: count(version.id) })
        .from(version)
        .innerJoin(artifact, eq(artifact.id, version.artifactId))
        .where(inArray(artifact.repositoryId, ids))
        .groupBy(artifact.repositoryId, artifact.group),
      ctx.db
        .select({
          repositoryId: artifact.repositoryId,
          group: artifact.group,
          name: artifact.name,
          version: version.version,
          buildNumber: build.buildNumber,
          publisherName: user.name,
          publishedByUserId: build.publishedByUserId,
          createdAt: build.createdAt,
        })
        .from(build)
        .innerJoin(version, eq(version.id, build.versionId))
        .innerJoin(artifact, eq(artifact.id, version.artifactId))
        .leftJoin(user, eq(user.id, build.publishedByUserId))
        .where(inArray(artifact.repositoryId, ids))
        .orderBy(desc(build.createdAt), desc(build.buildNumber))
        .limit(RECENT_PUBLISHES * 5),
    ]);

    // API keys may be limited to group prefixes; users and anonymous visitors read whole repositories.
    const readable = (row: { repositoryId: string; group: string }) => canReadGroup(ctx.principal, byId.get(row.repositoryId)!, row.group);
    return {
      repositories: repos.length,
      artifacts: artifactRows.filter(readable).reduce((sum, row) => sum + row.artifacts, 0),
      versions: versionRows.filter(readable).reduce((sum, row) => sum + row.versions, 0),
      recentPublishes: recent
        .filter(readable)
        .slice(0, RECENT_PUBLISHES)
        .map((row) => ({
          repository: byId.get(row.repositoryId)!.name,
          coordinate: coordinateText(row),
          buildNumber: row.buildNumber,
          publishedBy: row.publisherName ?? row.publishedByUserId,
          createdAt: row.createdAt,
        })),
    };
  }),
});
