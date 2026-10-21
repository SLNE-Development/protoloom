import { getServerContext } from "@/server/context";
import { buildParam, handle, versionCoordinate, type VersionParams } from "@/server/http";
import { getPrincipal } from "@/server/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<VersionParams> };

/** Headers describing an archive of `size` bytes. */
function archiveHeaders(size: number, sha256: string, filename: string): HeadersInit {
  return {
    "content-type": "application/gzip",
    "content-length": String(size),
    "content-disposition": `attachment; filename="${filename}"`,
    "x-protoloom-sha256": sha256,
    "cache-control": "private, no-store",
  };
}

/**
 * `GET`: the tar.gz archive of a version's newest build, or of build `?build=<n>` (404 once that
 * build is gone), with its SHA-256 in `x-protoloom-sha256`. Counts as a download.
 */
export const GET = handle(async (req: Request, { params }: Context) => {
  const p = await params;
  const c = versionCoordinate(p);
  const ctx = getServerContext();
  const principal = await getPrincipal(req, ctx);
  const buildNumber = buildParam(req);
  const { data, sha256, filename } = await ctx.registry.download(principal, p.repo, c, { buildNumber });
  return new Response(new Uint8Array(data), { status: 200, headers: archiveHeaders(data.length, sha256, filename) });
});

/**
 * `HEAD`: the headers `GET` would send, without the body. Defined explicitly because Next.js
 * would otherwise answer HEAD by running `GET`, which counts a download.
 */
export const HEAD = handle(async (req: Request, { params }: Context) => {
  const p = await params;
  const c = versionCoordinate(p);
  const ctx = getServerContext();
  const principal = await getPrincipal(req, ctx);
  const buildNumber = buildParam(req);
  const info = await ctx.registry.getManifest(principal, p.repo, c, { buildNumber });
  return new Response(null, {
    status: 200,
    headers: archiveHeaders(info.sizeBytes, info.sha256, `${c.name}-${c.version}.tar.gz`),
  });
});
