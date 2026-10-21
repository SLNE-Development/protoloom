"use server";

import { cookies } from "next/headers";
import { env } from "@/env";
import { getServerContext } from "@/server/context";
import { INVITE_COOKIE, INVITE_COOKIE_MAX_AGE_SECONDS, inviteCookieValue, isSecureUrl } from "@/server/invite";
import { getInviteStatus } from "@/server/invite-status";

const UNUSABLE: Record<string, string> = {
  used: "This invite has already been used.",
  expired: "This invite has expired. Ask an admin for a new one.",
  unknown: "This invite link isn't valid.",
};

/**
 * Binds the invite `token` to this browser for the coming OAuth sign-in by setting the signed
 * invite cookie. Returns a message instead when the invite can't be used (any more); the server's
 * user gate checks the invite again when the account is created.
 */
export async function prepareInviteSignIn(token: string): Promise<string | null> {
  const status = await getInviteStatus(getServerContext().db, token);
  if (status.kind !== "valid") return UNUSABLE[status.kind] ?? UNUSABLE.unknown!;
  (await cookies()).set(INVITE_COOKIE, inviteCookieValue(token, { secret: env.BETTER_AUTH_SECRET }), {
    path: "/",
    maxAge: INVITE_COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureUrl(env.BETTER_AUTH_URL),
  });
  return null;
}
