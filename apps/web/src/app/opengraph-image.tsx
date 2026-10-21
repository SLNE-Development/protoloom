import { renderOgCard } from "@/lib/og";
import { OG_IMAGE_SIZE } from "@/lib/seo";

// The footer shows the instance host from BETTER_AUTH_URL, so render at request time.
export const dynamic = "force-dynamic";
export const alt = "Protoloom: versioned .proto contracts for every build";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

/** Share card of the landing page. */
export default function OpengraphImage() {
  return renderOgCard(
    {
      eyebrow: "Protobuf artifact registry",
      title: "Versioned .proto contracts for every build.",
      subtitle: "Publish from Gradle, checked on publish, fetched with all dependencies by Gradle and Node builds.",
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
