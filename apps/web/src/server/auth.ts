import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { account, apikey, session, user, verification, type Db } from "@protoloom/db";
import { env, type Env } from "../env";
import { isSecureUrl } from "./invite";
import { createUserGate } from "./user-gate";

/** The part of the environment the auth configuration depends on. */
export type AuthEnv = Pick<
  Env,
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_URL"
  | "INITIAL_ADMIN"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "DISCORD_CLIENT_ID"
  | "DISCORD_CLIENT_SECRET"
>;

type SocialEnv = Pick<AuthEnv, "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET" | "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET">;

export type SocialProviderId = "github" | "discord";

/** Providers whose client id and secret are both configured, in display order. */
export function getEnabledSocialProviders(source: SocialEnv = env): SocialProviderId[] {
  const enabled: SocialProviderId[] = [];
  if (source.GITHUB_CLIENT_ID && source.GITHUB_CLIENT_SECRET) enabled.push("github");
  if (source.DISCORD_CLIENT_ID && source.DISCORD_CLIENT_SECRET) enabled.push("discord");
  return enabled;
}

/**
 * Per-provider options. Sign-up stays possible only through the user gate: a sign-in creates a
 * user only when the client asks for it explicitly (`requestSignUp: true`, implicit sign-up is
 * disabled) and the gate then approves it (invite or first admin).
 */
function socialProviders(source: SocialEnv) {
  const providers: {
    github?: { clientId: string; clientSecret: string; disableImplicitSignUp: true };
    discord?: { clientId: string; clientSecret: string; disableImplicitSignUp: true };
  } = {};
  if (source.GITHUB_CLIENT_ID && source.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: source.GITHUB_CLIENT_ID,
      clientSecret: source.GITHUB_CLIENT_SECRET,
      disableImplicitSignUp: true,
    };
  }
  if (source.DISCORD_CLIENT_ID && source.DISCORD_CLIENT_SECRET) {
    providers.discord = {
      clientId: source.DISCORD_CLIENT_ID,
      clientSecret: source.DISCORD_CLIENT_SECRET,
      disableImplicitSignUp: true,
    };
  }
  return providers;
}

/**
 * Better Auth options for Protoloom: OAuth only (GitHub, Discord), no email/password, roles
 * `admin | maintainer | viewer` through the admin plugin, API keys without rate limiting (Gradle
 * builds must not be throttled), user creation behind the invite / first-admin gate, and account
 * linking only explicitly through `linkSocial` while signed in.
 */
export function buildAuthOptions(db: Db, source: AuthEnv = env) {
  const gate = createUserGate({ db, secret: source.BETTER_AUTH_SECRET, initialAdmin: source.INITIAL_ADMIN });
  return {
    secret: source.BETTER_AUTH_SECRET,
    // BETTER_AUTH_URL is the only source of the public URL: behind the proxy / tunnel requests
    // arrive over plain http, so nothing is derived from the Host or X-Forwarded-* headers.
    baseURL: source.BETTER_AUTH_URL,
    trustedOrigins: [new URL(source.BETTER_AUTH_URL).origin],
    advanced: {
      useSecureCookies: isSecureUrl(source.BETTER_AUTH_URL),
      trustedProxyHeaders: false,
    },
    database: drizzleAdapter(db, { provider: "pg", schema: { user, session, account, verification, apikey } }),
    socialProviders: socialProviders(source),
    user: { validateUserInfo: gate.validateUserInfo },
    databaseHooks: gate.databaseHooks,
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: [],
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
      },
    },
    plugins: [
      admin({
        roles: { admin: adminAc, maintainer: userAc, viewer: userAc },
        defaultRole: "viewer",
        adminRoles: ["admin"],
      }),
      apiKey({ rateLimit: { enabled: false }, enableMetadata: true }),
      nextCookies(),
    ],
  } satisfies BetterAuthOptions;
}

/** A Better Auth instance bound to `db`. */
export function createAuth(db: Db, source: AuthEnv = env) {
  return betterAuth(buildAuthOptions(db, source));
}

export type Auth = ReturnType<typeof createAuth>;
