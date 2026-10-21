import { getServerContext } from "@/server/context";
import { checkArtifactParams, handle, json, type ArtifactParams } from "@/server/http";
import { getPrincipal } from "@/server/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET`: the versions of an artifact, newest first, as `{ versions }`. */
export const GET = handle(async (req: Request, { params }: { params: Promise<ArtifactParams> }) => {
  const p = await params;
  checkArtifactParams(p);
  const ctx = getServerContext();
  const principal = await getPrincipal(req, ctx);
  const versions = await ctx.registry.listVersions(principal, p.repo, p.group, p.name);
  return json({ versions });
});
