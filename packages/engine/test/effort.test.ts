import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { WorkingWeekCalendar } from '../src/working-week.js'
import {
  deriveDuration,
  deriveEffort,
  durationInDays,
  reconcileTask,
  snapHours,
  withResourceCount,
} from '../src/effort.js'
import { validate } from '../src/validate.js'
import type { Task } from '../src/types.js'

/** Mon-Fri, 08:00-16:00: a nominal eight-hour day. */
const calendar = new WorkingWeekCalendar()

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 't',
  basis: 'duration',
  resourceCount: 1,
  duration: 8,
  start: new Date('2026-01-05T08:00:00Z'),
  schedulingMode: 'manual',
  ...overrides,
})

describe('deriveDuration', () => {
  it('divides work by resource count', () => {
    // 240 work units across 4 resources is 60 hours, which is 7.5 eight-hour days.
    expect(deriveDuration(240, 4, calendar)).toBe(60)
    expect(durationInDays(60, calendar)).toBe(7.5)
  })

  it('shortens the task when a resource is added', () => {
    expect(deriveDuration(240, 4, calendar)).toBe(60)
    expect(deriveDuration(240, 5, calendar)).toBe(48)
  })

  it('stays exact by default, without rounding', () => {
    expect(deriveDuration(240, 7, calendar)).toBeCloseTo(34.285714, 6)
  })

  it('accepts a fractional resource count', () => {
    // A supervisor split across three jobs.
    expect(deriveDuration(12, 0.33, calendar)).toBeCloseTo(36.3636, 4)
  })

  it('rejects a non-positive resource count', () => {
    expect(() => deriveDuration(100, 0, calendar)).toThrow(RangeError)
    expect(() => deriveDuration(100, -2, calendar)).toThrow(RangeError)
  })

  it('rejects negative or non-finite work', () => {
    expect(() => deriveDuration(-1, 2, calendar)).toThrow(RangeError)
    expect(() => deriveDuration(Number.NaN, 2, calendar)).toThrow(RangeError)
  })
})

describe('deriveEffort', () => {
  it('multiplies duration by resource count', () => {
    expect(deriveEffort(60, 4)).toBe(240)
  })

  it('round-trips with deriveDuration', () => {
    expect(deriveDuration(deriveEffort(60, 4), 4, calendar)).toBe(60)
  })
})

describe('snapHours', () => {
  it('rounds up to the half day by default', () => {
    // 34.29 hours is 4.29 eight-hour days, so it snaps to 4.5 days: 36 hours.
    expect(snapHours(240 / 7, calendar, { dayFraction: 0.5 })).toBe(36)
  })

  it('supports nearest and down', () => {
    const awkward = 240 / 7
    expect(snapHours(awkward, calendar, { dayFraction: 0.5, rounding: 'nearest' })).toBe(36)
    expect(snapHours(awkward, calendar, { dayFraction: 0.5, rounding: 'down' })).toBe(32)
  })

  it('snaps to whole and quarter days too', () => {
    expect(snapHours(34.28, calendar, { dayFraction: 1 })).toBe(40)
    expect(snapHours(34.28, calendar, { dayFraction: 0.25 })).toBe(36)
  })

  it('leaves an exact multiple untouched', () => {
    expect(snapHours(60, calendar, { dayFraction: 0.5 })).toBe(60)
    expect(snapHours(60, calendar, { dayFraction: 0.5, rounding: 'down' })).toBe(60)
  })

  it('keeps a milestone a milestone', () => {
    // Zero must never round up into work, or the milestone stops being an instant.
    expect(snapHours(0, calendar, { dayFraction: 0.5 })).toBe(0)
    expect(snapHours(0, calendar, { dayFraction: 1, rounding: 'nearest' })).toBe(0)
  })

  it('never collapses real work into an instant', () => {
    // One hour under half-day snapping rounds to half a day, not to zero, even rounding down.
    expect(snapHours(1, calendar, { dayFraction: 0.5, rounding: 'down' })).toBe(4)
    expect(snapHours(0.5, calendar, { dayFraction: 1, rounding: 'nearest' })).toBe(8)
  })

  it('follows the calendar nominal day rather than assuming eight hours', () => {
    const tenHourDays = new WorkingWeekCalendar({
      week: {
        1: [{ start: '07:00', end: '17:00' }],
        2: [{ start: '07:00', end: '17:00' }],
        3: [{ start: '07:00', end: '17:00' }],
        4: [{ start: '07:00', end: '17:00' }],
      },
    })
    expect(tenHourDays.nominalHoursPerDay).toBe(10)
    expect(snapHours(12, tenHourDays, { dayFraction: 0.5 })).toBe(15)
  })

  it('rejects a non-positive granularity', () => {
    expect(() => snapHours(10, calendar, { dayFraction: 0 })).toThrow(RangeError)
  })
})

