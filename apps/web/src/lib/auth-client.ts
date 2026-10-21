"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Better Auth browser client. It talks to `/api/auth` on the current origin, which is the public
 * `BETTER_AUTH_URL` the server is configured with.
 */
export const authClient = createAuthClient();

/** OAuth providers the UI knows how to show. */
export type ProviderId = "github" | "discord";

/** Display names of the OAuth providers. */
export const PROVIDER_NAMES: Record<ProviderId, string> = { github: "GitHub", discord: "Discord" };

/**
 * Starts the OAuth sign-in with `provider`. `requestSignUp` must be set because implicit sign-up is
 * disabled: it lets the server's invite / first-admin gate decide whether a new account may be
 * created. Failures come back to `errorCallbackURL` with an `error` query parameter.
 */
export async function signInWith(
  provider: ProviderId,
  opts: { callbackURL: string; errorCallbackURL: string },
): Promise<{ error: string | null }> {
  const { error } = await authClient.signIn.social({
    provider,
    requestSignUp: true,
    callbackURL: opts.callbackURL,
    errorCallbackURL: opts.errorCallbackURL,
  });
  return { error: error ? (error.message ?? "Sign-in failed") : null };
}
