import { z } from "zod";
import { isValidRepositoryName } from "./names";

/** Upper bound the server accepts for `resolutionPriority`. */
export const RESOLUTION_PRIORITY_MAX = 100_000;

/** The repository settings form (General); `name` is only edited when creating. */
export const repositorySettingsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the repository a name")
    .refine(isValidRepositoryName, "Use lowercase letters, digits and dashes, starting with a letter or digit"),
  description: z.string().trim().max(500, "At most 500 characters"),
  visibility: z.enum(["public", "private"]),
  allowRedeploy: z.boolean(),
  allowReleases: z.boolean(),
  allowSnapshots: z.boolean(),
  resolutionPriority: z
    .number({ error: "Enter a number" })
    .int("Enter a whole number")
    .min(0, "Must be 0 or more")
    .max(RESOLUTION_PRIORITY_MAX, `Must be at most ${RESOLUTION_PRIORITY_MAX}`),
});

export type RepositorySettingsValues = z.infer<typeof repositorySettingsSchema>;

/** Defaults of a new repository, the same as the database defaults. */
export const NEW_REPOSITORY_DEFAULTS: RepositorySettingsValues = {
  name: "",
  description: "",
  visibility: "private",
  allowRedeploy: false,
  allowReleases: true,
  allowSnapshots: true,
  resolutionPriority: 100,
};

/** The `repositories.create` / `repositories.update` input; an empty description is stored as null. */
export function toRepositoryInput(values: RepositorySettingsValues) {
  const description = values.description.trim();
  return { ...values, name: values.name.trim(), description: description === "" ? null : description };
}
