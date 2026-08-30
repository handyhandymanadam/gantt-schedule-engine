import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ContinuousCalendar, MS_PER_HOUR, continuousCalendar } from '../src/calendar.js'

const at = (iso: string): Date => new Date(iso)

describe('ContinuousCalendar', () => {
  it('treats every instant as working time', () => {
    const calendar = new ContinuousCalendar(8)
    expect(calendar.isWorkingTime(at('2026-08-30T03:17:00Z'))).toBe(true)
    expect(calendar.isWorkingTime(at('2026-01-01T00:00:00Z'))).toBe(true)
  })

  it('adds working time as plain elapsed time', () => {
    const calendar = new ContinuousCalendar(8)
    expect(calendar.addWorkingTime(at('2026-08-30T08:00:00Z'), 24)).toEqual(at('2026-08-31T08:00:00Z'))
  })

  it('walks backward on negative hours', () => {
    const calendar = new ContinuousCalendar(8)
    expect(calendar.addWorkingTime(at('2026-08-31T08:00:00Z'), -24)).toEqual(at('2026-08-30T08:00:00Z'))
  })

  it('measures working hours between two instants, signed', () => {
    const calendar = new ContinuousCalendar(8)
    const start = at('2026-08-30T08:00:00Z')
    const finish = at('2026-08-30T14:30:00Z')
    expect(calendar.workingHoursBetween(start, finish)).toBe(6.5)
    expect(calendar.workingHoursBetween(finish, start)).toBe(-6.5)
  })

  it('reports days against its nominal day length', () => {
    const calendar = new ContinuousCalendar(8)
    // 60 working hours is 7.5 days on an 8-hour nominal day.
    expect(calendar.countWorkingDays(at('2026-08-30T00:00:00Z'), at('2026-09-01T12:00:00Z'))).toBe(7.5)
  })

  it('normalises start and finish instants to themselves, since all time is working time', () => {
    const calendar = new ContinuousCalendar(8)
    const moment = at('2026-08-30T17:00:00Z')
    expect(calendar.nextWorkingMoment(moment)).toEqual(moment)
    expect(calendar.previousWorkingMoment(moment)).toEqual(moment)
  })

  it('rejects a non-positive nominal day length', () => {
    expect(() => new ContinuousCalendar(0)).toThrow(RangeError)
    expect(() => new ContinuousCalendar(-8)).toThrow(RangeError)
    expect(() => new ContinuousCalendar(Number.NaN)).toThrow(RangeError)
  })

  it('exposes an 8-hour nominal day by default from the shared instance', () => {
    expect(continuousCalendar.nominalHoursPerDay).toBe(8)
  })
})

describe('ContinuousCalendar properties', () => {
  const anyInstant = fc
    .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2050, 0, 1) })
    .map((ms) => new Date(ms))

  // Hours are constrained to whole values so the round trip stays exact in floating point.
  const anyHours = fc.integer({ min: -10_000, max: 10_000 })

  it('addWorkingTime and workingHoursBetween are inverses', () => {
    fc.assert(
      fc.property(anyInstant, anyHours, (from, hours) => {
        const calendar = new ContinuousCalendar(8)
        const moved = calendar.addWorkingTime(from, hours)
        expect(calendar.workingHoursBetween(from, moved)).toBe(hours)
      }),
    )
  })

  it('adding zero working time is identity', () => {
    fc.assert(
      fc.property(anyInstant, (from) => {
        const calendar = new ContinuousCalendar(8)
        expect(calendar.addWorkingTime(from, 0).getTime()).toBe(from.getTime())
      }),
    )
  })

  it('advancing is monotonic in hours', () => {
    fc.assert(
      fc.property(anyInstant, anyHours, fc.integer({ min: 1, max: 5_000 }), (from, hours, extra) => {
        const calendar = new ContinuousCalendar(8)
        const nearer = calendar.addWorkingTime(from, hours)
        const further = calendar.addWorkingTime(from, hours + extra)
        expect(further.getTime()).toBeGreaterThan(nearer.getTime())
      }),
    )
  })

  it('measures in whole hours consistently with the millisecond constant', () => {
    fc.assert(
      fc.property(anyInstant, anyHours, (from, hours) => {
        const calendar = new ContinuousCalendar(8)
        const moved = calendar.addWorkingTime(from, hours)
        expect(moved.getTime() - from.getTime()).toBe(hours * MS_PER_HOUR)
      }),
    )
  })
})
