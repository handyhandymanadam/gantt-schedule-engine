import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ContinuousCalendar } from '../src/calendar.js'
import { WorkingWeekCalendar, type Shift } from '../src/working-week.js'
import { calculateCriticalPath } from '../src/critical-path.js'
import type { Link, Task } from '../src/types.js'

/** 2026-01-05 is a Monday. All fixtures are anchored to that week. */
const MON = '2026-01-05'
const at = (date: string, time = '00:00'): Date => new Date(`${date}T${time}:00.000Z`)

const iso = (date: Date): string => date.toISOString().slice(0, 16).replace('T', ' ')

const nineToFive: Shift[] = [{ start: '08:00', end: '16:00' }]
const weekdays = new WorkingWeekCalendar() // defaults to Mon-Fri 08:00-16:00

describe('WorkingWeekCalendar: working time', () => {
  it('knows which instants are working time', () => {
    expect(weekdays.isWorkingTime(at(MON, '09:00'))).toBe(true)
    expect(weekdays.isWorkingTime(at(MON, '07:59'))).toBe(false)
    expect(weekdays.isWorkingTime(at('2026-01-10', '09:00'))).toBe(false) // Saturday
    expect(weekdays.isWorkingTime(at('2026-01-11', '09:00'))).toBe(false) // Sunday
  })

  it('excludes the end of a shift, so a day is exactly eight hours', () => {
    expect(weekdays.isWorkingTime(at(MON, '15:59'))).toBe(true)
    expect(weekdays.isWorkingTime(at(MON, '16:00'))).toBe(false)
    expect(weekdays.workingHoursBetween(at(MON, '08:00'), at(MON, '16:00'))).toBe(8)
  })

  it('reports the nominal day length', () => {
    expect(weekdays.nominalHoursPerDay).toBe(8)
  })
})

describe('WorkingWeekCalendar: advancing', () => {
  it('completes a single day within the day', () => {
    expect(iso(weekdays.addWorkingTime(at(MON, '08:00'), 8))).toBe('2026-01-05 16:00')
  })

  it('carries across a weekend', () => {
    // Friday noon plus eight hours: four hours Friday, four hours Monday.
    expect(iso(weekdays.addWorkingTime(at('2026-01-09', '12:00'), 8))).toBe('2026-01-12 12:00')
  })

  it('finishes a three-day task starting Thursday on the Monday', () => {
    // The case that makes calendars non-optional: 24 working hours from Thursday morning.
    expect(iso(weekdays.addWorkingTime(at('2026-01-08', '08:00'), 24))).toBe('2026-01-12 16:00')
  })

  it('resumes at the start of the next shift from outside working time', () => {
    // Saturday plus one hour lands at Monday 09:00, not Saturday 10:00.
    expect(iso(weekdays.addWorkingTime(at('2026-01-10', '09:00'), 1))).toBe('2026-01-12 09:00')
  })

  it('walks backward on negative hours', () => {
    expect(iso(weekdays.addWorkingTime(at('2026-01-12', '12:00'), -8))).toBe('2026-01-09 12:00')
  })

  it('adding zero is identity even outside working time', () => {
    const saturday = at('2026-01-10', '09:00')
    expect(weekdays.addWorkingTime(saturday, 0)).toEqual(saturday)
  })

  it('round-trips forward and back', () => {
    const start = at(MON, '10:00')
    const moved = weekdays.addWorkingTime(start, 37)
    expect(weekdays.addWorkingTime(moved, -37)).toEqual(start)
  })
})

