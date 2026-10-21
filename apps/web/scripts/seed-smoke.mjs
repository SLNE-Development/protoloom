// Seeds a fresh Protoloom database for the end-to-end smoke test (scripts/e2e-smoke.sh).
//
// Login is OAuth only, so no user can be created through the UI in a test stack. This script
// creates, idempotently:
//   - an admin user `smoke-admin` (directly in the database),
//   - a private `releases` repository,
//   - an API key with write access to `releases`, created through Better Auth's server API with the
//     same api-key plugin options and `pl_` prefix as the app (see src/server/auth.ts and the
//     `keys.create` tRPC procedure), plus its permission row.
// The key is printed as the LAST line on stdout; progress goes to stderr.
//
// It is NOT part of the image. scripts/e2e-smoke.sh bundles it with esbuild into one file and
// copies it into the running app container (docker cp), then runs it with plain node.
// Guards: it runs only with PROTOLOOM_SMOKE_SEED=1, and refuses a database that has any user
// other than the smoke admin. Needs DATABASE_URL, BETTER_AUTH_SECRET and BETTER_AUTH_URL.
import { randomUUID } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { eq, ne } from "drizzle-orm";
import { account, apikey, apiKeyPermission, createDb, repository, session, user, verification } from "@protoloom/db";

const ADMIN_EMAIL = "smoke-admin@protoloom.invalid";
const REPOSITORY = "releases";
/** Must match API_KEY_PREFIX in src/server/trpc/routers/keys.ts. */
const API_KEY_PREFIX = "pl_";

/** The value of a required environment variable, or exits with an error. */
function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`seed-smoke: ${name} is not set`);
    process.exit(1);
  }
  return value;
}

const log = (message) => console.error(`seed-smoke: ${message}`);

if (process.env.PROTOLOOM_SMOKE_SEED !== "1") {
  console.error("seed-smoke: refusing to run without PROTOLOOM_SMOKE_SEED=1 (smoke-test stacks only)");
  process.exit(1);
}

const db = createDb(required("DATABASE_URL"));
try {
  // A database with any other user is a real instance: never add an admin and a key to it.
  const [other] = await db.select({ id: user.id }).from(user).where(ne(user.email, ADMIN_EMAIL)).limit(1);
  if (other) {
    console.error("seed-smoke: refusing to run, the database has users other than the smoke admin");
    await db.$client.end();
    process.exit(1);
  }

  let [admin] = await db.select({ id: user.id }).from(user).where(eq(user.email, ADMIN_EMAIL));
  if (!admin) {
    [admin] = await db
      .insert(user)
      .values({ id: randomUUID(), name: "Smoke Admin", email: ADMIN_EMAIL, emailVerified: true, role: "admin" })
      .returning({ id: user.id });
    log(`created admin user ${admin.id}`);
  } else {
    log(`reusing admin user ${admin.id}`);
  }

  await db.insert(repository).values({ name: REPOSITORY }).onConflictDoNothing({ target: repository.name });
  log(`repository ${REPOSITORY} is present`);

  const auth = betterAuth({
    secret: required("BETTER_AUTH_SECRET"),
    baseURL: required("BETTER_AUTH_URL"),
    database: drizzleAdapter(db, { provider: "pg", schema: { user, session, account, verification, apikey } }),
    // The app's api-key plugin options (src/server/auth.ts); the hashing defaults must stay identical.
    plugins: [apiKey({ rateLimit: { enabled: false }, enableMetadata: true })],
    telemetry: { enabled: false },
  });
  const created = await auth.api.createApiKey({
    body: { userId: admin.id, name: "smoke", prefix: API_KEY_PREFIX, expiresIn: null },
  });
  await db.insert(apiKeyPermission).values({ apiKeyId: created.id, repository: REPOSITORY, groupPrefix: null, access: "write" });
  log(`created API key ${created.id} with write access to ${REPOSITORY}`);

  process.stdout.write(`${created.key}\n`);
} finally {
  await db.$client.end();
}
