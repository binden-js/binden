const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `Sun, 06 Nov 1994 08:49:37 GMT` */
const imf =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<date>\d{2}) (?<month>[A-Z][a-z]{2}) (?<year>\d{4}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/u;

/** `Sunday, 06-Nov-94 08:49:37 GMT` (obsolete) */
const rfc850 =
  /^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (?<date>\d{2})-(?<month>[A-Z][a-z]{2})-(?<year>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/u;

/** `Sun Nov  6 08:49:37 1994` (obsolete) */
const asctime =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?<month>[A-Z][a-z]{2}) (?<date>[ \d]\d) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) (?<year>\d{4})$/u;

/**
 * An HTTP-date in any of its three formats (RFC 9110, section 5.6.7), or `null`
 * (`Date.parse()` accepts many other strings, and reads asctime as local time)
 */
export function parseHttpDate(input: string, now = Date.now()): Date | null {
  const {
    date = "",
    month = "",
    year = "",
    hour = "",
    minute = "",
    second = "",
  } = (imf.exec(input) ?? rfc850.exec(input) ?? asctime.exec(input))?.groups ??
  {};
  const index = months.indexOf(month);

  if (index < 0) {
    return null;
  }

  let fullYear = Number(year);
  if (year.length === 2) {
    // A two-digit year more than 50 years in the future is in the past
    const current = new Date(now).getUTCFullYear();
    fullYear += current - (current % 100);
    if (fullYear > current + 50) {
      fullYear -= 100;
    }
  }

  const components = [
    fullYear,
    index,
    ...[date, hour, minute, second].map(Number),
  ];
  const [y = 0, m = 0, d = 0, h = 0, min = 0, s = 0] = components;
  // Not `Date.UTC()`, which reads the years 0 to 99 as 1900 to 1999
  const parsed = new Date(0);
  parsed.setUTCFullYear(y, m, d);
  parsed.setUTCHours(h, min, s, 0);

  // Out of range components (e.g. February 30, or 24:00:00) do not round trip
  return parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m &&
    parsed.getUTCDate() === d &&
    parsed.getUTCHours() === h &&
    parsed.getUTCMinutes() === min &&
    parsed.getUTCSeconds() === s
    ? parsed
    : null;
}
