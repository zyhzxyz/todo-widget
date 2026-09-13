/** Calendar dates belong to the user's local day, not the UTC day of an instant. */
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localDateTime(date = new Date()): string {
  return `${localDate(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function calendarDates(month: Date): string[] {
  const year = month.getFullYear();
  const index = month.getMonth();
  const count = new Date(year, index + 1, 0).getDate();
  return Array.from({ length: count }, (_, day) => localDate(new Date(year, index, day + 1)));
}

/** Starting on day 1 avoids Jan 31 + one month overflowing into March. */
export function shiftCalendarMonth(month: Date, offset: number): Date {
  return new Date(month.getFullYear(), month.getMonth() + offset, 1);
}
