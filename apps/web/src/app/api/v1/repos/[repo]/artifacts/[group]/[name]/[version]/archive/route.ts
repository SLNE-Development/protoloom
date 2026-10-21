import { getServerContext } from "@/server/context";
import { handle, versionCoordinate, type VersionParams } from "@/server/http";
import { getPrincipal } from "@/server/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET`: the tar.gz archive of a version's newest build, with its SHA-256 in
 * `x-protoloom-sha256`. Counts as a download.
 */
export const GET = handle(async (req: Request, { params }: { params: Promise<VersionParams> }) => {
  const p = await params;
  const c = versionCoordinate(p);
  const ctx = getServerContext();
  const principal = await getPrincipal(req, ctx);
  const { data, sha256, filename } = await ctx.registry.download(principal, p.repo, c);
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(data.length),
      "content-disposition": `attachment; filename="${filename}"`,
      "x-protoloom-sha256": sha256,
      "cache-control": "private, no-store",
    },
  });
});
