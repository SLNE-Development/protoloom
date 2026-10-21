import { describe, expect, it } from "vitest";
import {
  compareVersions,
  formatCoordinate,
  isSnapshot,
  isValidGroup,
  isValidName,
  isValidRepositoryName,
  isValidVersion,
  parseCoordinate,
} from "./coordinates.js";
import { RegistryError } from "./errors.js";

describe("parseCoordinate", () => {
  it("parses group:name:version", () => {
    expect(parseCoordinate("dev.surf.economy:economy-contracts:1.4.0")).toEqual({
      group: "dev.surf.economy",
      name: "economy-contracts",
      version: "1.4.0",
    });
  });

  it("round-trips through formatCoordinate", () => {
    const s = "dev.surf.economy:economy-contracts:1.4.0";
    expect(formatCoordinate(parseCoordinate(s))).toBe(s);
  });

  it.each(["a:b", "Dev:x:1", "a:b:c:1.0", ""])("rejects %j with invalid_request", (s) => {
    let caught: unknown;
    try {
      parseCoordinate(s);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    expect((caught as RegistryError).code).toBe("invalid_request");
    expect((caught as RegistryError).status).toBe(400);
  });
});

describe("RegistryError", () => {
  it("maps codes to statuses and keeps details", () => {
    const e = new RegistryError("has_dependents", "in use", { n: 1 });
    expect(e.status).toBe(409);
    expect(e.details).toEqual({ n: 1 });
    expect(new RegistryError("validation_failed", "x").status).toBe(422);
    expect(new RegistryError("payload_too_large", "x").status).toBe(413);
  });
});

describe("name validators", () => {
  it("repository", () => {
    expect(isValidRepositoryName("my-repo1")).toBe(true);
    expect(isValidRepositoryName("-repo")).toBe(false);
    expect(isValidRepositoryName("a".repeat(64))).toBe(false);
  });
  it("group", () => {
    expect(isValidGroup("dev.surf_x.economy-v2")).toBe(true);
    expect(isValidGroup("dev.surf.")).toBe(false);
    expect(isValidGroup("Dev")).toBe(false);
  });
  it("name", () => {
    expect(isValidName("economy-contracts.v1")).toBe(true);
    expect(isValidName(".hidden")).toBe(false);
  });
  it("version", () => {
    expect(isValidVersion("1.5.0-rc.1")).toBe(true);
    expect(isValidVersion("1.2.3.4")).toBe(true);
    expect(isValidVersion("1.2.3.4.5")).toBe(false);
    expect(isValidVersion("v1")).toBe(false);
    expect(isValidVersion(`1-${"a".repeat(64)}`)).toBe(false);
  });
});

describe("isSnapshot", () => {
  it("detects the -SNAPSHOT suffix", () => {
    expect(isSnapshot("1.5.0-SNAPSHOT")).toBe(true);
    expect(isSnapshot("1.5.0")).toBe(false);
  });
});

describe("compareVersions", () => {
  const gt = (a: string, b: string) => {
    expect(compareVersions(a, b)).toBeGreaterThan(0);
    expect(compareVersions(b, a)).toBeLessThan(0);
  };
  it("compares numeric parts numerically", () => gt("1.10.0", "1.9.0"));
  it("treats missing parts as zero", () => expect(compareVersions("1.0", "1.0.0")).toBe(0));
  it("ranks release above its snapshot", () => gt("1.5.0", "1.5.0-SNAPSHOT"));
  it("compares qualifier segments", () => gt("1.5.0-rc.2", "1.5.0-rc.1"));
  it("compares numeric qualifier segments as numbers", () => gt("1.5.0-rc.10", "1.5.0-rc.9"));
  it("ranks a higher snapshot above a lower release", () => gt("2.0.0-SNAPSHOT", "1.9.9"));
  it("ranks a longer qualifier above its prefix", () => gt("1.0.0-rc.1", "1.0.0-rc"));
});
