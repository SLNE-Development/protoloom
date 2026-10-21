import { describe, expect, it, vi } from "vitest";
import { QueueUnavailableError } from "./index.js";

describe("QueueUnavailableError", () => {
  it("is an Error with a fixed message and the cause", () => {
    const cause = new Error("ECONNREFUSED");
    const error = new QueueUnavailableError(cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(QueueUnavailableError);
    expect(error).toMatchObject({ name: "QueueUnavailableError", cause });
  });

  it("is recognised across copies of the module (separate server bundles)", async () => {
    vi.resetModules();
    const other = await import("./index.js");
    expect(other.QueueUnavailableError).not.toBe(QueueUnavailableError);
    expect(new other.QueueUnavailableError() instanceof QueueUnavailableError).toBe(true);
    expect(new QueueUnavailableError() instanceof other.QueueUnavailableError).toBe(true);
  });

  it("doesn't match other errors", () => {
    expect(new Error("x") instanceof QueueUnavailableError).toBe(false);
    expect({ name: "QueueUnavailableError" } instanceof QueueUnavailableError).toBe(false);
  });
});
