import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Secrets live only in the repo-root `.env`. Load it before anything reads the environment;
// `src/env.ts` validates it when the server starts (instrumentation) and refuses to boot if invalid.
loadEnvConfig(monorepoRoot, process.env.NODE_ENV !== "production");

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  transpilePackages: ["@protoloom/ui"],
  // Server-only workspace packages run as plain Node modules: @protoloom/db locates its SQL
  // migrations and @protoloom/core its buf binary on disk relative to their own files.
  serverExternalPackages: ["pg", "@protoloom/db", "@protoloom/core"],
  outputFileTracingIncludes: { "/*": ["../../packages/db/drizzle/**/*"] },
};

export default config;
