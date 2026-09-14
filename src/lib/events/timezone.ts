// src/lib/events/timezone.ts

/**
 * Format a date/time in the event's timezone
 */
export function formatInEventTimezone(
  date: Date,
  timezone: string,
  format: 'time' | 'date' | 'datetime' | 'full' = 'datetime'
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
  };

  switch (format) {
    case 'time':
      options.hour = 'numeric';
      options.minute = '2-digit';
      break;
    case 'date':
      options.month = 'short';
      options.day = 'numeric';
      break;
    case 'datetime':
      options.month = 'short';
      options.day = 'numeric';
      options.hour = 'numeric';
      options.minute = '2-digit';
      break;
    case 'full':
      options.weekday = 'long';
      options.month = 'long';
      options.day = 'numeric';
      options.year = 'numeric';
      options.hour = 'numeric';
      options.minute = '2-digit';
      options.timeZoneName = 'short';
      break;
  }

  return new Intl.DateTimeFormat('en-US', options).format(date);
}

/**
 * Parse a time string in the event's timezone
 * Input: "09:00" and "2026-02-27"
 * Output: Date object in UTC that represents that time in the event timezone
 *
 * Example: parseTimeInTimezone("09:00", "2026-02-27", "America/Denver")
 * Returns a Date representing 09:00 AM Mountain Time on Feb 27, 2026 (as UTC)
 */
export function parseTimeInTimezone(
  timeStr: string,
  dateStr: string,
  timezone: string
): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  const reference = Date.UTC(year, month - 1, day, hours, minutes);
  if (!Number.isFinite(reference)) throw new RangeError('Invalid schedule date or time');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  let candidate = reference;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(candidate));
    const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
    const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
    const difference = reference - local;
    if (difference === 0) return new Date(candidate);
    candidate += difference;
  }
  // Clocks can skip local times during a DST transition. Never silently move a slot.
  throw new RangeError('This local time does not exist in the event timezone');
}

/**
 * Get the timezone abbreviation (e.g., "MST", "MDT")
 */
export function getTimezoneAbbreviation(timezone: string, date: Date = new Date()): string {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'short',
  }).format(date);

  // Extract just the timezone part
  const parts = formatted.split(' ');
  return parts[parts.length - 1];
}

/**
 * Get list of common timezones for picker
 */
export function getCommonTimezones(): { value: string; label: string }[] {
  const timezones = [
    { value: 'America/New_York', label: 'Eastern Time (ET)' },
    { value: 'America/Chicago', label: 'Central Time (CT)' },
    { value: 'America/Denver', label: 'Mountain Time (MT)' },
    { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
    { value: 'America/Phoenix', label: 'Arizona (MST)' },
    { value: 'Europe/London', label: 'London (GMT/BST)' },
    { value: 'Europe/Paris', label: 'Paris (CET/CEST)' },
    { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
    { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
    { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
    { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
    { value: 'UTC', label: 'UTC' },
  ];
  return timezones;
}
