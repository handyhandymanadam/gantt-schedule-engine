import { MS_PER_HOUR, type Calendar } from './calendar.js'
import type { UtcOffsetResolver } from './timezone.js'
import type { Hours } from './types.js'

/**
 * A working-week calendar: working days, daily shifts, holidays, and one-off exceptions.
 *
 * This is the piece both commercial libraries put behind their paid tier, and no schedule that
 * touches a real week is correct without it. A three-day task starting Thursday finishes Monday,
 * not Saturday.
 *
 * Configured with a 24-hour shift on all seven days it reproduces {@link ContinuousCalendar}
 * exactly, which is the regression guarantee the critical-path suite relies on: the same worked
 * examples must produce the same numbers under both.
 *
 * **Time zones.** Instants are `Date`s, but working hours are wall-clock concepts, so something
 * has to map between them. `utcOffsetMinutes` takes either a fixed number of minutes east of UTC
 * or a resolver called per instant. Use a resolver for any zone with daylight saving: a fixed
 * offset sampled today is simply wrong for dates on the far side of the next transition, which
 * is most of what a schedule contains. See `offsetForZone` and `hostOffset`.
 */

const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000
const MINUTES_PER_DAY = 1_440

/** 0 = Sunday through 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** A contiguous working period in local wall-clock time, as `HH:MM`. `24:00` means end of day. */
export interface Shift {
  start: string
  end: string
}

export interface WorkingWeekOptions {
  /**
   * Shifts per weekday. A day that is absent, or has an empty array, is non-working.
   * Defaults to Monday through Friday, 08:00 to 16:00.
   */
  week?: Partial<Record<Weekday, readonly Shift[]>>

  /** Non-working dates as `YYYY-MM-DD` in local time. Overrides the weekly pattern. */
  holidays?: readonly string[]

  /**
   * Per-date shift overrides as `YYYY-MM-DD` in local time. Use for a Saturday catch-up, or a
   * half day before a holiday. Takes precedence over both the weekly pattern and `holidays`.
   */
  exceptions?: Readonly<Record<string, readonly Shift[]>>

  /**
   * Minutes east of UTC: `120` for UTC+2. Defaults to 0.
   *
   * Pass a {@link UtcOffsetResolver} instead of a number for zones with daylight saving, so the
   * offset is resolved for each instant rather than frozen at one. `offsetForZone('Europe/Oslo')`
   * and `hostOffset` both do this.
   */
  utcOffsetMinutes?: number | UtcOffsetResolver
}

/** Minute-of-day interval, resolved from a {@link Shift}. */
interface Interval {
  start: number
  end: number
}

const DEFAULT_WEEK: Partial<Record<Weekday, readonly Shift[]>> = {
  1: [{ start: '08:00', end: '16:00' }],
  2: [{ start: '08:00', end: '16:00' }],
  3: [{ start: '08:00', end: '16:00' }],
  4: [{ start: '08:00', end: '16:00' }],
  5: [{ start: '08:00', end: '16:00' }],
}

/** Guards the day-walking loops against a configuration that never yields working time. */
const MAX_DAYS_SCANNED = 40_000

export class WorkingWeekCalendar implements Calendar {
  readonly nominalHoursPerDay: number

  private readonly week: Map<Weekday, Interval[]>
  private readonly holidays: Set<string>
  private readonly exceptions: Map<string, Interval[]>
  private readonly offset: number | UtcOffsetResolver

  constructor(options: WorkingWeekOptions = {}) {
    const { week = DEFAULT_WEEK, holidays = [], exceptions = {}, utcOffsetMinutes = 0 } = options

    if (typeof utcOffsetMinutes === 'number') {
      if (!Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 16 * 60) {
        throw new RangeError(
          'utcOffsetMinutes must be a whole number of minutes within +/- 16 hours, or a resolver function',
        )
      }
    } else if (typeof utcOffsetMinutes !== 'function') {
      throw new TypeError('utcOffsetMinutes must be a number of minutes or a resolver function')
    }
    this.offset = utcOffsetMinutes

    this.week = new Map()
    for (let day = 0 as Weekday; day <= 6; day = (day + 1) as Weekday) {
      this.week.set(day, normaliseShifts(week[day] ?? [], `weekday ${day}`))
    }

    this.holidays = new Set(holidays.map(assertDateKey))
    this.exceptions = new Map(
      Object.entries(exceptions).map(([key, shifts]) => [
        assertDateKey(key),
        normaliseShifts(shifts, `exception ${key}`),
      ]),
    )

    const weeklyMinutes = [...this.week.values()]
      .flat()
      .reduce((total, interval) => total + (interval.end - interval.start), 0)
    if (weeklyMinutes === 0 && this.exceptions.size === 0) {
      throw new RangeError('Calendar has no working time at all; nothing could ever be scheduled')
    }

    // Nominal day length is the mean over days that actually have work, so a week of four
    // ten-hour days reports a ten-hour day rather than a diluted seven.
    const workingDayCount = [...this.week.values()].filter((day) => day.length > 0).length
    this.nominalHoursPerDay =
      workingDayCount === 0 ? 8 : weeklyMinutes / workingDayCount / 60
  }

