import { run } from "./cli.js";

process.exitCode = await run(
  process.argv.slice(2),
  process.env,
  { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
  process.cwd(),
);
