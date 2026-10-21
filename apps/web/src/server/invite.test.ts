import { describe, expect, it } from "vitest";
import {
  INVITE_COOKIE,
  buildInviteUrl,
  clearInviteCookie,
  generateInviteToken,
  hashInviteToken,
  inviteCookieValue,
  isSecureUrl,
  readInviteToken,
  serializeInviteCookie,
} from "./invite";

const SECRET = "invite-secret-invite-secret-invite-01";

function cookieHeader(setCookie: string) {
  return setCookie.split(";")[0]!;
}

describe("invite tokens", () => {
  it("generates distinct URL-safe tokens and hashes them as hex SHA-256", () => {
    const a = generateInviteToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateInviteToken()).not.toBe(a);
    expect(hashInviteToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("builds invite links from the public URL", () => {
    expect(buildInviteUrl("https://protos.example.com", "tok")).toBe("https://protos.example.com/invite/tok");
    expect(isSecureUrl("https://protos.example.com")).toBe(true);
    expect(isSecureUrl("http://localhost:3000")).toBe(false);
  });
});

describe("invite cookie", () => {
  it("is httpOnly, lax, short-lived and secure on https", () => {
    const value = serializeInviteCookie("tok", { secret: SECRET, secure: true });
    expect(value).toMatch(new RegExp(`^${INVITE_COOKIE}=`));
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain("Max-Age=900");
    expect(value).toContain("Secure");
    expect(serializeInviteCookie("tok", { secret: SECRET, secure: false })).not.toContain("Secure");
    expect(clearInviteCookie({ secure: false })).toContain("Max-Age=0");
  });

  it("round-trips the token among other cookies", () => {
    const header = `a=1; ${cookieHeader(serializeInviteCookie("tok", { secret: SECRET, secure: false }))}; b=2`;
    expect(readInviteToken(header, SECRET)).toBe("tok");
  });

  it("rejects missing, tampered, foreign-secret and expired cookies", () => {
    const valid = cookieHeader(serializeInviteCookie("tok", { secret: SECRET, secure: false }));
    expect(readInviteToken(null, SECRET)).toBeNull();
    expect(readInviteToken("a=1", SECRET)).toBeNull();
    expect(readInviteToken(valid.replace("tok", "tak"), SECRET)).toBeNull();
    expect(readInviteToken(valid, "another-secret-another-secret-another")).toBeNull();
    expect(readInviteToken(valid, SECRET, new Date(Date.now() + 16 * 60_000))).toBeNull();
  });
});

describe("inviteCookieValue", () => {
  it("is the signed value that readInviteToken accepts, for setting the cookie through a cookie store", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const value = inviteCookieValue("tok", { secret: SECRET, now });
    expect(cookieHeader(serializeInviteCookie("tok", { secret: SECRET, secure: false, now }))).toBe(`${INVITE_COOKIE}=${value}`);
    expect(readInviteToken(`${INVITE_COOKIE}=${value}`, SECRET, now)).toBe("tok");
  });
});
