import { describe, expect, it } from "vitest";
import { matchesRules } from "./rules.js";

describe("matchesRules", () => {
  it("allows everything without rules", () => {
    expect(matchesRules({ allow: [], deny: [] }, "x")).toBe(true);
  });

  it("allow patterns restrict subjects", () => {
    const rules = { allow: ["org.apache.*"], deny: [] };
    expect(matchesRules(rules, "org.apache.commons:lang3")).toBe(true);
    expect(matchesRules(rules, "com.x:y")).toBe(false);
  });

  it("deny wins over allow", () => {
    const rules = { allow: ["org.*"], deny: ["org.evil*"] };
    expect(matchesRules(rules, "org.good:a")).toBe(true);
    expect(matchesRules(rules, "org.evil:a")).toBe(false);
    expect(matchesRules({ allow: [], deny: ["*"] }, "anything")).toBe(false);
  });

  it("* matches across dots and slashes", () => {
    expect(matchesRules({ allow: ["a*z"], deny: [] }, "a.b/c/d.z")).toBe(true);
    expect(matchesRules({ allow: ["@scope/*"], deny: [] }, "@scope/pkg/sub")).toBe(true);
  });

  it("matches the whole subject and treats other characters literally", () => {
    expect(matchesRules({ allow: ["org.apache"], deny: [] }, "org.apache.commons")).toBe(false);
    expect(matchesRules({ allow: ["a.c"], deny: [] }, "abc")).toBe(false);
    expect(matchesRules({ allow: ["a+(b)?"], deny: [] }, "a+(b)?")).toBe(true);
  });
});