describe('WorkingWeekCalendar: measuring', () => {
  it('counts only working hours across a weekend', () => {
    expect(weekdays.workingHoursBetween(at(MON, '08:00'), at('2026-01-09', '16:00'))).toBe(40)
    expect(weekdays.workingHoursBetween(at('2026-01-09', '16:00'), at('2026-01-12', '08:00'))).toBe(0)
  })

  it('is signed', () => {
    const a = at(MON, '08:00')
    const b = at('2026-01-06', '08:00')
    expect(weekdays.workingHoursBetween(a, b)).toBe(8)
    expect(weekdays.workingHoursBetween(b, a)).toBe(-8)
  })

  it('reports fractional working days weighted by each day own length', () => {
    expect(weekdays.countWorkingDays(at(MON, '08:00'), at('2026-01-09', '16:00'))).toBe(5)
    expect(weekdays.countWorkingDays(at(MON, '08:00'), at(MON, '12:00'))).toBe(0.5)
    // A weekend contributes nothing at all.
    expect(weekdays.countWorkingDays(at('2026-01-09', '16:00'), at('2026-01-12', '08:00'))).toBe(0)
  })
})

describe('WorkingWeekCalendar: boundary normalisation', () => {
  it('moves a start instant forward to the next working moment', () => {
    expect(iso(weekdays.nextWorkingMoment(at('2026-01-10', '09:00')))).toBe('2026-01-12 08:00')
    expect(iso(weekdays.nextWorkingMoment(at(MON, '16:00')))).toBe('2026-01-06 08:00')
  })

  it('moves a finish instant back to the previous working moment', () => {
    expect(iso(weekdays.previousWorkingMoment(at('2026-01-10', '09:00')))).toBe('2026-01-09 16:00')
  })

  it('treats the end of a shift as a valid finish instant', () => {
    // The milestone rule: work finishing at 16:00 reports 16:00, while a successor starting
    // from that instant reports the next morning.
    const endOfDay = at(MON, '16:00')
    expect(iso(weekdays.previousWorkingMoment(endOfDay))).toBe('2026-01-05 16:00')
    expect(iso(weekdays.nextWorkingMoment(endOfDay))).toBe('2026-01-06 08:00')
  })

  it('leaves an instant already inside working time alone', () => {
    const midMorning = at(MON, '09:30')
    expect(weekdays.nextWorkingMoment(midMorning)).toEqual(midMorning)
    expect(weekdays.previousWorkingMoment(midMorning)).toEqual(midMorning)
  })
})

describe('WorkingWeekCalendar: holidays, exceptions and shifts', () => {
  it('skips a holiday', () => {
    const calendar = new WorkingWeekCalendar({ holidays: ['2026-01-06'] })
    // Monday plus 16 hours would normally be Tuesday; Tuesday is a holiday, so Wednesday.
    expect(iso(calendar.addWorkingTime(at(MON, '08:00'), 16))).toBe('2026-01-07 16:00')
    expect(calendar.isWorkingTime(at('2026-01-06', '09:00'))).toBe(false)
  })

  it('honours a one-off working Saturday', () => {
    const calendar = new WorkingWeekCalendar({
      exceptions: { '2026-01-10': nineToFive },
    })
    expect(calendar.isWorkingTime(at('2026-01-10', '09:00'))).toBe(true)
    // Friday noon plus eight hours now runs into the Saturday rather than to Monday.
    expect(iso(calendar.addWorkingTime(at('2026-01-09', '12:00'), 8))).toBe('2026-01-10 12:00')
  })

  it('lets an exception override a holiday', () => {
    const calendar = new WorkingWeekCalendar({
      holidays: ['2026-01-06'],
      exceptions: { '2026-01-06': [{ start: '08:00', end: '12:00' }] },
    })
    expect(calendar.isWorkingTime(at('2026-01-06', '09:00'))).toBe(true)
    expect(calendar.countWorkingDays(at('2026-01-06', '08:00'), at('2026-01-06', '12:00'))).toBe(1)
  })

  it('supports split shifts with a break between them', () => {
    const calendar = new WorkingWeekCalendar({
      week: {
        1: [
          { start: '08:00', end: '12:00' },
          { start: '13:00', end: '17:00' },
        ],
      },
    })
    expect(calendar.isWorkingTime(at(MON, '12:30'))).toBe(false)
    // Five hours from 08:00 spans the break: four hours before, one after.
    expect(iso(calendar.addWorkingTime(at(MON, '08:00'), 5))).toBe('2026-01-05 14:00')
    expect(calendar.workingHoursBetween(at(MON, '08:00'), at(MON, '17:00'))).toBe(8)
  })

  it('supports a variable week with different day lengths', () => {
    const calendar = new WorkingWeekCalendar({
      week: {
        1: [{ start: '07:00', end: '17:00' }], // 10 hours
        2: [{ start: '07:00', end: '17:00' }],
        3: [{ start: '07:00', end: '17:00' }],
        4: [{ start: '07:00', end: '17:00' }],
        5: [{ start: '07:00', end: '11:00' }], // 4-hour Friday
      },
    })
    expect(calendar.workingHoursBetween(at(MON, '07:00'), at('2026-01-09', '11:00'))).toBe(44)
    // A half-day Friday still counts as one whole working day, since the day is fully worked.
    expect(calendar.countWorkingDays(at('2026-01-09', '07:00'), at('2026-01-09', '11:00'))).toBe(1)
  })

  it('applies a fixed UTC offset', () => {
    // At UTC+2, local 08:00 is 06:00 UTC.
    const calendar = new WorkingWeekCalendar({ utcOffsetMinutes: 120 })
    expect(calendar.isWorkingTime(at(MON, '06:00'))).toBe(true)
    expect(calendar.isWorkingTime(at(MON, '05:59'))).toBe(false)
  })
})

