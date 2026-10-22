import { describe, expect, it } from "vitest";
import { DockerError, errorResponse } from "./errors.js";

describe("errorResponse", () => {
  it("renders the OCI error body and registry header", async () => {
    const res = errorResponse(new DockerError(404, "NAME_UNKNOWN", "no such repo", { name: "x" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ errors: [{ code: "NAME_UNKNOWN", message: "no such repo", detail: { name: "x" } }] });
  });
  it("uses null detail when none is given", async () => {
    const res = errorResponse(new DockerError(400, "DIGEST_INVALID", "bad"));
    expect(await res.json()).toEqual({ errors: [{ code: "DIGEST_INVALID", message: "bad", detail: null }] });
  });
  it("merges extra headers", () => {
    const res = errorResponse(new DockerError(401, "UNAUTHORIZED", "x", undefined, { "www-authenticate": 'Bearer realm="r"' }));
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="r"');
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
  });
  it("keeps status, code and name on the error", () => {
    const e = new DockerError(429, "TOOMANYREQUESTS", "slow");
    expect(e).toBeInstanceOf(Error);
    expect([e.status, e.code, e.message]).toEqual([429, "TOOMANYREQUESTS", "slow"]);
  });
});
