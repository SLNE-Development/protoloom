import { formatBytes } from "@/lib/browse";
import { CodeBlock } from "./code-block";

/** A .proto file, syntax highlighted with line numbers (server rendered, follows light/dark). */
export function ProtoViewer({ path, content }: { path: string; content: string }) {
  // Shiki would render the final newline as an empty last line.
  const shown = content.replace(/\n$/, "");
  const lines = shown.split("\n").length;
  return (
    <CodeBlock
      testId="proto-viewer"
      code={shown}
      lang="proto"
      lineNumbers
      copyLabel={`Copy ${path}`}
      title={<span title={path}>{path}</span>}
      extra={
        <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums sm:inline">
          {lines} lines · {formatBytes(new TextEncoder().encode(content).length)}
        </span>
      }
    />
  );
}
