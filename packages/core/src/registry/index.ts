import type { Db } from "@protoloom/db";
import type { Coordinate } from "../coordinates.js";
import type { Principal } from "../permissions.js";
import type { Resolution } from "../resolution.js";
import type { BlobStore } from "../storage/index.js";
import { validateProtos } from "../validation.js";
import { deleteVersion } from "./delete.js";
import type { RegistryContext } from "./lookup.js";
import { publish, type PublishInput, type PublishResult } from "./publish.js";
import {
  download,
  getFile,
  getManifest,
  listDependents,
  listVersions,
  resolve,
  type Dependent,
  type VersionInfo,
  type VersionSummary,
} from "./read.js";

export { manifestSchema, type Manifest, type PublishInput, type PublishResult } from "./publish.js";
export type { Dependent, VersionInfo, VersionSummary } from "./read.js";

/** The registry service: publishing, reading, resolving and deleting artifact versions. */
export interface Registry {
  publish(p: Principal, input: PublishInput): Promise<PublishResult>;
  listVersions(p: Principal, repository: string, group: string, name: string): Promise<VersionSummary[]>;
  getManifest(p: Principal, repository: string, c: Coordinate): Promise<VersionInfo>;
  download(p: Principal, repository: string, c: Coordinate): Promise<{ data: Buffer; sha256: string; filename: string }>;
  getFile(p: Principal, repository: string, c: Coordinate, path: string): Promise<string>;
  resolve(p: Principal, repositories: string[], roots: Coordinate[]): Promise<Resolution>;
  /** Versions in any repository that depend on `c`; not filtered by principal. */
  listDependents(c: Coordinate): Promise<Dependent[]>;
  deleteVersion(p: Principal, repository: string, c: Coordinate, opts?: { force?: boolean }): Promise<void>;
}

/** Creates the registry over a database and a blob store; `validate` defaults to buf-backed {@link validateProtos}. */
export function createRegistry(deps: { db: Db; blobs: BlobStore; validate?: typeof validateProtos }): Registry {
  const ctx: RegistryContext = { db: deps.db, blobs: deps.blobs, validate: deps.validate ?? validateProtos };
  return {
    publish: (p, input) => publish(ctx, p, input),
    listVersions: (p, repository, group, name) => listVersions(ctx, p, repository, group, name),
    getManifest: (p, repository, c) => getManifest(ctx, p, repository, c),
    download: (p, repository, c) => download(ctx, p, repository, c),
    getFile: (p, repository, c, path) => getFile(ctx, p, repository, c, path),
    resolve: (p, repositories, roots) => resolve(ctx, p, repositories, roots),
    listDependents: (c) => listDependents(ctx.db, c),
    deleteVersion: (p, repository, c, opts) => deleteVersion(ctx, p, repository, c, opts),
  };
}
