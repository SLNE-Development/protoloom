import { formatBytes } from "@/lib/browse";
import { HIGHLIGHT_MAX_BYTES } from "@/server/highlight";
import { CodeBlock } from "./code-block";
import { CopyFileButton } from "./copy-file-button";

/**
 * A .proto file of a version with line numbers (server rendered, follows light/dark). Highlighted
 * HTML is cached per build checksum and path; files above the highlight limit are shown as plain
 * text. Copy fetches the file on demand instead of shipping it to the client as a prop.
 */
export function ProtoViewer({
  repository,
  coordinate,
  sha256,
  path,
  content,
}: {
  repository: string;
  coordinate: string;
  /** Checksum of the build the file belongs to (cache key). */
  sha256: string;
  path: string;
  content: string;
}) {
  // Shiki would render the final newline as an empty last line.
  const shown = content.replace(/\n$/, "");
  const lines = shown.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf8");
  return (
    <CodeBlock
      testId="proto-viewer"
      code={shown}
      lang="proto"
      cacheKey={`${sha256}:${path}`}
      lineNumbers
      copy={<CopyFileButton repository={repository} coordinate={coordinate} path={path} />}
      title={<span title={path}>{path}</span>}
      extra={
        <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums sm:inline">
          {bytes > HIGHLIGHT_MAX_BYTES && "plain text · "}
          {lines} lines · {formatBytes(bytes)}
        </span>
      }
    />
  );
}
