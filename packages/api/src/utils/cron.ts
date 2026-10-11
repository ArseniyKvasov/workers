/**
 * Minimal cron expression parser and next-run calculator.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week
 * Does not support @yearly, @monthly, etc. shortcuts.
 */

export interface ParsedCron {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[]; // 0-6 (Sun-Sat)
}

/** Parse a 5-field cron expression into allowed values for each field. */
export function parseCronExpression(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("cron expression must have exactly 5 fields");
  }
  return {
    minute: parseField(parts[0] ?? "", 0, 59),
    hour: parseField(parts[1] ?? "", 0, 23),
    dayOfMonth: parseField(parts[2] ?? "", 1, 31),
    month: parseField(parts[3] ?? "", 1, 12),
    dayOfWeek: parseField(parts[4] ?? "", 0, 6),
  };
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (isNaN(step) || step < 1) throw new Error(`invalid step in ${field}`);

    // range is guaranteed to be a string since part.split("/") always returns at least one element
    const rangeStr = range ?? "";
    let start: number, end: number;
    if (rangeStr === "*") {
      start = min;
      end = max;
    } else if (rangeStr.includes("-")) {
      const [sStr, eStr] = rangeStr.split("-");
      const s = parseInt(sStr ?? "", 10);
      const e = parseInt(eStr ?? "", 10);
      if (isNaN(s) || isNaN(e)) throw new Error(`invalid range in ${field}`);
      start = s;
      end = e;
    } else {
      const v = parseInt(rangeStr, 10);
      if (isNaN(v)) throw new Error(`invalid value in ${field}`);
      start = v;
      end = v;
    }

    if (start < min || end > max) throw new Error(`value out of range in ${field}`);
    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }

  const result = Array.from(values).sort((a, b) => a - b);
  if (result.length === 0) throw new Error(`empty field ${field}`);
  return result;
}

/**
 * Find the next time >= base (in UTC) that matches the cron expression.
 * Returns a Date object (UTC).
 */
export function getNextRunTime(cronExpr: string, base: Date = new Date()): Date {
  const parsed = parseCronExpression(cronExpr);
  // Round up to next minute
  let candidate = new Date(base);
  candidate.setSeconds(0, 0);
  if (candidate <= base) {
    candidate = new Date(candidate.getTime() + 60_000);
  }

  // Safety: limit search to 4 years (should never hit for valid cron)
  const maxIterations = 4 * 365 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (matches(candidate, parsed)) {
      return new Date(candidate);
    }
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error("next run time not found within reasonable bounds");
}

function matches(date: Date, parsed: ParsedCron): boolean {
  const utc = date;
  const minute = utc.getUTCMinutes();
  const hour = utc.getUTCHours();
  const dayOfMonth = utc.getUTCDate();
  const month = utc.getUTCMonth() + 1; // 1-12
  const dayOfWeek = utc.getUTCDay(); // 0-6

  if (!parsed.minute.includes(minute)) return false;
  if (!parsed.hour.includes(hour)) return false;
  if (!parsed.month.includes(month)) return false;

  // Day of month and day of week: at least one must match (standard cron behavior)
  const domMatch = parsed.dayOfMonth.includes(dayOfMonth);
  const dowMatch = parsed.dayOfWeek.includes(dayOfWeek);
  if (!domMatch && !dowMatch) return false;

  return true;
}