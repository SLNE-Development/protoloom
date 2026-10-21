import { afterEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ execute: vi.fn<(query: unknown) => Promise<unknown>>() }));

vi.mock("@/server/context", () => ({
  getServerContext: () => ({ db: { execute: holder.execute } }),
}));

const { GET, dynamic } = await import("./route");

describe("GET /api/health", () => {
  afterEach(() => {
    holder.execute.mockReset();
  });

  it("is rendered per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns 200 { ok: true } after a successful select 1", async () => {
    holder.execute.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(holder.execute).toHaveBeenCalledTimes(1);
  });

  it("returns 503 { ok: false } when the database query fails", async () => {
    holder.execute.mockRejectedValue(new Error("connection refused"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
