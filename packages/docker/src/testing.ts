import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RegistryError,
  createAssetService,
  createMirrorEngine,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  extractToken,
  type Access,
  type CreateRepoInput,
  type FormatDeps,
  type FormatHandler,
  type KeyPermission,
  type Principal,
  type Repo,
  type ServerSettings,
} from "@weaver/core";
import { startTestDb } from "@weaver/db/testing";
import { createDockerHandlerWith } from "./handler.js";

/** A running registry over a throwaway database and local store, for tests only. */
export interface DockerTestRegistry {
  /** The wired dependencies, so tests can reach the services directly. */
  deps: FormatDeps;
  /** The docker handler under test. */
  handler: FormatHandler;
  /** Sends a request to `http://weaver.test/v2/<rest>`; `token` is passed as the basic-auth password. */
  call(
    method: string,
    rest: string,
    init?: { headers?: Record<string, string>; body?: RequestInit["body"]; token?: string },
  ): Promise<Response>;
  /** Creates a repository as an admin. */
  createRepo(input: CreateRepoInput): Promise<Repo>;
  /** Issues a test token that acts as an API key holding `perms` on the named repositories. */
  tokenFor(perms: Array<{ repo: string; access: Access }>): string;
  /** Stops the database and removes the temporary directories. */
  stop(): Promise<void>;
}

const ADMIN: Principal = { kind: "user", userId: "test-admin", role: "admin" };

/** Starts a {@link DockerTestRegistry}; `fetchImpl` replaces the mirror engine's upstream fetch. */
export async function startDockerTestRegistry(opts: { fetchImpl?: typeof fetch } = {}): Promise<DockerTestRegistry> {
  const testDb = await startTestDb();
  const dir = await mkdtemp(join(tmpdir(), "weaver-docker-test-"));
  const secretKey = deriveSecretKey("docker-test");
  const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: join(dir, "blobs") });
  const repos = createRepoService({ db: testDb.db, stores, secretKey });
  const assets = createAssetService({ db: testDb.db, stores });
  const settings = (): Promise<ServerSettings> => Promise.resolve({ anonymousView: false, defaultCacheStore: "local" });
  const mirror = createMirrorEngine({ db: testDb.db, stores, repos, assets, settings, fetchImpl: opts.fetchImpl });
  const tokens = new Map<string, Array<{ repo: string; access: Access }>>();

  const deps: FormatDeps = {
    db: testDb.db,
    stores,
    repos,
    assets,
    mirror,
    secretKey,
    publicUrl: "http://weaver.test",
    settings,
    usage: () => Promise.resolve(),
    async principal(req) {
      const token = extractToken(req.headers);
      if (token === null) return { kind: "anonymous" };
      const perms = tokens.get(token);
      if (!perms) throw new RegistryError("unauthorized", "Invalid API key");
      const permissions: KeyPermission[] = [];
      for (const p of perms) {
        const repo = await repos.get(p.repo);
        if (repo) permissions.push({ repositoryId: repo.id, repository: repo.name, groupPrefix: null, access: p.access });
      }
      return { kind: "apikey", keyId: token, userId: "test-user", role: "maintainer", permissions };
    },
  };
  const handler = createDockerHandlerWith(deps, { uploadDir: join(dir, "uploads") });

  return {
    deps,
    handler,
    call(method, rest, init = {}) {
      const headers = new Headers(init.headers);
      if (init.token !== undefined) headers.set("authorization", `Basic ${Buffer.from(`x:${init.token}`).toString("base64")}`);
      return handler(new Request(`http://weaver.test/v2/${rest}`, { method, headers, body: init.body }), rest);
    },
    createRepo: (input) => repos.create(ADMIN, input),
    tokenFor(perms) {
      const token = `test-token-${tokens.size + 1}`;
      tokens.set(token, perms);
      return token;
    },
    async stop() {
      await mirror.drain();
      await testDb.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
