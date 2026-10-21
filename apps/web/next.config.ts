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
  serverExternalPackages: ["pg"],
  // Workspace packages are bundled; @protoloom/db reads its SQL migrations from disk at runtime.
  outputFileTracingIncludes: { "/*": ["../../packages/db/drizzle/**/*"] },
};

export default config;
