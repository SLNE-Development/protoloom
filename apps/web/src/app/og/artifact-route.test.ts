import { describe, expect, it, vi } from "vitest";
import { RegistryError, type Registry } from "@protoloom/core";
import type { ServerContext } from "@/server/context";
import { GET } from "./artifact/[repo]/[group]/[name]/[version]/route";

const registry = vi.hoisted(() => ({
  listVersions: vi.fn(),
  getManifest: vi.fn(),
}));

vi.mock("@/server/context", () => ({
  getServerContext: () => ({ registry: registry as unknown as Registry }) as unknown as ServerContext,
}));

const ctx = (version: string) => ({
  params: Promise.resolve({ repo: "internal", group: "dev.secret", name: "hidden-contracts", version }),
});

describe("GET /og/artifact/...", () => {
  it("answers with a short-lived PNG card, also for a private artifact, reading as an anonymous visitor", async () => {
    registry.getManifest.mockRejectedValue(new RegistryError("not_found", "Repository internal was not found"));
    const response = await GET(new Request("http://localhost:3000/og/artifact/internal/dev.secret/hidden-contracts/1.0.0"), ctx("1.0.0"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    expect(registry.getManifest).toHaveBeenCalledWith({ kind: "anonymous" }, "internal", {
      group: "dev.secret",
      name: "hidden-contracts",
      version: "1.0.0",
    });
  });
});
