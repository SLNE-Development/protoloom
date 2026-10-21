import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Bundle everything (core and zod are devDependencies) so the published CLI is self-contained.
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node" },
});
