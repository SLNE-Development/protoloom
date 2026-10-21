import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "./index.js";

describe("createDb", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs idle-client pool errors instead of crashing the process", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createDb("postgres://user:pass@127.0.0.1:1/none");
    const failure = new Error("terminating connection due to administrator command");

    expect(db.$client.listenerCount("error")).toBeGreaterThan(0);
    // Without a listener, EventEmitter#emit("error") throws, which crashes the process.
    expect(() => db.$client.emit("error", failure)).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith("protoloom: idle postgres client error", failure);
    await db.$client.end();
  });
});
