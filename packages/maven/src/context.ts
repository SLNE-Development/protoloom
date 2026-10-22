import type { FormatDeps, Principal } from "@weaver/core";

/** What every Maven request reader needs: the shared dependencies, who asks, and the read method. */
export interface MavenContext {
  deps: FormatDeps;
  principal: Principal;
  method: "GET" | "HEAD";
}
