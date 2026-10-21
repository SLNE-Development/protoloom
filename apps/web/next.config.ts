import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Secrets live only in the repo-root `.env`. Load it before anything reads the environment;
// `src/env.ts` validates it when the server starts (instrumentation) and refuses to boot if invalid.
// forceReload: Next has already loaded (and cached) the env files of apps/web by the time this runs.
loadEnvConfig(monorepoRoot, process.env.NODE_ENV !== "production", undefined, true);

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  transpilePackages: ["@protoloom/ui"],
  serverExternalPackages: ["pg"],
  // Workspace packages are bundled but read files at runtime that the tracer cannot see:
  // @protoloom/db its SQL migrations, @protoloom/core the buf binary of the installed platform package.
  outputFileTracingIncludes: {
    "/*": [
      "../../packages/db/drizzle/**/*",
      "../../packages/core/node_modules/@bufbuild/buf/package.json",
      "../../node_modules/.pnpm/@bufbuild+buf*/node_modules/@bufbuild/*/package.json",
      "../../node_modules/.pnpm/@bufbuild+buf*/node_modules/@bufbuild/*/bin/**/*",
    ],
    // Share cards (any route's opengraph-image, /og/**) read these fonts through apps/web/node_modules.
    "/**": [
      "./node_modules/@fontsource/geist/files/geist-latin-{400,600}-normal.woff",
      "./node_modules/@fontsource/geist-mono/files/geist-mono-latin-{400,500}-normal.woff",
    ],
    // The sitemap lists the docs pages by reading content/docs at request time.
    "/sitemap.xml": ["./content/docs/**/*.md"],
  },
};

export default config;
