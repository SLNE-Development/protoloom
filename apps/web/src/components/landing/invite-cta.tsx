import type { SocialProviderId } from "@/server/auth";
import { Section } from "./layout";
import { SignInButtons } from "./sign-in-buttons";

/** Closing call to action: how invites work, and the sign-in buttons once more. */
export function InviteCta({ providers }: { providers: SocialProviderId[] }) {
  return (
    <Section label="invite-title" innerClassName="py-16 text-center sm:py-[72px]">
      <h2 id="invite-title" className="mb-2.5 text-[28px] leading-[1.15] font-semibold tracking-[-0.025em] sm:text-[34px]">
        Got an invite?
      </h2>
      <p className="mx-auto mb-6 max-w-[50ch] text-sm leading-relaxed text-muted-foreground">
        Open the invite link an admin sent you and sign in there. Already a member? Sign in below. No invite yet? Ask an
        admin of this instance for a link.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <SignInButtons providers={providers} />
      </div>
    </Section>
  );
}
