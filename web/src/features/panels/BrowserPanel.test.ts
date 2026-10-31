import { describe, expect, it } from "vitest";
import { pageSize } from "./BrowserPanel";

describe("pageSize", () => {
  it("keeps a page within what the service takes", () => {
    expect(pageSize(640.4, 50)).toEqual({ width: 640, height: 100 });
    expect(pageSize(9000, 480)).toEqual({ width: 4096, height: 480 });
  });
});
