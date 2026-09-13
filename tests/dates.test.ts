import { describe, expect, it } from "vitest";
import { calendarDates, localDate, localDateTime, shiftCalendarMonth } from "../src/lib/dates";

describe("local calendar dates", () => {
  it("does not move a Shanghai early-morning completion into yesterday", () => {
    const instant = new Date("2026-09-13T00:30:00+08:00");
    expect(localDate(instant)).toBe("2026-09-13");
    expect(localDateTime(instant)).toBe("2026-09-13T00:30");
  });

  it("generates the actual first and last day of the selected month", () => {
    const days = calendarDates(new Date(2026, 8, 13));
    expect(days).toHaveLength(30);
    expect(days[0]).toBe("2026-09-01");
    expect(days.at(-1)).toBe("2026-09-30");
  });

  it("handles leap years and December/January boundaries", () => {
    expect(calendarDates(new Date(2024, 1, 15)).at(-1)).toBe("2024-02-29");
    expect(calendarDates(new Date(2025, 1, 15))).toHaveLength(28);
    expect(localDate(shiftCalendarMonth(new Date(2026, 11, 31), 1))).toBe("2027-01-01");
  });

  it("does not skip February when navigating from January 31", () => {
    expect(localDate(shiftCalendarMonth(new Date(2026, 0, 31), 1))).toBe("2026-02-01");
    expect(localDate(shiftCalendarMonth(new Date(2026, 2, 31), -1))).toBe("2026-02-01");
  });
});
