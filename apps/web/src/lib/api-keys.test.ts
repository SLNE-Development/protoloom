import { describe, expect, it } from "vitest";
import { accessOptionsFor, keyFormSchema, summarizePermissions, toCreateKeyInput, withheldSecret } from "./api-keys";

describe("accessOptionsFor", () => {
  it("offers only read to viewers and read + write to everyone else", () => {
    expect(accessOptionsFor("viewer")).toEqual(["read"]);
    expect(accessOptionsFor("maintainer")).toEqual(["read", "write"]);
    expect(accessOptionsFor("admin")).toEqual(["read", "write"]);
  });
});

describe("summarizePermissions", () => {
  it("lists access, repository and group scope per entry", () => {
    expect(
      summarizePermissions([
        { repository: "main", groupPrefix: null, access: "write" },
        { repository: "team", groupPrefix: "com.acme", access: "read" },
      ]),
    ).toEqual([
      { text: "write main", access: "write" },
      { text: "read team · com.acme.*", access: "read" },
    ]);
  });
});

describe("keyFormSchema", () => {
  const row = { repository: "main", groupPrefix: "", access: "read" } as const;
  const valid = { name: "ci", expiry: "30", permissions: [row] } as const;

  it("accepts a name, an expiry choice and at least one permission row", () => {
    expect(keyFormSchema.safeParse(valid).success).toBe(true);
    expect(keyFormSchema.safeParse({ ...valid, expiry: "never" }).success).toBe(true);
  });

  it("rejects an empty or too long name, no rows, no repository and a bad group prefix", () => {
    expect(keyFormSchema.safeParse({ ...valid, name: "  " }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...valid, name: "x".repeat(33) }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...valid, permissions: [] }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...valid, permissions: [{ ...row, repository: "" }] }).success).toBe(false);
    expect(keyFormSchema.safeParse({ ...valid, permissions: [{ ...row, groupPrefix: "com..x" }] }).success).toBe(false);
  });
});

describe("toCreateKeyInput", () => {
  it("trims, maps the expiry to days and empty prefixes to null", () => {
    expect(
      toCreateKeyInput({
        name: " ci ",
        expiry: "never",
        permissions: [
          { repository: "main", groupPrefix: "", access: "write" },
          { repository: "team", groupPrefix: " com.acme ", access: "read" },
        ],
      }),
    ).toEqual({
      name: "ci",
      permissions: [
        { repository: "main", groupPrefix: null, access: "write" },
        { repository: "team", groupPrefix: "com.acme", access: "read" },
      ],
    });
    expect(
      toCreateKeyInput({ name: "ci", expiry: "90", permissions: [{ repository: "main", groupPrefix: "", access: "read" }] })
        .expiresInDays,
    ).toBe(90);
  });
});

describe("withheldSecret", () => {
  it("hands the secret to the callback and resolves without it", async () => {
    const seen: string[] = [];
    const input = { name: "ci", permissions: [{ repository: "main", groupPrefix: null, access: "read" as const }] };
    const run = withheldSecret(
      async () => ({ id: "key-1", key: "pl_secret" }),
      (key, received) => seen.push(`${received.name}:${key}`),
    );
    const result = await run(input);
    expect(result).toEqual({ id: "key-1" });
    expect(JSON.stringify(result)).not.toContain("pl_secret");
    expect(seen).toEqual(["ci:pl_secret"]);
  });
});
