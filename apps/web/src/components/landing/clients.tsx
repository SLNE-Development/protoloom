import Link from "next/link";
import { CodeHtml } from "./code-block";
import { highlight } from "./highlight";
import { Section, SectionHead } from "./layout";
import { CLI_PACKAGE_JSON, CLIENT_GRADLE, cliConfig } from "./samples";

function ClientCard({
  title,
  files,
  docs,
  footer,
  children,
}: {
  title: string;
  files: string;
  docs: string;
  footer: string;
  children: React.ReactNode;
}) {
  return (
    <article className="grid min-w-0 grid-rows-[auto_1fr_auto] overflow-hidden rounded-lg border">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
        <h3 className="font-semibold">
          <Link href={docs} className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            {title}
          </Link>
        </h3>
        <span className="font-mono text-xs text-muted-foreground">{files}</span>
      </header>
      <div className="min-w-0 bg-surface">{children}</div>
      <footer className="overflow-x-auto border-t px-4 py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground">{footer}</footer>
    </article>
  );
}

/** Gradle plugin and Node CLI side by side, with this instance's URL in the CLI config. */
export async function Clients({ origin }: { origin: string }) {
  const [gradle, config, pkg] = await Promise.all([
    highlight(CLIENT_GRADLE, "kotlin"),
    highlight(cliConfig(origin), "json"),
    highlight(CLI_PACKAGE_JSON, "json"),
  ]);

  return (
    <Section label="clients-title">
      <SectionHead id="clients-title" eyebrow="Clients" title="Gradle for JVM projects, a small CLI for Node.">
        Both clients produce the same merged proto folder, so protoc, buf, protobuf-es or your own generator can pick it
        up.
      </SectionHead>
      <div className="grid gap-4 lg:grid-cols-2">
        <ClientCard
          title="Gradle plugin"
          files="build.gradle.kts"
          docs="/docs/gradle"
          footer="./gradlew publishProtos · ./gradlew fetchProtos"
        >
          <CodeHtml html={gradle} label="build.gradle.kts" />
        </ClientCard>
        <ClientCard title="Node CLI" files="weaver.json · package.json" docs="/docs/cli" footer="WEAVER_TOKEN=… pnpm protos">
          <CodeHtml html={config} label="weaver.json" />
          <p className="border-t px-4 pt-3 font-mono text-xs text-muted-foreground">package.json</p>
          <CodeHtml html={pkg} label="package.json" className="[&_pre]:pt-1.5" />
        </ClientCard>
      </div>
    </Section>
  );
}
