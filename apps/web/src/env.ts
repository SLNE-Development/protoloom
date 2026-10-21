import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/** `github:<login>` (GitHub login rules) or `discord:<numeric user id>`. */
export const INITIAL_ADMIN_PATTERN = /^(github:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})|discord:\d{1,20})$/;

const server = {
  DATABASE_URL: z.url(),
  STORAGE_DRIVER: z.enum(["local", "s3"]),
  STORAGE_LOCAL_PATH: z.string().optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  VALKEY_URL: z.url().optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  INITIAL_ADMIN: z
    .string()
    .regex(INITIAL_ADMIN_PATTERN, "must be github:<login> or discord:<user id>")
    .optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
};

type ServerKey = keyof typeof server;

const SERVER_KEYS = Object.keys(server) as ServerKey[];

/** OAuth providers whose client id and secret must be configured together. */
const OAUTH_PAIRS = [
  ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
] as const;

/**
 * Validates the server environment from `source`. Empty strings count as unset, each OAuth
 * provider needs both its id and its secret or neither, at least one provider must be complete
 * (login is OAuth only), and validation is skipped entirely when `SKIP_ENV_VALIDATION` is `1` or `true`
 * (Docker image builds). Throws an error naming the offending variables, never their values.
 */
export function createAppEnv(source: Record<string, string | undefined>) {
  const runtimeEnv = Object.fromEntries(SERVER_KEYS.map((key) => [key, source[key]])) as Record<
    ServerKey,
    string | undefined
  >;
  return createEnv({
    server,
    runtimeEnv,
    emptyStringAsUndefined: true,
    skipValidation: source.SKIP_ENV_VALIDATION === "1" || source.SKIP_ENV_VALIDATION === "true",
    onValidationError: (issues) => {
      const details = issues
        .map((issue) => `${issue.path?.map(String).join(".") || "(env)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid environment variables: ${details}`);
    },
    createFinalSchema: () =>
      z.object(server).superRefine((values, ctx) => {
        let complete = 0;
        for (const [idKey, secretKey] of OAUTH_PAIRS) {
          if (values[idKey] && values[secretKey]) complete++;
          if (Boolean(values[idKey]) !== Boolean(values[secretKey])) {
            ctx.addIssue({
              code: "custom",
              path: [values[idKey] ? secretKey : idKey],
              message: `${idKey} and ${secretKey} must be set together`,
            });
          }
        }
        if (complete === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["GITHUB_CLIENT_ID"],
            message: "configure at least one OAuth provider (GitHub or Discord); login is OAuth only",
          });
        }
      }),
  });
}

/** The validated server environment. Server code reads configuration only from here. */
export type Env = ReturnType<typeof createAppEnv>;

export const env: Env = createAppEnv(process.env);