describe('reconcileTask', () => {
  it('recomputes duration for a work-driven task', () => {
    const framing = task({ basis: 'effort', effort: 240, resourceCount: 4, duration: 0 })
    expect(reconcileTask(framing, calendar).duration).toBe(60)
  })

  it('recomputes work for a duration-driven task', () => {
    const curing = task({ basis: 'duration', duration: 56, resourceCount: 2 })
    expect(reconcileTask(curing, calendar).effort).toBe(112)
  })

  it('produces a task that passes the invariant check', () => {
    const framing = task({ basis: 'effort', effort: 240, resourceCount: 7, duration: 999 })
    const fixed = reconcileTask(framing, calendar)
    expect(validate({ tasks: [fixed] }).errors).toEqual([])
  })

  it('does not mutate its input', () => {
    const original = task({ basis: 'effort', effort: 240, resourceCount: 4, duration: 0 })
    reconcileTask(original, calendar)
    expect(original.duration).toBe(0)
  })

  it('throws when a work-driven task has no work value', () => {
    expect(() => reconcileTask(task({ basis: 'effort' }), calendar)).toThrow(/no effort value/)
  })
})

describe('withResourceCount', () => {
  const framing = task({ id: 'framing', basis: 'effort', effort: 240, resourceCount: 4, duration: 60 })
  const curing = task({ id: 'curing', basis: 'duration', duration: 56, resourceCount: 2, effort: 112 })

  it('shortens a work-driven task when a resource joins', () => {
    const withFive = withResourceCount(framing, 5, calendar)
    expect(withFive.duration).toBe(48)
    expect(withFive.effort).toBe(240) // work is the invariant, so it is preserved
  })

  it('lengthens a work-driven task when a resource is lost', () => {
    // The absence case: one of four calls in sick.
    const withThree = withResourceCount(framing, 3, calendar)
    expect(withThree.duration).toBe(80)
    expect(withThree.effort).toBe(240)
  })

  it('holds the window on a duration-driven task and moves the work instead', () => {
    const withSix = withResourceCount(curing, 6, calendar)
    expect(withSix.duration).toBe(56) // unchanged: physics does not care how many people watch
    expect(withSix.effort).toBe(336)
  })

  it('applies snapping when asked', () => {
    const withSeven = withResourceCount(framing, 7, calendar, { dayFraction: 0.5 })
    expect(withSeven.duration).toBe(36) // 34.29 exact, snapped up to 4.5 days
  })

  it('does not mutate its input', () => {
    withResourceCount(framing, 9, calendar)
    expect(framing.resourceCount).toBe(4)
    expect(framing.duration).toBe(60)
  })
})

describe('properties', () => {
  const positive = fc.integer({ min: 1, max: 5_000 })
  const count = fc.integer({ min: 1, max: 50 })

  it('preserves the effort / resourceCount === duration invariant', () => {
    fc.assert(
      fc.property(positive, count, (effort, resourceCount) => {
        const reconciled = reconcileTask(
          task({ basis: 'effort', effort, resourceCount, duration: 0 }),
          calendar,
        )
        expect(validate({ tasks: [reconciled] }).errors).toEqual([])
      }),
    )
  })

  it('keeps work constant across any sequence of resource changes on a work-driven task', () => {
    fc.assert(
      fc.property(positive, fc.array(count, { minLength: 1, maxLength: 8 }), (effort, changes) => {
        let current = task({ basis: 'effort', effort, resourceCount: 1, duration: effort })
        for (const next of changes) {
          current = withResourceCount(current, next, calendar)
        }
        expect(current.effort).toBe(effort)
        expect(current.duration).toBeCloseTo(effort / changes[changes.length - 1]!, 9)
      }),
    )
  })

  it('never snaps a positive duration to zero, and never snaps zero to positive', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 500, noNaN: true }),
        fc.constantFrom(0.25, 0.5, 1, 2),
        fc.constantFrom('up' as const, 'nearest' as const, 'down' as const),
        (hours, dayFraction, rounding) => {
          const snapped = snapHours(hours, calendar, { dayFraction, rounding })
          if (hours === 0) expect(snapped).toBe(0)
          else expect(snapped).toBeGreaterThan(0)
        },
      ),
    )
  })

  it('always snaps to a whole number of granularity units', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 500, noNaN: true }),
        fc.constantFrom(0.25, 0.5, 1),
        (hours, dayFraction) => {
          const unit = dayFraction * calendar.nominalHoursPerDay
          const snapped = snapHours(hours, calendar, { dayFraction })
          expect(Math.abs(snapped / unit - Math.round(snapped / unit))).toBeLessThan(1e-9)
        },
      ),
    )
  })

  it('rounds up at least as far as nearest, and nearest at least as far as down', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 500, noNaN: true }), (hours) => {
        const options = { dayFraction: 0.5 }
        const up = snapHours(hours, calendar, { ...options, rounding: 'up' })
        const nearest = snapHours(hours, calendar, { ...options, rounding: 'nearest' })
        const down = snapHours(hours, calendar, { ...options, rounding: 'down' })
        expect(up).toBeGreaterThanOrEqual(nearest)
        expect(nearest).toBeGreaterThanOrEqual(down)
      }),
    )
  })
})
