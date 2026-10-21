import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { createDb } from "@protoloom/db";
import { buildAuthOptions, getEnabledSocialProviders, type AuthEnv } from "./auth";

const base: AuthEnv = {
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  INITIAL_ADMIN: undefined,
  GITHUB_CLIENT_ID: undefined,
  GITHUB_CLIENT_SECRET: undefined,
  DISCORD_CLIENT_ID: undefined,
  DISCORD_CLIENT_SECRET: undefined,
};
const github = { GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" };
const discord = { DISCORD_CLIENT_ID: "dc-id", DISCORD_CLIENT_SECRET: "dc-secret" };

// Never connects: the pool opens connections lazily and these tests issue no queries.
const db = createDb("postgres://nobody:nothing@127.0.0.1:1/none");
afterAll(() => db.$client.end());

describe("getEnabledSocialProviders", () => {
  it("returns no providers without OAuth env", () => {
    expect(getEnabledSocialProviders(base)).toEqual([]);
  });

  it("returns only github when only GitHub is configured", () => {
    expect(getEnabledSocialProviders({ ...base, ...github })).toEqual(["github"]);
  });

  it("returns both when both are configured", () => {
    expect(getEnabledSocialProviders({ ...base, ...github, ...discord })).toEqual(["github", "discord"]);
  });
});

describe("buildAuthOptions", () => {
  it("adds only configured providers, each with implicit sign-up disabled", () => {
    const onlyGithub = buildAuthOptions(db, { ...base, ...github });
    expect(Object.keys(onlyGithub.socialProviders)).toEqual(["github"]);

    const both = buildAuthOptions(db, { ...base, ...github, ...discord });
    expect(both.socialProviders.github).toMatchObject({
      clientId: "gh-id",
      clientSecret: "gh-secret",
      disableImplicitSignUp: true,
    });
    expect(both.socialProviders.discord).toMatchObject({
      clientId: "dc-id",
      clientSecret: "dc-secret",
      disableImplicitSignUp: true,
    });
  });

  it("links accounts only explicitly: no trusted providers, no linking by email", () => {
    const { account } = buildAuthOptions(db, { ...base, ...github });
    expect(account.accountLinking).toMatchObject({
      enabled: true,
      trustedProviders: [],
      disableImplicitLinking: true,
      allowUnlinkingAll: false,
    });
  });

  it("takes the base URL, trusted origin and cookie security only from BETTER_AUTH_URL", () => {
    const https = buildAuthOptions(db, { ...base, ...github, BETTER_AUTH_URL: "https://protos.example.com" });
    expect(https.baseURL).toBe("https://protos.example.com");
    expect(https.trustedOrigins).toEqual(["https://protos.example.com"]);
    expect(https.advanced).toEqual({ useSecureCookies: true, trustedProxyHeaders: false });

    const http = buildAuthOptions(db, { ...base, ...github });
    expect(http.baseURL).toBe(base.BETTER_AUTH_URL);
    expect(http.advanced.useSecureCookies).toBe(false);
  });

  it("issues secure session cookies for an https BETTER_AUTH_URL even when requests arrive over http", async () => {
    const auth = betterAuth(buildAuthOptions(db, { ...base, ...github, BETTER_AUTH_URL: "https://protos.example.com" }));
    const ctx = await auth.$context;
    expect(ctx.baseURL).toBe("https://protos.example.com/api/auth");
    expect(ctx.authCookies.sessionToken.name).toBe("__Secure-better-auth.session_token");
    expect(ctx.authCookies.sessionToken.attributes.secure).toBe(true);
  });

  it("has no email and password login", () => {
    const options = buildAuthOptions(db, { ...base, ...github }) as { emailAndPassword?: unknown };
    expect(options.emailAndPassword).toBeUndefined();
  });

  it("gates user creation", () => {
    const options = buildAuthOptions(db, { ...base, ...github });
    expect(options.user.validateUserInfo).toBeTypeOf("function");
    expect(options.databaseHooks.user.create.before).toBeTypeOf("function");
  });
});
