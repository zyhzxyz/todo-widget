import { Temporal } from '@js-temporal/polyfill';

let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A single desktop window/account. Date grids still use plain calendar dates. */
export function setBusinessTimeZone(zone: string) { timeZone = zone; }
export function businessDate(date = new Date()) {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}
export function businessDateTime(date = new Date()) {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(timeZone).toPlainDateTime().toString({ smallestUnit: 'minute' });
}
