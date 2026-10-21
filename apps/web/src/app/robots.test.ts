import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  it("allows the public pages, disallows the API and every signed-in area, and points at the sitemap", () => {
    const result = robots();
    expect(result.rules).toEqual([
      {
        userAgent: "*",
        allow: ["/", "/docs", "/browse"],
        disallow: ["/api", "/dashboard", "/keys", "/repositories", "/admin", "/account", "/invite", "/login"],
      },
    ]);
    expect(result.sitemap).toBe("http://localhost:3000/sitemap.xml");
    expect(result.host).toBe("http://localhost:3000");
  });
});
