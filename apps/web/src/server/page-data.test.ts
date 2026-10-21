import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND_PAGE");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { orNotFound } = await import("./page-data");

const failing = (code: TRPCError["code"]) => Promise.reject(new TRPCError({ code }));

describe("orNotFound", () => {
  it("passes results through", async () => {
    await expect(orNotFound(Promise.resolve(42), "/browse/x")).resolves.toBe(42);
  });

  it("sends signed-out visitors to the login page and back", async () => {
    await expect(orNotFound(failing("UNAUTHORIZED"), "/browse/x")).rejects.toThrow("REDIRECT /login?next=%2Fbrowse%2Fx");
  });

  it.each(["NOT_FOUND", "FORBIDDEN", "BAD_REQUEST"] as const)("shows the 404 page for %s", async (code) => {
    await expect(orNotFound(failing(code), "/browse/x")).rejects.toThrow("NOT_FOUND_PAGE");
  });

  it("rethrows anything else", async () => {
    await expect(orNotFound(failing("INTERNAL_SERVER_ERROR"), "/browse/x")).rejects.toBeInstanceOf(TRPCError);
  });
});
