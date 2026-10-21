import type { Role } from "@protoloom/core";

/** Where a signed-in user lands by default. */
export const DASHBOARD_PATH = "/dashboard";

/** Request header in which the proxy hands the requested path (pathname plus query) to layouts. */
export const PATH_HEADER = "x-protoloom-path";

/** The outcome of the app shell's page gate. */
export type AccessDecision = { kind: "allow" } | { kind: "redirect"; to: string };

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The login page, returning to `path` (pathname plus query) after a successful sign-in. */
export function loginPath(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}

/**
 * Decides whether a visitor with `role` (`null` when anonymous) may open the app page at `path`
 * (pathname plus query). Anonymous visitors only get in when anonymous view is on, and then only
 * to the dashboard and the artifact browser; everyone else is sent to the login page. Admin pages
 * are for admins; other users go back to the dashboard.
 */
export function decideAccess(input: { path: string; role: Role | null; anonymousView: boolean }): AccessDecision {
  const pathname = input.path.split(/[?#]/, 1)[0] ?? "/";
  if (input.role === null) {
    const publicPage = isUnder(pathname, DASHBOARD_PATH) || isUnder(pathname, "/browse");
    return input.anonymousView && publicPage ? { kind: "allow" } : { kind: "redirect", to: loginPath(input.path) };
  }
  if (isUnder(pathname, "/admin") && input.role !== "admin") return { kind: "redirect", to: DASHBOARD_PATH };
  return { kind: "allow" };
}

/**
 * The local path a `next` parameter may send the browser to after sign-in. Anything that is not a
 * same-origin absolute path (external URLs, `//host`, `/\host`) or that points back at the login
 * page falls back to the dashboard, so the parameter can't be used as an open redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return DASHBOARD_PATH;
  if (isUnder(next.split(/[?#]/, 1)[0] ?? "", "/login")) return DASHBOARD_PATH;
  return next;
}