  isWorkingTime(at: Date): boolean {
    const localMs = at.getTime() + this.offsetMsAt(at)
    const dayIndex = Math.floor(localMs / MS_PER_DAY)
    const minuteOfDay = (localMs - dayIndex * MS_PER_DAY) / MS_PER_MINUTE
    return this.intervalsForDay(dayIndex).some(
      (interval) => minuteOfDay >= interval.start && minuteOfDay < interval.end,
    )
  }

  addWorkingTime(from: Date, hours: Hours): Date {
    if (hours === 0) return new Date(from.getTime())
    return hours > 0 ? this.advance(from, hours) : this.retreat(from, -hours)
  }

  workingHoursBetween(from: Date, to: Date): Hours {
    if (to.getTime() === from.getTime()) return 0
    if (to.getTime() < from.getTime()) return -this.workingHoursBetween(to, from)

    let total = 0
    const lastDay = this.dayIndexOf(to)
    for (let day = this.dayIndexOf(from); day <= lastDay; day++) {
      for (const span of this.spansForDay(day)) {
        const start = Math.max(span.start, from.getTime())
        const end = Math.min(span.end, to.getTime())
        if (end > start) total += (end - start) / MS_PER_HOUR
      }
    }
    return total
  }

  /**
   * Fractional working days, weighted by each day's own length: a fully worked day counts as one,
   * a half-worked day as a half. This is why the interval is not simply divided by
   * {@link nominalHoursPerDay} - under a variable week, days are not interchangeable.
   */
  countWorkingDays(from: Date, to: Date): number {
    if (to.getTime() === from.getTime()) return 0
    if (to.getTime() < from.getTime()) return -this.countWorkingDays(to, from)

    let total = 0
    const lastDay = this.dayIndexOf(to)
    for (let day = this.dayIndexOf(from); day <= lastDay; day++) {
      const spans = this.spansForDay(day)
      let dayCapacity = 0
      let dayWorked = 0
      for (const span of spans) {
        dayCapacity += span.end - span.start
        const start = Math.max(span.start, from.getTime())
        const end = Math.min(span.end, to.getTime())
        if (end > start) dayWorked += end - start
      }
      if (dayCapacity > 0) total += dayWorked / dayCapacity
    }
    return total
  }

  /** First working moment at or after `at`. Use for start instants. */
  nextWorkingMoment(at: Date): Date {
    if (this.isWorkingTime(at)) return new Date(at.getTime())

    const startDay = this.dayIndexOf(at)
    for (let day = startDay; day < startDay + MAX_DAYS_SCANNED; day++) {
      for (const span of this.spansForDay(day)) {
        if (span.start >= at.getTime()) return new Date(span.start)
        if (span.end > at.getTime()) return new Date(at.getTime())
      }
    }
    throw new RangeError('No working time found within the scan horizon after the given instant')
  }

  /**
   * Last working moment at or before `at`. Use for finish instants.
   *
   * The end of a shift counts: a task finishing at 16:00 reports 16:00, not a rewind into the
   * afternoon. Applying the forward rule here instead would push finishes into the next working
   * day and make milestones appear to drift.
   */
  previousWorkingMoment(at: Date): Date {
    const startDay = this.dayIndexOf(at)
    for (let day = startDay; day > startDay - MAX_DAYS_SCANNED; day--) {
      const spans = this.spansForDay(day)
      for (let index = spans.length - 1; index >= 0; index--) {
        const span = spans[index]!
        if (span.end <= at.getTime()) return new Date(span.end)
        if (span.start <= at.getTime()) return new Date(at.getTime())
      }
    }
    throw new RangeError('No working time found within the scan horizon before the given instant')
  }

  // ---- internals ----

