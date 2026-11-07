import { expect, it } from "vitest";
import { cloneAddress } from "./AddProjectPalette";

it("turns an owner/name into a GitHub address and leaves every other address as typed", () => {
  expect(cloneAddress(" orbyn-dev/orbyn-notes ")).toBe("https://github.com/orbyn-dev/orbyn-notes.git");
  expect(cloneAddress("https://example.com/team/repo.git")).toBe("https://example.com/team/repo.git");
  expect(cloneAddress("git@github.com:team/repo.git")).toBe("git@github.com:team/repo.git");
  expect(cloneAddress("./local/repo")).toBe("./local/repo");
});
