import config from "@protoloom/config/eslint";
export default [
  ...config,
  { ignores: ["next-env.d.ts"] },
  // Plain Node.js scripts (seed-smoke.mjs) run outside Next.js.
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly" } } },
];
