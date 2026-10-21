import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

// The sitemap URL comes from BETTER_AUTH_URL at runtime, not from the build environment.
export const dynamic = "force-dynamic";

/** robots.txt: the landing page, docs and public browse pages are crawlable; the API and signed-in areas aren't. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/docs", "/browse"],
        disallow: ["/api", "/dashboard", "/keys", "/repositories", "/admin", "/account", "/invite", "/login"],
      },
    ],
    sitemap: siteUrl("/sitemap.xml"),
    host: new URL(siteUrl()).origin,
  };
}
