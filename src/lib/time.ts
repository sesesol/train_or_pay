/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// All time calculations strictly use Europe/Berlin timezone

export function getBerlinParts(date: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number; // 1 (Mo) - 7 (So)
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const weekdayStr = map.weekday || '';
  // Convert weekday to 1 (Mo) - 7 (So)
  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };

  const dayOfWeek = weekdayMap[weekdayStr] || 1;

  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour: parseInt(map.hour, 10) % 24,
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10),
    dayOfWeek,
  };
}

/**
 * Returns the ISO 8601 week number and ISO week year for a given date in Europe/Berlin
 */
export function getBerlinISOWeekInfo(date: Date = new Date()): {
  year: number;
  week: number;
  weekKey: string;
} {
  const berlin = getBerlinParts(date);
  
  // Construct a UTC date based on Berlin year, month (0-indexed), day
  const target = new Date(Date.UTC(berlin.year, berlin.month - 1, berlin.day));
  
  // ISO week date days: Monday = 1, ..., Sunday = 7
  // target.getUTCDay(): 0 is Sunday, 1 is Monday...
  const dayNr = (target.getUTCDay() + 6) % 7 + 1;
  
  // Set target to Thursday of the current week (ISO 8601 rule: Thursday is always in the current ISO week)
  target.setUTCDate(target.getUTCDate() - dayNr + 4);
  
  // Get first day of that year
  const firstThursday = target.getUTCFullYear();
  const firstDayOfYear = new Date(Date.UTC(firstThursday, 0, 1));
  
  // Calculate week number
  const weekNumber = Math.ceil(((target.getTime() - firstDayOfYear.getTime()) / 86400000 + 1) / 7);
  const isoYear = target.getUTCFullYear();
  const weekStr = weekNumber < 10 ? `0${weekNumber}` : `${weekNumber}`;
  
  return {
    year: isoYear,
    week: weekNumber,
    weekKey: `${isoYear}-W${weekStr}`,
  };
}

export function getBerlinISOWeek(date: Date = new Date()): string {
  return getBerlinISOWeekInfo(date).weekKey;
}

/**
 * Returns the ISO week key for next week
 */
export function getNextBerlinISOWeek(date: Date = new Date()): string {
  const berlin = getBerlinParts(date);
  // Add 7 days to Berlin date
  const next = new Date(Date.UTC(berlin.year, berlin.month - 1, berlin.day + 7));
  return getBerlinISOWeek(next);
}

/**
 * Returns the ISO week key for previous week
 */
export function getPreviousBerlinISOWeek(weekKey: string): string {
  const [yearStr, weekStr] = weekKey.split('-W');
  let y = parseInt(yearStr, 10);
  let w = parseInt(weekStr, 10) - 1;
  if (w <= 0) {
    y -= 1;
    // Get last week of previous year (approx Dec 28)
    const dec28 = new Date(Date.UTC(y, 11, 28));
    return getBerlinISOWeek(dec28);
  }
  return `${y}-W${w < 10 ? '0' + w : w}`;
}

/**
 * Returns subsequent ISO week key
 */
export function getSubsequentBerlinISOWeek(weekKey: string): string {
  const [yearStr, weekStr] = weekKey.split('-W');
  const y = parseInt(yearStr, 10);
  const w = parseInt(weekStr, 10);
  // Date of Thursday of this week + 7 days
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const dayNr = (jan4.getUTCDay() + 6) % 7 + 1;
  const thurs1 = new Date(Date.UTC(y, 0, 4 - dayNr + 4));
  const thisThursday = new Date(thurs1.getTime() + (w - 1) * 7 * 86400000);
  const nextThursday = new Date(thisThursday.getTime() + 7 * 86400000);
  return getBerlinISOWeek(nextThursday);
}

/**
 * Planning window: Saturday 00:00:00 to Sunday 23:59:59 (Europe/Berlin)
 */
export function isBerlinPlanningWindow(date: Date = new Date()): boolean {
  const berlin = getBerlinParts(date);
  return berlin.dayOfWeek === 6 || berlin.dayOfWeek === 7;
}

/**
 * Late planning window: Monday 00:00:00 to Monday 23:59:59 (Europe/Berlin)
 */
export function isBerlinLateWindow(date: Date = new Date()): boolean {
  const berlin = getBerlinParts(date);
  return berlin.dayOfWeek === 1;
}

/**
 * Check if today is Tuesday or later (after Monday 23:59)
 */
export function isAfterMondayMidnight(date: Date = new Date()): boolean {
  const berlin = getBerlinParts(date);
  return berlin.dayOfWeek >= 2;
}

/**
 * Formats a date to German string, e.g. "Mo, 16.03." or "Di, 14:32"
 */
export function formatBerlinDate(dateInput: Date | string): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
  return formatter.format(date);
}

export function formatBerlinDateTime(dateInput: Date | string): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return formatter.format(date);
}

export function formatBerlinFullDateTime(dateInput: Date | string): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Get date range for an ISO week key (e.g. "2026-W12" -> "Mo, 16.03. – So, 22.03.2026")
 */
export function getWeekDateRange(weekKey: string): {
  startFormatted: string;
  endFormatted: string;
  fullRange: string;
} {
  const [yearStr, weekStr] = weekKey.split('-W');
  const y = parseInt(yearStr, 10);
  const w = parseInt(weekStr, 10);

  // Find Monday of ISO week:
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const dayNr = (jan4.getUTCDay() + 6) % 7 + 1; // 1 = Mon ... 7 = Sun
  const mondayWeek1 = new Date(Date.UTC(y, 0, 4 - dayNr + 1));
  const monday = new Date(mondayWeek1.getTime() + (w - 1) * 7 * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);

  const startFormatted = formatBerlinDate(monday);
  const endFormatted = formatBerlinDate(sunday);

  const yearFormatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
  });

  return {
    startFormatted,
    endFormatted,
    fullRange: `${startFormatted} – ${endFormatted} ${yearFormatter.format(sunday)}`,
  };
}

/**
 * Checks if two timestamps fall on the same calendar day in Europe/Berlin
 */
export function isSameBerlinDay(d1: Date | string, d2: Date | string): boolean {
  const date1 = typeof d1 === 'string' ? new Date(d1) : d1;
  const date2 = typeof d2 === 'string' ? new Date(d2) : d2;

  const f = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return f.format(date1) === f.format(date2);
}

/**
 * Returns remaining days in the week (including today) in Berlin
 * E.g. Monday = 7 days, Sunday = 1 day
 */
export function getDaysRemainingInWeek(date: Date = new Date()): number {
  const berlin = getBerlinParts(date);
  return 8 - berlin.dayOfWeek; // Mo(1) -> 7, Di(2) -> 6, ..., So(7) -> 1
}

export function getGermanDayName(dayOfWeek: number): string {
  const names = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  return names[dayOfWeek - 1] || 'Heute';
}
