import { z } from "zod";
import { formatCoordinate, isValidGroup, isValidName, parseCoordinate } from "@protoloom/core";
import { getServerContext } from "@/server/context";
import { archiveUrl, handle, invalidRequest, json, readJson } from "@/server/http";
import { getPrincipal } from "@/server/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

function isArtifactKey(s: string): boolean {
  const parts = s.split(":");
  return parts.length === 2 && isValidGroup(parts[0] as string) && isValidName(parts[1] as string);
}

const bodySchema = z.object({
  repositories: z.array(z.string()).max(100),
  dependencies: z.array(z.string()).max(1000),
  exclude: z.array(z.string().refine(isArtifactKey, "Expected group:name")).max(1000).optional(),
});

/**
 * `POST`: resolves `dependencies` (`group:name:version`) and their transitive dependencies across
 * `repositories` in order, as seen by the caller. `exclude` lists `group:name` keys provided
 * externally (local modules): they and their dependency subtrees are left out. Answers
 * `{ artifacts, conflicts }`, each artifact with the absolute URL of the resolved build's archive.
 */
export const POST = handle(async (req: Request) => {
  const ctx = getServerContext();
  const principal = await getPrincipal(req, ctx);
  const parsed = bodySchema.safeParse(await readJson(req, MAX_BODY_BYTES));
  if (!parsed.success) {
    throw invalidRequest("Invalid resolve request", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const { repositories, dependencies, exclude } = parsed.data;
  const roots = dependencies.map(parseCoordinate);
  const resolution = await ctx.registry.resolve(principal, repositories, roots, { exclude: new Set(exclude) });
  return json({
    artifacts: resolution.nodes.map((node) => ({
      repository: node.repository,
      coordinate: formatCoordinate(node.coordinate),
      group: node.coordinate.group,
      name: node.coordinate.name,
      version: node.coordinate.version,
      buildNumber: node.buildNumber,
      sha256: node.sha256,
      archiveUrl: archiveUrl(node.repository, node.coordinate, node.buildNumber),
    })),
    conflicts: resolution.conflicts,
  });
});
