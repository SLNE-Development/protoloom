import { getSettings, recordUsage, type FormatFactory, type FormatHandler } from "@weaver/core";
import { env } from "@/env";
import { handle } from "./http";
import { getServerContext } from "./context";
import { getPrincipal } from "./principal";

/** The protocol mounts served outside `/api`. */
export type FormatMount = "maven" | "npm" | "docker";

/**
 * Format factories by mount. A format plan replaces its `undefined` with one import and one map
 * entry; until then the mount answers 501.
 */
const FACTORIES: Record<FormatMount, FormatFactory | undefined> = {
  maven: undefined,
  npm: undefined,
  docker: undefined,
};

/** The 501 answer of a mount whose format is not installed. */
function notInstalled(mount: FormatMount): FormatHandler {
  return async () =>
    Response.json(
      { error: { code: "not_implemented", message: `${mount} support is not installed` } },
      { status: 501 },
    );
}

const handlers = new Map<FormatMount, FormatHandler>();

/** The handler of a format mount, built once per process from the server context. */
export function getFormatHandler(mount: FormatMount): FormatHandler {
  let handler = handlers.get(mount);
  if (!handler) {
    const factory = FACTORIES[mount];
    if (!factory) {
      handler = notInstalled(mount);
    } else {
      const ctx = getServerContext();
      handler = factory({
        db: ctx.db,
        stores: ctx.stores,
        repos: ctx.repos,
        assets: ctx.assets,
        mirror: ctx.mirror,
        principal: (req) => getPrincipal(req, ctx),
        settings: () => getSettings(ctx.db, { primaryStore: ctx.stores.primary.id, configuredStores: ctx.stores.configured() }),
        publicUrl: env.BETTER_AUTH_URL.replace(/\/+$/, ""),
        secretKey: ctx.secretKey,
        usage: (input) => recordUsage(ctx.db, input),
      });
    }
    handlers.set(mount, handler);
  }
  return handler;
}

/** URL path prefix of each mount. */
const PREFIX: Record<FormatMount, string> = { maven: "/maven", npm: "/npm", docker: "/v2" };

/**
 * The raw path after the mount prefix, without a leading slash and with percent-encoding and a
 * trailing slash kept ("" for the prefix itself). Taken from the URL, never from route params.
 */
export function mountRest(req: Request, mount: FormatMount): string {
  const path = new URL(req.url).pathname;
  const after = path.slice(PREFIX[mount].length);
  return after.startsWith("/") ? after.slice(1) : after;
}

/** A route handler that forwards every request of the mount to its format handler. */
export function mountRoute(mount: FormatMount): (req: Request) => Promise<Response> {
  return handle(async (req: Request) => getFormatHandler(mount)(req, mountRest(req, mount)));
}
