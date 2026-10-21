import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KindBadge } from "./browse-ui";

const kindOf = (version: string) => renderToStaticMarkup(createElement(KindBadge, { version })).replace(/<[^>]+>/g, "");

describe("KindBadge", () => {
  it("tags exactly the uppercase -SNAPSHOT suffix as a snapshot, like the registry", () => {
    expect(kindOf("1.5.0-SNAPSHOT")).toBe("snapshot");
    expect(kindOf("1.5.0")).toBe("release");
    expect(kindOf("1.5.0-snapshot")).toBe("release");
    expect(kindOf("1.5.0-Snapshot")).toBe("release");
  });
});
