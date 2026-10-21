import { describe, expect, it } from "vitest";
import { errorCode, errorMessage, runNowErrorMessage } from "./trpc-error";

const trpcLike = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

describe("trpc error helpers", () => {
  it("read the tRPC code and message", () => {
    expect(errorCode(trpcLike("CONFLICT", "taken"))).toBe("CONFLICT");
    expect(errorCode(new Error("plain"))).toBeNull();
    expect(errorCode("nope")).toBeNull();
    expect(errorMessage(trpcLike("CONFLICT", "Repository main already exists"))).toBe("Repository main already exists");
    expect(errorMessage(null)).toBe("Something went wrong");
  });

  it("explain why a cleanup run could not start", () => {
    expect(runNowErrorMessage(trpcLike("SERVICE_UNAVAILABLE", "x"))).toMatch(/Valkey is not reachable/);
    expect(runNowErrorMessage(trpcLike("PRECONDITION_FAILED", "x"))).toMatch(/VALKEY_URL/);
    expect(runNowErrorMessage(trpcLike("NOT_FOUND", "Repository x was not found"))).toBe("Repository x was not found");
  });
});
