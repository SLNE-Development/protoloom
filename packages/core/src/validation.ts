import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProtoFile } from "./archive.js";

/** A single problem found while validating proto files. */
export interface ValidationIssue {
  path: string;
  line?: number;
  column?: number;
  message: string;
}

const require = createRequire(import.meta.url);

const PLATFORM_PACKAGES: Record<string, string> = {
  "win32 arm64": "@bufbuild/buf-win32-arm64",
  "win32 x64": "@bufbuild/buf-win32-x64",
  "darwin arm64": "@bufbuild/buf-darwin-arm64",
  "darwin x64": "@bufbuild/buf-darwin-x64",
  "linux arm64": "@bufbuild/buf-linux-aarch64",
  "linux arm": "@bufbuild/buf-linux-armv7",
  "linux x64": "@bufbuild/buf-linux-x64",
};

/** Resolves the buf executable shipped by the platform package of `@bufbuild/buf`. */
function resolveBufBinary(): string {
  const key = `${process.platform} ${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) throw new Error(`buf is not available for platform ${key}`);
  const bufRequire = createRequire(require.resolve("@bufbuild/buf/package.json"));
  const pkgDir = dirname(bufRequire.resolve(`${pkg}/package.json`));
  return join(pkgDir, "bin", process.platform === "win32" ? "buf.exe" : "buf");
}

interface BufIssue {
  path?: string;
  start_line?: number;
  start_column?: number;
  message?: string;
}

interface BufResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runBuf(cwd: string, args: string[]): Promise<BufResult> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveBufBinary(),
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 });
      },
    );
  });
}

async function writeFiles(root: string, files: ProtoFile[]): Promise<void> {
  for (const file of files) {
    const target = join(root, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

function parseIssues(output: string, files: ProtoFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const raw of output.split("\n")) {
    const text = raw.trim();
    if (!text) continue;
    let parsed: BufIssue;
    try {
      parsed = JSON.parse(text) as BufIssue;
    } catch {
      issues.push({ path: "", message: text });
      continue;
    }
    const normalized = (parsed.path ?? "").replaceAll("\\", "/");
    const issue: ValidationIssue = {
      path: normalized.startsWith("src/") ? normalized.slice("src/".length) : normalized,
      message: parsed.message ?? "Unknown validation error",
    };
    if (parsed.start_line) issue.line = parsed.start_line;
    if (parsed.start_line && /does not exist/.test(issue.message)) {
      // buf omits the import path from this message; recover it from the source line.
      const content = files.find((f) => f.path === issue.path)?.content;
      const source = content?.split("\n")[parsed.start_line - 1];
      const imported = source ? /"([^"]+)"/.exec(source)?.[1] : undefined;
      if (imported) issue.message = `${issue.message}: ${imported}`;
    }
    if (parsed.start_column) issue.column = parsed.start_column;
    issues.push(issue);
  }
  return issues;
}

/**
 * Compiles `files` with buf, resolving imports against `dependencyFiles` and the
 * well-known types. Returns an empty array when everything is valid.
 */
export async function validateProtos(input: {
  files: ProtoFile[];
  dependencyFiles: ProtoFile[];
}): Promise<ValidationIssue[]> {
  const dependencyPaths = new Set(input.dependencyFiles.map((f) => f.path));
  const duplicates = input.files
    .filter((f) => dependencyPaths.has(f.path))
    .map<ValidationIssue>((f) => ({
      path: f.path,
      message: `Duplicate file: ${f.path} is present in both the package and its dependencies`,
    }));
  if (duplicates.length > 0) return duplicates;
  if (input.files.length === 0) return [];

  const root = await mkdtemp(join(tmpdir(), "protoloom-validate-"));
  try {
    await writeFiles(join(root, "src"), input.files);
    await mkdir(join(root, "deps"), { recursive: true });
    await writeFiles(join(root, "deps"), input.dependencyFiles);
    await writeFile(
      join(root, "buf.yaml"),
      "version: v2\nmodules:\n  - path: src\n  - path: deps\n",
      "utf8",
    );
    const result = await runBuf(root, [
      "build",
      ...input.files.flatMap((f) => ["--path", `src/${f.path}`]),
      "--error-format",
      "json",
      "-o",
      "-",
    ]);
    if (result.code === 0) return [];
    const issues = parseIssues(result.stderr || result.stdout, input.files);
    return issues.length > 0
      ? issues
      : [{ path: "", message: `buf exited with code ${result.code}` }];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
