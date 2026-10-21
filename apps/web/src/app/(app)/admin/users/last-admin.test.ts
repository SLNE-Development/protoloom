import { describe, expect, it } from "vitest";
import { lastAdminId } from "./last-admin";

describe("lastAdminId", () => {
  it("names the single active admin", () => {
    expect(
      lastAdminId([
        { id: "a", role: "admin", banned: false },
        { id: "v", role: "viewer", banned: false },
      ]),
    ).toBe("a");
  });

  it("ignores banned admins", () => {
    expect(
      lastAdminId([
        { id: "a", role: "admin", banned: false },
        { id: "b", role: "admin", banned: true },
      ]),
    ).toBe("a");
  });

  it("is null with several active admins or none", () => {
    expect(
      lastAdminId([
        { id: "a", role: "admin", banned: false },
        { id: "b", role: "admin", banned: false },
      ]),
    ).toBeNull();
    expect(lastAdminId([{ id: "v", role: "viewer", banned: false }])).toBeNull();
  });
});
