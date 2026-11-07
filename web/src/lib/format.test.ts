import { expect, it } from "vitest";
import { dayStamp, sizeWords, tookWords, weekdayStamp } from "./format";

const now = new Date(2026, 10, 8, 12, 0);

it("names today and yesterday, and dates anything older", () => {
  expect(dayStamp(new Date(2026, 10, 8, 10, 12).toISOString(), now)).toBe("Today 10:12");
  expect(dayStamp(new Date(2026, 10, 7, 16, 40).toISOString(), now)).toBe("Yesterday 16:40");
  expect(dayStamp(new Date(2026, 10, 3, 9, 2).toISOString(), now)).toBe("3 Nov 09:02");
});

it("writes a run's start, its duration and a size the way the frames do", () => {
  expect(weekdayStamp(new Date(2026, 10, 9, 7, 0).toISOString())).toBe("Mon 9 Nov 07:00");
  expect([tookWords(45_000), tookWords(360_000), tookWords(7_800_000)]).toEqual(["45 s", "6 min", "2 h 10 min"]);
  expect([sizeWords(48_000_000), sizeWords(2_000_000), sizeWords(1_400_000_000)]).toEqual(["48 MB", "2 MB", "1.4 GB"]);
});
