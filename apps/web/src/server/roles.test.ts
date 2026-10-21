import { describe, expect, it } from "vitest";
import { effectiveRole, isRole, parseRoles } from "./roles";

describe("roles", () => {
  it("parses trimmed, comma-separated role lists and drops unknown entries", () => {
    expect(parseRoles(" maintainer , admin")).toEqual(["maintainer", "admin"]);
    expect(parseRoles("user,owner")).toEqual([]);
    expect(parseRoles(null)).toEqual([]);
  });

  it("picks the highest role and falls back to viewer", () => {
    expect(effectiveRole("viewer, admin ,maintainer")).toBe("admin");
    expect(effectiveRole("maintainer")).toBe("maintainer");
    expect(effectiveRole("user")).toBe("viewer");
    expect(effectiveRole(undefined)).toBe("viewer");
  });

  it("recognises only the three roles", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("Admin")).toBe(false);
    expect(isRole(1)).toBe(false);
  });
});
