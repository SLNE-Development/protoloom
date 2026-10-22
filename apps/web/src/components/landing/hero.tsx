import Link from "next/link";
import { Button } from "@weaver/ui/components/button";
import type { SocialProviderId } from "@/server/auth";
import type { PublicStats } from "@/lib/public-catalog";
import { HeroCards } from "./hero-cards";
import { highlight } from "./highlight";
import { Container, Eyebrow } from "./layout";
import { HERO_BUILD_GRADLE, HERO_SETTINGS_GRADLE, PROTO_FILES } from "./samples";
import { SignInButtons } from "./sign-in-buttons";

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** First screen: what Weaver is, the way in, and the layered Gradle + proto cards. */
export async function Hero({
  host,
  stats,
  providers,
  showBrowse,
}: {
  host: string;
  /** Public counts; omitted while anonymous view is off. */
  stats: PublicStats | null;
  providers: SocialProviderId[];
  showBrowse: boolean;
}) {
  const [buildGradle, settingsGradle, ...protos] = await Promise.all([
    highlight(HERO_BUILD_GRADLE, "kotlin"),
    highlight(HERO_SETTINGS_GRADLE, "kotlin"),
    ...PROTO_FILES.map((file) => highlight(file.code, "proto", { lineNumbers: true })),
  ]);
  const protoFiles = PROTO_FILES.map((file, i) => ({ name: file.path.split("/").at(-1)!, html: protos[i]! }));

  return (
    <section
      aria-labelledby="hero-title"
      className="border-b bg-[linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] bg-size-[32px_32px] bg-position-[-1px_-1px]"
    >
      <Container className="grid grid-cols-[minmax(0,1fr)] items-center gap-12 py-12 sm:py-16 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:py-[72px]">
        <div className="max-w-[620px] bg-background shadow-[0_0_0_18px_var(--background)] xl:max-w-none">
          <Eyebrow>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-release" />
            <span>{host}</span>
            {stats && (
              <>
                <span aria-hidden="true">·</span>
                <span>{plural(stats.artifacts, "artifact", "artifacts")}</span>
                <span aria-hidden="true">·</span>
                <span>{plural(stats.repositories, "repository", "repositories")}</span>
              </>
            )}
          </Eyebrow>
          <h1
            id="hero-title"
            className="mb-[18px] text-[34px] leading-[1.06] font-semibold tracking-[-0.035em] text-balance sm:text-[42px] xl:text-[46px] xl:leading-[1.04]"
          >
            Versioned .proto contracts for every build.
          </h1>
          <p className="mb-[26px] max-w-[48ch] text-base leading-[1.55] text-muted-foreground">
            Publish protobuf files from Gradle as versioned artifacts. Weaver checks that they compile, resolves their
            dependencies, and hands Kotlin, Java and Node builds exactly the files they need.
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            <SignInButtons providers={providers} />
            {showBrowse && (
              <Button asChild size="lg" variant="outline" className="px-4">
                <Link href="/browse">Browse public repositories</Link>
              </Button>
            )}
            <Link
              href="/docs"
              className="ml-1.5 inline-flex items-center gap-1 rounded-sm text-sm text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Read the docs
              <span aria-hidden="true">→</span>
            </Link>
          </div>
          <ul className="mt-[26px] flex flex-wrap gap-x-[22px] gap-y-2 font-mono text-xs text-muted-foreground">
            <li>
              <b className="font-medium text-foreground">Invite only</b> · ask an admin
            </li>
            <li>
              <b className="font-medium text-foreground">Gradle</b> + <b className="font-medium text-foreground">Node</b> clients
            </li>
            <li>
              <b className="font-medium text-foreground">Self-hosted</b>
            </li>
          </ul>
        </div>
        <HeroCards
          gradleFiles={[
            { name: "build.gradle.kts", html: buildGradle! },
            { name: "settings.gradle.kts", html: settingsGradle! },
          ]}
          protoFiles={protoFiles}
          protoTree={["surf", "economy", "v1"]}
        />
      </Container>
    </section>
  );
}
