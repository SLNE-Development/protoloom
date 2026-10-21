import { describe, expect, it } from "vitest";
import { formatRelative, formatTimestamp, initials } from "./format";

describe("formatRelative", () => {
  const now = new Date("2026-10-21T12:00:00Z");

  it("rounds to the largest fitting unit, in both directions", () => {
    expect(formatRelative(new Date("2026-10-24T12:00:00Z"), now)).toBe("in 3 days");
    expect(formatRelative(new Date("2026-10-21T10:00:00Z"), now)).toBe("2 hours ago");
  });

  it("calls anything under a minute just now", () => {
    expect(formatRelative(new Date("2026-10-21T11:59:30Z"), now)).toBe("just now");
  });
});

describe("formatTimestamp", () => {
  it("pads every field", () => {
    expect(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02 03:04:05");
  });
});

describe("initials", () => {
  it("takes the first and last word, or the first two letters", () => {
    expect(initials("Ada Lovelace King")).toBe("AK");
    expect(initials("vera")).toBe("VE");
    expect(initials("  ")).toBe("?");
  });
});
