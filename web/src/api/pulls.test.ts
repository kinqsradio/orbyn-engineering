import { describe, expect, it } from "vitest";
import { listQuery } from "./pulls";

describe("listQuery", () => {
  it("asks for nothing extra by default", () => {
    expect(listQuery("open", "fix")).toBe("state=open&q=fix");
  });

  it("asks for counts, and for a recount only together with counts", () => {
    expect(listQuery("open", "", { counts: "comments" })).toBe("state=open&q=&counts=comments");
    expect(listQuery("open", "", { counts: "comments", fresh: true })).toBe("state=open&q=&counts=comments&fresh=1");
    expect(listQuery("open", "", { fresh: true })).toBe("state=open&q=");
  });
});
