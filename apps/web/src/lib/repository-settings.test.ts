import { describe, expect, it } from "vitest";
import { NEW_REPOSITORY_DEFAULTS, repositorySettingsSchema, toRepositoryInput } from "./repository-settings";

describe("repositorySettingsSchema", () => {
  const valid = { ...NEW_REPOSITORY_DEFAULTS, name: "team-private" };

  it("accepts the defaults with a valid name", () => {
    expect(repositorySettingsSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects bad names and priorities", () => {
    for (const name of ["", "Team", "-x", "a_b", "a".repeat(64)]) {
      expect(repositorySettingsSchema.safeParse({ ...valid, name }).success, name).toBe(false);
    }
    for (const resolutionPriority of [-1, 1.5, Number.NaN, 100_001]) {
      expect(repositorySettingsSchema.safeParse({ ...valid, resolutionPriority }).success, String(resolutionPriority)).toBe(false);
    }
  });
});

describe("toRepositoryInput", () => {
  it("stores an empty description as null and trims", () => {
    expect(toRepositoryInput({ ...NEW_REPOSITORY_DEFAULTS, name: " main ", description: "  " })).toMatchObject({
      name: "main",
      description: null,
    });
    expect(toRepositoryInput({ ...NEW_REPOSITORY_DEFAULTS, name: "main", description: " Shared protos " }).description).toBe(
      "Shared protos",
    );
  });
});
