import type { Hours } from './types.js'

export const MS_PER_HOUR = 3_600_000

/**
 * The working-time port.
 *
 * All scheduling arithmetic runs in working hours and converts to wall-clock only through this
 * interface. That is what lets a real weekday/holiday calendar drop in without touching a line
 * of the CPM code, and why the calendar has to exist from the start rather than be retrofitted.
 */
export interface Calendar {
  isWorkingTime(at: Date): boolean

  /** Advance `hours` of *working* time from `from`. Negative hours walk backward. */
  addWorkingTime(from: Date, hours: Hours): Date

  /** Working hours in the interval. Negative when `to` precedes `from`. */
  workingHoursBetween(from: Date, to: Date): Hours

  /**
   * Working days the interval spans, for *display* only.
   *
   * Implementations must count actual working days rather than dividing elapsed hours by
   * {@link Calendar.nominalHoursPerDay}, because day length can vary (a 10-hour summer schedule
   * against a 6-hour winter one). Dividing is correct only where every working day is identical,
   * which holds for {@link ContinuousCalendar} and generally fails elsewhere.
   */
  countWorkingDays(from: Date, to: Date): number

  /**
   * The first working moment at or after `at`. Use for **start** instants.
   *
   * Paired with {@link Calendar.previousWorkingMoment}, this is the milestone boundary rule. A
   * task finishing Friday 17:00 reports its finish as Friday 17:00, while a successor starting
   * from that same instant reports Monday 08:00. Normalising both the same way makes milestones
   * appear to drift into the following week.
   */
  nextWorkingMoment(at: Date): Date

  /** The last working moment at or before `at`. Use for **finish** instants. */
  previousWorkingMoment(at: Date): Date

  /** Nominal length of a standard working day. Authoring convenience only, never display math. */
  readonly nominalHoursPerDay: number
}

/**
 * Continuous 24/7 time. Every instant is working time.
 *
 * This is the default, and it reproduces naive date arithmetic exactly. That makes it a test
 * oracle: the CPM suite is written against this calendar, and calendar-aware code added later
 * must still reproduce those same results under it.
 */
export class ContinuousCalendar implements Calendar {
  readonly nominalHoursPerDay: number

  constructor(nominalHoursPerDay = 24) {
    if (!Number.isFinite(nominalHoursPerDay) || nominalHoursPerDay <= 0) {
      throw new RangeError('nominalHoursPerDay must be a positive finite number')
    }
    this.nominalHoursPerDay = nominalHoursPerDay
  }

  isWorkingTime(_at: Date): boolean {
    return true
  }

  addWorkingTime(from: Date, hours: Hours): Date {
    return new Date(from.getTime() + hours * MS_PER_HOUR)
  }

  workingHoursBetween(from: Date, to: Date): Hours {
    return (to.getTime() - from.getTime()) / MS_PER_HOUR
  }

  countWorkingDays(from: Date, to: Date): number {
    // Every day is identical under this calendar, so division is exact here.
    return this.workingHoursBetween(from, to) / this.nominalHoursPerDay
  }

  nextWorkingMoment(at: Date): Date {
    return new Date(at.getTime())
  }

  previousWorkingMoment(at: Date): Date {
    return new Date(at.getTime())
  }
}

/** The default calendar: continuous time with a nominal 8-hour day for authoring conveniences. */
export const continuousCalendar: Calendar = new ContinuousCalendar(8)
