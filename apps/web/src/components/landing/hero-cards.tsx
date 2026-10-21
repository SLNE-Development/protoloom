"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@protoloom/ui/components/tabs";
import { cn } from "@protoloom/ui/lib/utils";
import { codeClasses } from "./code-block";
import { KindPill } from "./layout";

export interface HighlightedFile {
  /** Tab label and tree entry. */
  name: string;
  html: string;
}

const cardClass =
  "overflow-hidden rounded-lg border bg-background shadow-[0_18px_40px_-18px_rgb(0_0_0/0.35)] dark:shadow-[0_18px_40px_-18px_rgb(0_0_0/0.8)]";

const tabListClass = "h-auto w-auto min-w-0 flex-1 justify-start gap-0.5 overflow-x-auto rounded-none border-b bg-surface p-0 px-2";

const tabClass = cn(
  "h-auto flex-none rounded-none border-0 border-b-[1.5px] border-transparent px-2.5 py-2 font-mono text-xs font-normal text-muted-foreground shadow-none",
  "-mb-px data-[state=active]:border-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none",
  "dark:data-[state=active]:border-foreground dark:data-[state=active]:bg-background",
);

/** File tabs styled like the editor tabs of the app's proto viewer. */
function FileTabs({
  files,
  value,
  onValueChange,
  label,
  extra,
  className,
  codeClassName,
}: {
  files: HighlightedFile[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  extra?: React.ReactNode;
  className?: string;
  codeClassName?: string;
}) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className={cn("gap-0", className)}>
      <div className="flex items-center border-b bg-surface pr-2">
        <TabsList variant="line" aria-label={label} className={cn(tabListClass, "border-b-0")}>
          {files.map((file) => (
            <TabsTrigger key={file.name} value={file.name} className={tabClass}>
              {file.name}
            </TabsTrigger>
          ))}
        </TabsList>
        {extra && (
          // Sits over tabs that scroll underneath, with a short fade on its left edge.
          <div className="relative z-10 ml-auto shrink-0 bg-surface pl-2 shadow-[-14px_0_10px_-4px_var(--surface)]">{extra}</div>
        )}
      </div>
      {files.map((file) => (
        <TabsContent key={file.name} value={file.name} className={cn(codeClasses, "mt-0", codeClassName)}>
          <div dangerouslySetInnerHTML={{ __html: file.html }} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/**
 * The hero's two layered cards: a Gradle build file behind, the proto viewer in front. From xl up
 * they overlap; below that they stack. Both have working tabs; the tree selects files too.
 */
export function HeroCards({
  gradleFiles,
  protoFiles,
  protoTree,
}: {
  gradleFiles: HighlightedFile[];
  protoFiles: HighlightedFile[];
  /** Folder names above the files, outermost first, e.g. ["surf", "economy", "v1"]. */
  protoTree: string[];
}) {
  const [gradle, setGradle] = useState(gradleFiles[0]!.name);
  const [proto, setProto] = useState(protoFiles[1]?.name ?? protoFiles[0]!.name);

  return (
    <div className="relative flex w-full max-w-[640px] flex-col gap-4 xl:block xl:h-[452px] xl:max-w-none">
      <div className={cn(cardClass, "xl:absolute xl:top-0 xl:left-0 xl:w-[62%]")}>
        <FileTabs files={gradleFiles} value={gradle} onValueChange={setGradle} label="Gradle build files" codeClassName="xl:h-[264px]" />
      </div>

      <div className={cn(cardClass, "xl:absolute xl:top-[112px] xl:right-0 xl:w-[84%]")}>
        <div className="grid sm:grid-cols-[136px_minmax(0,1fr)]">
          <ul aria-label="Files" className="hidden border-r bg-surface py-2.5 sm:block font-mono text-xs leading-[1.9] text-muted-foreground">
            {protoTree.map((folder, depth) => (
              <li key={folder} className="truncate px-3" style={{ paddingLeft: `${10 + depth * 6}px` }}>
                {folder}/
              </li>
            ))}
            {protoFiles.map((file) => (
              <li key={file.name}>
                <button
                  type="button"
                  onClick={() => setProto(file.name)}
                  aria-pressed={proto === file.name}
                  className={cn(
                    "w-full truncate pr-3 text-left transition-colors hover:text-foreground focus-visible:bg-accent focus-visible:outline-none",
                    proto === file.name && "bg-accent text-foreground",
                  )}
                  style={{ paddingLeft: `${10 + protoTree.length * 6}px` }}
                >
                  {file.name}
                </button>
              </li>
            ))}
          </ul>
          <FileTabs
            files={protoFiles}
            value={proto}
            onValueChange={setProto}
            label="Proto files of economy-contracts 1.4.0"
            extra={<KindPill kind="release" />}
            className="min-w-0"
            codeClassName="h-[300px] overflow-y-auto"
          />
        </div>
      </div>
    </div>
  );
}
