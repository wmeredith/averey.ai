export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/**
 * "Day index" = whole days since the epoch in Averey's local time zone.
 * `offsetMin` is the local offset from UTC in minutes (e.g. -300 for UTC-5).
 */
export function dayIndexOf(ts: number, offsetMin: number): number {
  return Math.floor((ts + offsetMin * MIN) / DAY);
}

/** Epoch ms of local midnight for a day index. */
export function dayStartOf(dayIndex: number, offsetMin: number): number {
  return dayIndex * DAY - offsetMin * MIN;
}

/** Hours since local midnight, as a float. */
export function localHour(ts: number, offsetMin: number): number {
  const local = ts + offsetMin * MIN;
  return (((local % DAY) + DAY) % DAY) / HOUR;
}

/** Day of the week in local time: 0 = Sunday .. 6 = Saturday. */
export function localWeekday(ts: number, offsetMin: number): number {
  return new Date(ts + offsetMin * MIN).getUTCDay();
}

/** Month in local time: 1 = January .. 12 = December. */
export function localMonth(ts: number, offsetMin: number): number {
  return new Date(ts + offsetMin * MIN).getUTCMonth() + 1;
}

export type DstRegion = "US" | "EU";

/**
 * True on the Monday right after a daylight saving switch, in local time.
 * US: second Sunday of March and first Sunday of November. EU: last Sunday
 * of March and of October. Averey's clock does not change; their body does.
 */
export function isDstMonday(ts: number, offsetMin: number, region: DstRegion): boolean {
  const d = new Date(ts + offsetMin * MIN);
  if (d.getUTCDay() !== 1) return false;
  const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1));
  const month = sunday.getUTCMonth() + 1;
  const day = sunday.getUTCDate();
  if (region === "US") return (month === 3 && day >= 8 && day <= 14) || (month === 11 && day <= 7);
  return (month === 3 || month === 10) && day >= 25;
}

export function yearOfDayIndex(dayIndex: number): number {
  return new Date(dayIndex * DAY).getUTCFullYear();
}

export function yearStartDayIndex(year: number): number {
  return Date.UTC(year, 0, 1) / DAY;
}

export function daysInYear(year: number): number {
  return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY;
}

export function formatTime(ts: number, offsetMin: number): string {
  const d = new Date(ts + offsetMin * MIN);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatDate(ts: number, offsetMin: number): string {
  const d = new Date(ts + offsetMin * MIN);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[d.getUTCDay()]} ${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
