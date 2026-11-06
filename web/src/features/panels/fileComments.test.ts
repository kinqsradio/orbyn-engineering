import { expect, it } from "vitest";
import { fileCommentRange } from "./FileComments";

it("captures reversed ranges and blank lines from the displayed snapshot", () => {
  expect(fileCommentRange("first\n\nthird", 3, 1)).toEqual({ line: 1, endLine: 3, excerpt: "first\n\nthird" });
  expect(fileCommentRange("first\n\nthird", 2, 2)).toEqual({ line: 2, endLine: 2, excerpt: "" });
});

it("refuses invalid ranges and excerpts that would be silently shortened", () => {
  for (const range of [[0, 1], [1, 4], [1.1, 2], [NaN, 2], [1, Infinity]]) {
    expect(fileCommentRange("a\nb\nc", range[0]!, range[1]!)).toBeNull();
  }
  expect(fileCommentRange("x".repeat(4001), 1, 1)).toBeNull();
});
