import { z } from "zod";
import { isValidGroupPrefix } from "./names";

/** The three kinds of cleanup rule a repository can have. */
export const POLICY_KINDS = ["keep_last_snapshot_builds", "delete_stale_snapshots", "delete_not_downloaded"] as const;

export type PolicyKind = (typeof POLICY_KINDS)[number];

/** Labels and help text per kind, for the policy dialog. */
export const POLICY_KIND_INFO: Record<PolicyKind, { title: string; description: string; unit: "builds" | "days" }> = {
  keep_last_snapshot_builds: {
    title: "Keep last N snapshot builds",
    description: "Deletes older builds of every -SNAPSHOT version and keeps the newest N.",
    unit: "builds",
  },
  delete_stale_snapshots: {
    title: "Delete stale snapshots",
    description: "Deletes whole -SNAPSHOT versions nobody has published to for X days.",
    unit: "days",
  },
  delete_not_downloaded: {
    title: "Delete not downloaded",
    description: "Deletes versions nobody has downloaded for X days. Snapshots only, unless releases are included.",
    unit: "days",
  },
};

/** Highest value the server accepts (100 years of days). */
export const POLICY_VALUE_MAX = 36_500;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One-line, human description of a rule, e.g. "Keep the last 5 builds of each snapshot". */
export function describePolicy(policy: { kind: PolicyKind; value: number; includeReleases: boolean }): string {
  switch (policy.kind) {
    case "keep_last_snapshot_builds":
      return policy.value === 1
        ? "Keep the last build of each snapshot"
        : `Keep the last ${policy.value} builds of each snapshot`;
    case "delete_stale_snapshots":
      return `Delete snapshots not published to for ${plural(policy.value, "day")}`;
    case "delete_not_downloaded":
      return `Delete ${policy.includeReleases ? "snapshots and releases" : "snapshots"} not downloaded for ${plural(policy.value, "day")}`;
  }
}

/** The add/edit policy form. `groupPrefix` is free text; empty means every group. */
export const policyFormSchema = z.object({
  kind: z.enum(POLICY_KINDS),
  value: z
    .number({ error: "Enter a number" })
    .int("Enter a whole number")
    .min(1, "Must be at least 1")
    .max(POLICY_VALUE_MAX, `Must be at most ${POLICY_VALUE_MAX}`),
  groupPrefix: z
    .string()
    .trim()
    .refine((value) => value === "" || isValidGroupPrefix(value), "Not a valid group, e.g. com.acme"),
  includeReleases: z.boolean(),
  enabled: z.boolean(),
});

export type PolicyFormValues = z.infer<typeof policyFormSchema>;

/** The `policies.upsert` input for the form values; `id` updates an existing policy. */
export function toPolicyInput(repository: string, id: string | undefined, values: PolicyFormValues) {
  const prefix = values.groupPrefix.trim();
  return {
    repository,
    ...(id ? { id } : {}),
    kind: values.kind,
    value: values.value,
    groupPrefix: prefix === "" ? null : prefix,
    includeReleases: values.kind === "delete_not_downloaded" && values.includeReleases,
    enabled: values.enabled,
  };
}
