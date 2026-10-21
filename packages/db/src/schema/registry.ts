import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { apikey } from "./auth.js";

export const visibilityEnum = pgEnum("visibility", ["public", "private"]);
export const cleanupKindEnum = pgEnum("cleanup_kind", [
  "keep_last_snapshot_builds",
  "delete_stale_snapshots",
  "delete_not_downloaded",
]);
export const accessEnum = pgEnum("access", ["read", "write"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const repository = pgTable("repository", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  visibility: visibilityEnum("visibility").notNull().default("private"),
  allowRedeploy: boolean("allow_redeploy").notNull().default(false),
  allowReleases: boolean("allow_releases").notNull().default(true),
  allowSnapshots: boolean("allow_snapshots").notNull().default(true),
  resolutionPriority: integer("resolution_priority").notNull().default(100),
  createdAt: createdAt(),
});

export const artifact = pgTable(
  "artifact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    group: text("group").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("artifact_repository_group_name_uq").on(t.repositoryId, t.group, t.name)],
);

export const version = pgTable(
  "version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    isSnapshot: boolean("is_snapshot").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("version_artifact_version_uq").on(t.artifactId, t.version)],
);

export const build = pgTable(
  "build",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => version.id, { onDelete: "cascade" }),
    buildNumber: integer("build_number").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    publishedByUserId: text("published_by_user_id"),
    publishedByKeyId: text("published_by_key_id"),
    downloadCount: integer("download_count").notNull().default(0),
    lastDownloadedAt: timestamp("last_downloaded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("build_version_number_uq").on(t.versionId, t.buildNumber)],
);

export const buildFile = pgTable(
  "build_file",
  {
    buildId: uuid("build_id")
      .notNull()
      .references(() => build.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.buildId, t.path] })],
);

export const dependency = pgTable(
  "dependency",
  {
    buildId: uuid("build_id")
      .notNull()
      .references(() => build.id, { onDelete: "cascade" }),
    depGroup: text("dep_group").notNull(),
    depName: text("dep_name").notNull(),
    depVersion: text("dep_version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.buildId, t.depGroup, t.depName] }),
    index("dependency_target_idx").on(t.depGroup, t.depName, t.depVersion),
  ],
);

export const cleanupPolicy = pgTable("cleanup_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repository.id, { onDelete: "cascade" }),
  kind: cleanupKindEnum("kind").notNull(),
  value: integer("value").notNull(),
  includeReleases: boolean("include_releases").notNull().default(false),
  groupPrefix: text("group_prefix"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export const apiKeyPermission = pgTable("api_key_permission", {
  id: uuid("id").primaryKey().defaultRandom(),
  apiKeyId: text("api_key_id")
    .notNull()
    .references(() => apikey.id, { onDelete: "cascade" }),
  repository: text("repository").notNull(),
  groupPrefix: text("group_prefix"),
  access: accessEnum("access").notNull(),
});