describe('WorkingWeekCalendar: configuration errors', () => {
  it('rejects a shift that ends before it starts', () => {
    expect(() => new WorkingWeekCalendar({ week: { 1: [{ start: '16:00', end: '08:00' }] } })).toThrow(
      RangeError,
    )
  })

  it('rejects overlapping shifts', () => {
    expect(
      () =>
        new WorkingWeekCalendar({
          week: {
            1: [
              { start: '08:00', end: '13:00' },
              { start: '12:00', end: '17:00' },
            ],
          },
        }),
    ).toThrow(/Overlapping/)
  })

  it('rejects malformed times and dates', () => {
    expect(() => new WorkingWeekCalendar({ week: { 1: [{ start: '8am', end: '16:00' }] } })).toThrow(
      /HH:MM/,
    )
    expect(() => new WorkingWeekCalendar({ holidays: ['05-01-2026'] })).toThrow(/YYYY-MM-DD/)
  })

  it('rejects a calendar with no working time at all', () => {
    expect(() => new WorkingWeekCalendar({ week: {} })).toThrow(/no working time/)
  })

  it('rejects an implausible UTC offset', () => {
    expect(() => new WorkingWeekCalendar({ utcOffsetMinutes: 20 * 60 })).toThrow(RangeError)
  })

  it('accepts 24:00 as end of day', () => {
    const calendar = new WorkingWeekCalendar({ week: { 1: [{ start: '00:00', end: '24:00' }] } })
    expect(calendar.workingHoursBetween(at(MON), at('2026-01-06'))).toBe(24)
  })
})

/**
 * The regression guarantee from the build order: a working-week calendar given a 24/7 week must
 * reproduce the continuous calendar exactly. If these diverge, calendar-aware arithmetic has
 * introduced an error that the hand-worked CPM examples would otherwise hide.
 */