  private advance(from: Date, hours: Hours): Date {
    let remaining = hours * MS_PER_HOUR
    let cursor = from.getTime()
    const startDay = this.dayIndexOf(from)

    for (let day = startDay; day < startDay + MAX_DAYS_SCANNED; day++) {
      for (const span of this.spansForDay(day)) {
        if (span.end <= cursor) continue
        const start = Math.max(span.start, cursor)
        const available = span.end - start
        if (available >= remaining) return new Date(start + remaining)
        remaining -= available
        cursor = span.end
      }
    }
    throw new RangeError('Ran past the scan horizon while adding working time')
  }

  private retreat(from: Date, hours: Hours): Date {
    let remaining = hours * MS_PER_HOUR
    let cursor = from.getTime()
    const startDay = this.dayIndexOf(from)

    for (let day = startDay; day > startDay - MAX_DAYS_SCANNED; day--) {
      const spans = this.spansForDay(day)
      for (let index = spans.length - 1; index >= 0; index--) {
        const span = spans[index]!
        if (span.start >= cursor) continue
        const end = Math.min(span.end, cursor)
        const available = end - span.start
        if (available >= remaining) return new Date(end - remaining)
        remaining -= available
        cursor = span.start
      }
    }
    throw new RangeError('Ran past the scan horizon while subtracting working time')
  }

  /** Offset in milliseconds at a given instant. */
  private offsetMsAt(at: Date): number {
    return (typeof this.offset === 'number' ? this.offset : this.offset(at)) * MS_PER_MINUTE
  }

  /**
   * Offset in milliseconds for a local day, probed near local midday.
   *
   * Probing mid-day rather than at midnight keeps the sample well clear of the transition itself,
   * which is what makes a single lookup per day stable. A transition day is therefore treated as
   * having its post-transition offset throughout; the residual error is confined to that one day
   * instead of running for months, which is what a fixed offset does.
   */
  private offsetMsForDay(dayIndex: number): number {
    if (typeof this.offset === 'number') return this.offset * MS_PER_MINUTE
    const probe = new Date(dayIndex * MS_PER_DAY + 12 * MS_PER_HOUR)
    return this.offset(probe) * MS_PER_MINUTE
  }

  private dayIndexOf(at: Date): number {
    return Math.floor((at.getTime() + this.offsetMsAt(at)) / MS_PER_DAY)
  }

  /** Working intervals for a local day index, as absolute UTC millisecond spans. */
  private spansForDay(dayIndex: number): Interval[] {
    const midnightUtc = dayIndex * MS_PER_DAY - this.offsetMsForDay(dayIndex)
    return this.intervalsForDay(dayIndex).map((interval) => ({
      start: midnightUtc + interval.start * MS_PER_MINUTE,
      end: midnightUtc + interval.end * MS_PER_MINUTE,
    }))
  }

  /** Minute-of-day intervals for a local day index, applying exceptions then holidays. */
  private intervalsForDay(dayIndex: number): Interval[] {
    const key = dateKeyOf(dayIndex)
    const exception = this.exceptions.get(key)
    if (exception !== undefined) return exception
    if (this.holidays.has(key)) return []
    const weekday = new Date(dayIndex * MS_PER_DAY).getUTCDay() as Weekday
    return this.week.get(weekday) ?? []
  }
}

function normaliseShifts(shifts: readonly Shift[], context: string): Interval[] {
  const intervals = shifts
    .map((shift) => ({
      start: parseClock(shift.start, context),
      end: parseClock(shift.end, context),
    }))
    .sort((a, b) => a.start - b.start)

  let previousEnd = -1
  for (const interval of intervals) {
    if (interval.end <= interval.start) {
      throw new RangeError(`Shift on ${context} ends at or before it starts`)
    }
    if (interval.start < previousEnd) {
      throw new RangeError(`Overlapping shifts on ${context}`)
    }
    previousEnd = interval.end
  }
  return intervals
}

/** `HH:MM` to minutes past local midnight. `24:00` is accepted as end of day. */
function parseClock(value: string, context: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (match === null) throw new RangeError(`Invalid time "${value}" on ${context}; expected HH:MM`)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const total = hours * 60 + minutes
  if (minutes > 59 || total > MINUTES_PER_DAY) {
    throw new RangeError(`Time "${value}" on ${context} is outside a single day`)
  }
  return total
}

function assertDateKey(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`Invalid date "${value}"; expected YYYY-MM-DD`)
  }
  return value
}

function dateKeyOf(dayIndex: number): string {
  return new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10)
}
