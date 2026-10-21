import { randomUUID } from "node:crypto";
import { artifact, build, buildFile, dependency, repository, version, type Db } from "@protoloom/db";

/** Test helper: inserts a repository row and returns its id. */
export async function insertRepository(db: Db, name: string, visibility: "public" | "private"): Promise<string> {
  const [row] = await db.insert(repository).values({ name, visibility }).returning({ id: repository.id });
  return row!.id;
}

/**
 * Test helper: inserts one artifact version with a single build directly into the tables the
 * registry reads (no archive blob, so only metadata reads work).
 */
export async function insertVersion(
  db: Db,
  repositoryId: string,
  c: { group: string; name: string; version: string },
  opts: { files?: string[]; dependencies?: { group: string; name: string; version: string }[] } = {},
): Promise<void> {
  const [art] = await db
    .insert(artifact)
    .values({ repositoryId, group: c.group, name: c.name })
    .onConflictDoUpdate({ target: [artifact.repositoryId, artifact.group, artifact.name], set: { group: c.group } })
    .returning({ id: artifact.id });
  const [ver] = await db
    .insert(version)
    .values({ artifactId: art!.id, version: c.version, isSnapshot: c.version.endsWith("-SNAPSHOT") })
    .returning({ id: version.id });
  const [b] = await db
    .insert(build)
    .values({ versionId: ver!.id, buildNumber: 1, storageKey: `test/${randomUUID()}`, sha256: "0".repeat(64), sizeBytes: 1 })
    .returning({ id: build.id });
  const files = opts.files ?? [`${c.group.replaceAll(".", "/")}/${c.name}.proto`];
  if (files.length > 0) {
    await db.insert(buildFile).values(files.map((path) => ({ buildId: b!.id, path, content: 'syntax = "proto3";\n' })));
  }
  const deps = opts.dependencies ?? [];
  if (deps.length > 0) {
    await db
      .insert(dependency)
      .values(deps.map((d) => ({ buildId: b!.id, depGroup: d.group, depName: d.name, depVersion: d.version })));
  }
}
