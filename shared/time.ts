import { Temporal } from '@js-temporal/polyfill';

export function validateTimeZone(zone: string): string {
  // Fixed offsets are deliberately not accepted as account time zones.
  if (!zone || /^[+-]/.test(zone)) throw new Error('Use an IANA time zone');
  Temporal.Now.zonedDateTimeISO(zone);
  return zone;
}
export function dateInZone(now: number, zone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).toPlainDate().toString();
}
export function wallToInstant(wall: string, zone: string): string {
  return Temporal.PlainDateTime.from(wall).toZonedDateTime(zone, { disambiguation: 'reject' }).toInstant().toString();
}
export function reminderInstant(todo: { reminderAt?: string; notifyAt?: string; notifyDate?: string }, zone: string): string | undefined {
  if (todo.reminderAt) return Temporal.Instant.from(todo.reminderAt).toString();
  if (todo.notifyAt) return wallToInstant(todo.notifyAt, zone);
  if (todo.notifyDate) return wallToInstant(`${todo.notifyDate}T09:00`, zone);
}
