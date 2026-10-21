import { artifactCard, type ArtifactCardParams } from "@/lib/og-artifact";
import { renderOgCard } from "@/lib/og";
import { getServerContext } from "@/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<ArtifactCardParams> };

/**
 * Share card (PNG, 1200×630) of an artifact version; `version` may be `latest`. Private and unknown
 * artifacts get the generic Protoloom card. Cached briefly: versions, visibility and `latest` change.
 */
export async function GET(_req: Request, { params }: Context): Promise<Response> {
  const card = await artifactCard(getServerContext().registry, await params);
  return renderOgCard(card, { headers: { "cache-control": "public, max-age=300, s-maxage=300" } });
}
