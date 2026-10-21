import { describe, expect, it } from "vitest";
import { describePolicy, policyFormSchema, toPolicyInput } from "./cleanup-policies";

describe("describePolicy", () => {
  it("phrases each kind with its value", () => {
    expect(describePolicy({ kind: "keep_last_snapshot_builds", value: 5, includeReleases: false })).toBe(
      "Keep the last 5 builds of each snapshot",
    );
    expect(describePolicy({ kind: "keep_last_snapshot_builds", value: 1, includeReleases: false })).toBe(
      "Keep the last build of each snapshot",
    );
    expect(describePolicy({ kind: "delete_stale_snapshots", value: 30, includeReleases: false })).toBe(
      "Delete snapshots not published to for 30 days",
    );
    expect(describePolicy({ kind: "delete_not_downloaded", value: 1, includeReleases: false })).toBe(
      "Delete snapshots not downloaded for 1 day",
    );
    expect(describePolicy({ kind: "delete_not_downloaded", value: 90, includeReleases: true })).toBe(
      "Delete snapshots and releases not downloaded for 90 days",
    );
  });
});

describe("policyFormSchema", () => {
  const valid = { kind: "delete_stale_snapshots", value: 30, groupPrefix: "", includeReleases: false, enabled: true } as const;

  it("accepts an empty group prefix and a valid one", () => {
    expect(policyFormSchema.safeParse(valid).success).toBe(true);
    expect(policyFormSchema.safeParse({ ...valid, groupPrefix: "com.acme" }).success).toBe(true);
  });

  it("rejects an invalid group prefix, a missing value and values out of range", () => {
    expect(policyFormSchema.safeParse({ ...valid, groupPrefix: "Com..acme" }).success).toBe(false);
    expect(policyFormSchema.safeParse({ ...valid, value: Number.NaN }).success).toBe(false);
    expect(policyFormSchema.safeParse({ ...valid, value: 0 }).success).toBe(false);
    expect(policyFormSchema.safeParse({ ...valid, value: 1.5 }).success).toBe(false);
    expect(policyFormSchema.safeParse({ ...valid, value: 36_501 }).success).toBe(false);
  });
});

describe("toPolicyInput", () => {
  it("maps an empty prefix to null and drops includeReleases for kinds that ignore it", () => {
    expect(
      toPolicyInput("main", "7d5a3b7e-8f1c-4c55-9a51-111111111111", {
        kind: "keep_last_snapshot_builds",
        value: 3,
        groupPrefix: " ",
        includeReleases: true,
        enabled: false,
      }),
    ).toEqual({
      repository: "main",
      id: "7d5a3b7e-8f1c-4c55-9a51-111111111111",
      kind: "keep_last_snapshot_builds",
      value: 3,
      groupPrefix: null,
      includeReleases: false,
      enabled: false,
    });
    expect(
      toPolicyInput("main", undefined, {
        kind: "delete_not_downloaded",
        value: 90,
        groupPrefix: "com.acme",
        includeReleases: true,
        enabled: true,
      }),
    ).toEqual({
      repository: "main",
      kind: "delete_not_downloaded",
      value: 90,
      groupPrefix: "com.acme",
      includeReleases: true,
      enabled: true,
    });
  });
});
