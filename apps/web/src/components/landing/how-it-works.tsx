import type { ReactNode } from "react";
import { Terminal } from "./code-block";
import { Section, SectionHead } from "./layout";

function Prompt({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="text-muted-foreground select-none">$ </span>
      {children}
    </>
  );
}

const STEPS: { n: string; title: string; text: string; terminal: ReactNode; label: string }[] = [
  {
    n: "1 · publish",
    title: "Gradle uploads the protos",
    text: "Put .proto files in src/main/proto and run one task. The URL and API key come from the environment, so CI needs no extra setup.",
    label: "Publishing with Gradle",
    terminal: (
      <>
        <Prompt>./gradlew publishProtos</Prompt>
        {"\n"}
        <span className="text-release">✓</span> Published dev.surf.economy:economy-contracts:1.4.0 to releases, build 1
      </>
    ),
  },
  {
    n: "2 · validate",
    title: "Protoloom checks every file",
    text: "Each artifact must compile together with its dependencies, and every import must come from the artifact itself or a declared dependency.",
    label: "A rejected publish",
    terminal: (
      <>
        <Prompt>./gradlew publishProtos</Prompt>
        {"\n"}
        <span className="text-snapshot">✗</span> validation_failed: Proto validation failed
        {"\n  "}surf/protection/v1/region.proto:4: imported file does not exist: surf/economy/v1/money.proto
        {"\n  "}surf/protection/v1/region.proto:6: cannot find `surf.economy.v1.Money` in this scope
      </>
    ),
  },
  {
    n: "3 · fetch",
    title: "Builds pull the whole tree",
    text: "Gradle or the Node CLI asks the server to resolve the dependency tree and writes one merged proto folder your codegen can read.",
    label: "Fetching with Gradle",
    terminal: (
      <>
        <Prompt>./gradlew fetchProtos</Prompt>
        {"\n"}Protoloom: downloading dev.surf.economy:economy-contracts:1.4.0
        {"\n"}Protoloom: downloading dev.surf.core:core-types:2.1.0
        {"\n"}
        <span className="text-release">✓</span> build/protoloom/protos
      </>
    ),
  },
];

/** Publish → validate → fetch, in three columns (stacked on phones). */
export function HowItWorks() {
  return (
    <Section label="how-title">
      <SectionHead id="how-title" eyebrow="How it works" title="From one repository's protos to every build that needs them.">
        The team that owns a contract publishes it. Everyone else depends on an exact version, the same way they depend on
        a Maven library.
      </SectionHead>
      <ol className="grid overflow-hidden rounded-lg border md:grid-cols-3">
        {STEPS.map((step) => (
          <li
            key={step.n}
            className="grid grid-rows-[auto_auto_auto_1fr] gap-2 border-t p-[22px] first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0"
          >
            <span className="font-mono text-xs font-medium text-muted-foreground">{step.n}</span>
            <h3 className="text-base font-semibold">{step.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{step.text}</p>
            <Terminal label={step.label} className="mt-2.5 self-end">
              {step.terminal}
            </Terminal>
          </li>
        ))}
      </ol>
    </Section>
  );
}
