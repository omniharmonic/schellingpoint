// src/lib/events/dates.ts

/**
 * Generate array of date strings for event days
 * Returns dates in YYYY-MM-DD format
 */
export function getEventDays(startDate: Date, endDate: Date): string[] {
  const days: string[] = [];
  const current = new Date(startDate);
  current.setUTCHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setUTCHours(0, 0, 0, 0);

  while (current <= end) {
    days.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

/**
 * Format date in event's timezone for display
 */
export function formatEventDate(
  date: Date,
  timezone: string,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    ...options,
  }).format(date);
}

/**
 * Get day label for an event date (e.g., "Fri Feb 27")
 */
export function getEventDayLabel(dateStr: string, timezone: string): string {
  return formatCalendarDate(dateStr, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Check if a date is within the event dates
 */
export function isDateInEvent(
  date: Date,
  startDate: Date,
  endDate: Date
): boolean {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const start = new Date(startDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setUTCHours(0, 0, 0, 0);
  return d >= start && d <= end;
}

/** Event start/end columns are calendar dates, not timezone-specific instants. */
export function formatCalendarDate(date: Date | string, options?: Intl.DateTimeFormatOptions): string {
  const value = typeof date === 'string' ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : date;
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(value);
}
