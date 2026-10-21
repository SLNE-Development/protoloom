import { Container } from "./layout";

const FEATURES = [
  {
    icon: "1.4",
    title: "Immutable releases",
    text: "A release never changes unless its repository allows redeploy. Snapshots get numbered builds, and the latest one wins.",
  },
  {
    icon: "✓",
    title: "Checked on publish",
    text: "Artifacts that don't compile, or that import files from undeclared dependencies, are rejected. The build log names each file, line and problem.",
  },
  {
    icon: "→",
    title: "Dependency resolution",
    text: "The server resolves the whole tree, picks the highest version on conflict, and tells you about it.",
  },
  {
    icon: "key",
    title: "Scoped API keys",
    text: "Keys are limited to a repository and a group prefix, read or write, and never stronger than their owner's role.",
  },
  {
    icon: "@",
    title: "Invite-only sign-in",
    text: "GitHub and Discord sign-in, with accounts created only from invite links. No passwords to manage.",
  },
  {
    icon: "⌫",
    title: "Cleanup policies",
    text: "Keep the last N snapshot builds, expire stale snapshots, preview first. Nothing another version depends on is deleted.",
  },
];

/** Six features in a hairline grid: three columns on desktop, two on tablets, one on phones. */
export function Features() {
  return (
    <section aria-labelledby="features-title" className="border-b">
      <h2 id="features-title" className="sr-only">
        Features
      </h2>
      <Container className="px-0 sm:px-0 lg:px-0">
        {/* 1px gaps over the border colour draw the hairlines between cells. */}
        <ul className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3 min-[1200px]:border-x">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="grid content-start gap-1.5 bg-background px-4 py-[22px] sm:px-[22px]">
              <span
                aria-hidden="true"
                className="mb-1.5 grid size-7 place-items-center rounded-md border font-mono text-[11px] font-semibold"
              >
                {feature.icon}
              </span>
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">{feature.text}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
