import { CliError } from "./config.js";

/** One artifact entry of the `/api/v1/resolve` response. */
export interface ResolvedArtifact {
  repository: string;
  coordinate: string;
  group: string;
  name: string;
  version: string;
  buildNumber: number;
  sha256: string;
  archiveUrl: string;
}

export interface ResolveConflict {
  group: string;
  name: string;
  requested: string[];
  selected: string;
}

export interface ResolveResponse {
  artifacts: ResolvedArtifact[];
  conflicts: ResolveConflict[];
}

export interface Downloaded {
  data: Buffer;
  /** Value of `x-protoloom-sha256`, when the server sent it. */
  sha256?: string;
}

/** Minimal client for the registry REST API. */
export class RegistryClient {
  private readonly base: URL;

  constructor(
    url: string,
    private readonly token?: string,
  ) {
    this.base = new URL(url);
  }

  /**
   * Maps an archive URL from the server onto the configured registry. The bearer
   * token is only ever sent to the configured scheme+host+port, so a foreign
   * origin (a misconfigured or malicious server) has its path rebased onto the
   * configured url instead of being contacted.
   */
  archiveTarget(archiveUrl: string): URL {
    const given = new URL(archiveUrl, this.base);
    if (given.origin === this.base.origin) return given;
    const prefix = this.base.pathname.replace(/\/+$/, "");
    return new URL(`${prefix}${given.pathname}`, this.base.origin);
  }

  async resolve(repositories: string[], dependencies: string[]): Promise<ResolveResponse> {
    const res = await this.request(new URL(`${this.base.pathname.replace(/\/+$/, "")}/api/v1/resolve`, this.base.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositories, dependencies }),
    });
    return (await res.json()) as ResolveResponse;
  }

  async download(archiveUrl: string): Promise<Downloaded> {
    const res = await this.request(this.archiveTarget(archiveUrl), { method: "GET" });
    return {
      data: Buffer.from(await res.arrayBuffer()),
      sha256: res.headers.get("x-protoloom-sha256")?.toLowerCase() ?? undefined,
    };
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (err) {
      const reason = err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error).message;
      throw new CliError(`Cannot reach ${url.origin}: ${reason}`);
    }
    if (!res.ok) throw new CliError(await errorMessage(res));
    return res;
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // fall through to the generic message
  }
  return `Registry responded with HTTP ${res.status}`;
}