describe('WorkingWeekCalendar: equivalence with ContinuousCalendar under a 24/7 week', () => {
  const allHours: Shift[] = [{ start: '00:00', end: '24:00' }]
  const alwaysOn = new WorkingWeekCalendar({
    week: { 0: allHours, 1: allHours, 2: allHours, 3: allHours, 4: allHours, 5: allHours, 6: allHours },
  })
  const continuous = new ContinuousCalendar(24)

  it('reports the same nominal day', () => {
    expect(alwaysOn.nominalHoursPerDay).toBe(continuous.nominalHoursPerDay)
  })

  it('treats every instant as working time', () => {
    expect(alwaysOn.isWorkingTime(at('2026-01-10', '03:17'))).toBe(true)
  })

  it('agrees on arithmetic across arbitrary instants and durations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) }),
        fc.integer({ min: -500, max: 500 }),
        (ms, hours) => {
          const from = new Date(ms - (ms % 60_000)) // whole minutes
          expect(alwaysOn.addWorkingTime(from, hours)).toEqual(continuous.addWorkingTime(from, hours))
        },
      ),
    )
  })

  it('agrees on measurement', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 6, 1) }),
        fc.integer({ min: 0, max: 5_000 }),
        (ms, hours) => {
          const from = new Date(ms - (ms % 60_000))
          const to = continuous.addWorkingTime(from, hours)
          expect(alwaysOn.workingHoursBetween(from, to)).toBeCloseTo(
            continuous.workingHoursBetween(from, to),
            9,
          )
        },
      ),
    )
  })

  it('produces an identical critical path for the worked example', () => {
    const task = (id: string, duration: number, mode: 'auto' | 'manual' = 'auto'): Task => ({
      id,
      basis: 'duration',
      resourceCount: 1,
      duration,
      start: at('2026-01-01'),
      schedulingMode: mode,
    })
    const link = (source: string, target: string): Link => ({
      id: `${source}->${target}`,
      source,
      target,
      type: 'FS',
      lag: 0,
    })

    const tasks = [
      task('A', 3, 'manual'),
      task('B', 4, 'manual'),
      task('C', 2),
      task('D', 5),
      task('E', 4),
      task('F', 2),
    ]
    const links = [link('A', 'C'), link('B', 'D'), link('C', 'E'), link('D', 'E'), link('E', 'F')]

    const underContinuous = calculateCriticalPath({ tasks, links, calendar: continuous })
    const underWorkingWeek = calculateCriticalPath({ tasks, links, calendar: alwaysOn })

    expect(underWorkingWeek.criticalPath).toEqual(underContinuous.criticalPath)
    expect(underWorkingWeek.projectDuration).toBe(underContinuous.projectDuration)
    expect(underWorkingWeek.tasks).toEqual(underContinuous.tasks)
  })
})

describe('WorkingWeekCalendar: properties', () => {
  const anyInstant = fc
    .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2028, 0, 1) })
    .map((ms) => new Date(ms - (ms % 60_000)))

  it('advancing then measuring returns the hours advanced', () => {
    fc.assert(
      fc.property(anyInstant, fc.integer({ min: 0, max: 400 }), (from, hours) => {
        const moved = weekdays.addWorkingTime(from, hours)
        expect(weekdays.workingHoursBetween(from, moved)).toBeCloseTo(hours, 9)
      }),
    )
  })

  it('always lands on working time when advancing a positive amount', () => {
    fc.assert(
      fc.property(anyInstant, fc.integer({ min: 1, max: 200 }), (from, hours) => {
        const moved = weekdays.addWorkingTime(from, hours)
        // The instant reached is the end of consumed work, so the moment just before it is
        // working time even when the landing instant is itself a shift boundary.
        expect(weekdays.isWorkingTime(new Date(moved.getTime() - 60_000))).toBe(true)
      }),
    )
  })

  it('never moves backward when advancing', () => {
    fc.assert(
      fc.property(anyInstant, fc.integer({ min: 0, max: 300 }), (from, hours) => {
        expect(weekdays.addWorkingTime(from, hours).getTime()).toBeGreaterThanOrEqual(from.getTime())
      }),
    )
  })

  it('normalisation is idempotent', () => {
    fc.assert(
      fc.property(anyInstant, (instant) => {
        const forward = weekdays.nextWorkingMoment(instant)
        expect(weekdays.nextWorkingMoment(forward)).toEqual(forward)
        const back = weekdays.previousWorkingMoment(instant)
        expect(weekdays.previousWorkingMoment(back)).toEqual(back)
      }),
    )
  })

  it('never reports more working hours than elapsed hours', () => {
    fc.assert(
      fc.property(anyInstant, fc.integer({ min: 0, max: 10_000 }), (from, elapsedHours) => {
        const to = new Date(from.getTime() + elapsedHours * 3_600_000)
        expect(weekdays.workingHoursBetween(from, to)).toBeLessThanOrEqual(elapsedHours + 1e-9)
      }),
    )
  })
})
