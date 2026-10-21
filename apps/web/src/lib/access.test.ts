import { describe, expect, it } from "vitest";
import { decideAccess, loginPath, safeNextPath } from "./access";

describe("decideAccess", () => {
  it("sends anonymous visitors to the login page when anonymous view is off", () => {
    expect(decideAccess({ path: "/dashboard", role: null, anonymousView: false })).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fdashboard",
    });
    expect(decideAccess({ path: "/browse/main?tab=files", role: null, anonymousView: false })).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fbrowse%2Fmain%3Ftab%3Dfiles",
    });
  });

  it("lets anonymous visitors see the dashboard and browse pages when anonymous view is on", () => {
    for (const path of ["/dashboard", "/browse", "/browse/main/dev.example/demo/1.0.0"]) {
      expect(decideAccess({ path, role: null, anonymousView: true })).toEqual({ kind: "allow" });
    }
  });

  it("keeps everything else behind the login even with anonymous view on", () => {
    for (const path of ["/keys", "/repositories", "/account", "/admin/users", "/browsers", "/dashboards"]) {
      expect(decideAccess({ path, role: null, anonymousView: true })).toEqual({
        kind: "redirect",
        to: loginPath(path),
      });
    }
  });

  it("lets signed-in users in regardless of anonymous view", () => {
    expect(decideAccess({ path: "/keys", role: "viewer", anonymousView: false })).toEqual({ kind: "allow" });
  });

  it("reserves admin pages for admins", () => {
    expect(decideAccess({ path: "/admin/users", role: "maintainer", anonymousView: false })).toEqual({
      kind: "redirect",
      to: "/dashboard",
    });
    expect(decideAccess({ path: "/admin", role: "viewer", anonymousView: false })).toEqual({
      kind: "redirect",
      to: "/dashboard",
    });
    expect(decideAccess({ path: "/admin/users", role: "admin", anonymousView: false })).toEqual({ kind: "allow" });
    expect(decideAccess({ path: "/administrator", role: "viewer", anonymousView: false })).toEqual({ kind: "allow" });
  });
});

describe("safeNextPath", () => {
  it("keeps local absolute paths", () => {
    expect(safeNextPath("/browse/main?x=1")).toBe("/browse/main?x=1");
  });

  it("falls back to the dashboard for missing, external or protocol-relative targets", () => {
    for (const value of [undefined, null, "", "https://evil.example", "//evil.example", "/\\evil.example", "browse"]) {
      expect(safeNextPath(value)).toBe("/dashboard");
    }
  });

  it("never sends a signed-in user back to the login page", () => {
    expect(safeNextPath("/login?next=/")).toBe("/dashboard");
  });
});
