import { describe, expect, it } from "vitest";
import { createAppEnv } from "./env";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_PATH: "./data",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
};
const github = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };

describe("createAppEnv", () => {
  it("accepts a complete configuration with one provider", () => {
    const env = createAppEnv({ ...base, ...github });
    expect(env.GITHUB_CLIENT_ID).toBe("id");
    expect(env.DISCORD_CLIENT_ID).toBeUndefined();
  });

  it("throws when GITHUB_CLIENT_ID is set without its secret", () => {
    expect(() => createAppEnv({ ...base, GITHUB_CLIENT_ID: "id", DISCORD_CLIENT_ID: "d", DISCORD_CLIENT_SECRET: "s" })).toThrow(
      /GITHUB_CLIENT_SECRET/,
    );
  });

  it("throws when a Discord secret is set without its id", () => {
    expect(() => createAppEnv({ ...base, ...github, DISCORD_CLIENT_SECRET: "s" })).toThrow(/DISCORD_CLIENT_ID/);
  });

  it("refuses to start without any OAuth provider", () => {
    expect(() => createAppEnv(base)).toThrow(/at least one OAuth provider/);
  });

  it("treats empty strings as unset", () => {
    const env = createAppEnv({ ...base, ...github, DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "", INITIAL_ADMIN: "" });
    expect(env.DISCORD_CLIENT_ID).toBeUndefined();
    expect(env.INITIAL_ADMIN).toBeUndefined();
  });

  it("validates the INITIAL_ADMIN format", () => {
    expect(createAppEnv({ ...base, ...github, INITIAL_ADMIN: "github:Octo-Cat" }).INITIAL_ADMIN).toBe("github:Octo-Cat");
    expect(createAppEnv({ ...base, ...github, INITIAL_ADMIN: "discord:80351110224678912" }).INITIAL_ADMIN).toBe(
      "discord:80351110224678912",
    );
    expect(() => createAppEnv({ ...base, ...github, INITIAL_ADMIN: "octo" })).toThrow(/INITIAL_ADMIN/);
    expect(() => createAppEnv({ ...base, ...github, INITIAL_ADMIN: "discord:octo" })).toThrow(/INITIAL_ADMIN/);
    expect(() => createAppEnv({ ...base, ...github, INITIAL_ADMIN: "gitlab:octo" })).toThrow(/INITIAL_ADMIN/);
  });

  it("skips validation only when SKIP_ENV_VALIDATION is 1 or true", () => {
    expect(() => createAppEnv({ SKIP_ENV_VALIDATION: "1" })).not.toThrow();
    expect(() => createAppEnv({ SKIP_ENV_VALIDATION: "true" })).not.toThrow();
    expect(() => createAppEnv({ SKIP_ENV_VALIDATION: "0" })).toThrow(/Invalid environment variables/);
    expect(() => createAppEnv({ SKIP_ENV_VALIDATION: "false" })).toThrow(/Invalid environment variables/);
  });

  it("accepts an optional VALKEY_URL and validates it as a URL", () => {
    expect(createAppEnv({ ...base, ...github }).VALKEY_URL).toBeUndefined();
    expect(createAppEnv({ ...base, ...github, VALKEY_URL: "redis://localhost:6379" }).VALKEY_URL).toBe("redis://localhost:6379");
    expect(() => createAppEnv({ ...base, ...github, VALKEY_URL: "not a url" })).toThrow(/VALKEY_URL/);
  });
});
