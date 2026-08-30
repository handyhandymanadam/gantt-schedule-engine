import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ContinuousCalendar } from '../src/calendar.js'
import { calculateProgressVariance, captureBaseline } from '../src/variance.js'
import type { Task } from '../src/types.js'

const calendar = new ContinuousCalendar(24)
const BASE = new Date('2026-01-01T00:00:00Z')
const h = (hours: number): Date => new Date(BASE.getTime() + hours * 3_600_000)

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  basis: 'effort',
  effort: 240,
  resourceCount: 4,
  duration: 60,
  start: BASE,
  schedulingMode: 'manual',
  ...overrides,
})

describe('captureBaseline', () => {
  it('freezes work and extent per task', () => {
    const baseline = captureBaseline({ tasks: [task('framing')], capturedAt: h(0), calendar })
    expect(baseline.entries).toHaveLength(1)
    expect(baseline.entries[0]).toMatchObject({ taskId: 'framing', duration: 60, effort: 240 })
    expect(baseline.entries[0]!.start).toEqual(BASE)
    expect(baseline.entries[0]!.finish).toEqual(h(60))
  })

  it('derives work for a duration-driven task', () => {
    const curing = task('curing', { basis: 'duration', duration: 56, resourceCount: 2 })
    delete (curing as { effort?: number }).effort
    expect(captureBaseline({ tasks: [curing], capturedAt: h(0), calendar }).entries[0]!.effort).toBe(112)
  })

  it('uses supplied placement over stored dates', () => {
    const placement = new Map([['framing', { start: h(10), finish: h(70) }]])
    const baseline = captureBaseline({ tasks: [task('framing')], capturedAt: h(0), calendar, placement })
    expect(baseline.entries[0]!.start).toEqual(h(10))
  })

  it('records when it was taken, and does not alias the date', () => {
    const at = h(5)
    const baseline = captureBaseline({ tasks: [task('a')], capturedAt: at, calendar })
    at.setTime(0)
    expect(baseline.capturedAt).toEqual(h(5))
  })
})

describe('the worked example', () => {
  // 240 units estimated, 4 resources. Crew reports 40% done; timesheets show 120 hours burned.
  const framing = task('framing', { percentComplete: 40, actualHours: 120 })
  const baseline = captureBaseline({ tasks: [task('framing')], capturedAt: h(0), calendar })
  const result = calculateProgressVariance({ tasks: [framing], calendar, baseline })
  const variance = result.tasks[0]!

  it('earns work in proportion to reported progress', () => {
    expect(variance.earned).toBe(96) // 40% of 240
  })

  it('computes the performance factor as earned over actual', () => {
    expect(variance.performanceFactor).toBeCloseTo(0.8, 9) // 96 / 120
  })

  it('projects the overrun at current productivity', () => {
    // 144 units of plan work remain; at 0.8 they will cost 180.
    expect(variance.effortRemaining).toBeCloseTo(180, 6)
    expect(variance.forecastEffort).toBeCloseTo(300, 6) // 120 spent + 180 to come
    expect(variance.effortVariance).toBeCloseTo(-60, 6) // 240 committed, 300 forecast
    expect(variance.basis).toBe('performance')
  })

  it('reports the plan-based projection when asked', () => {
    const planned = calculateProgressVariance({
      tasks: [framing],
      calendar,
      baseline,
      forecast: { method: 'plan' },
    })
    expect(planned.tasks[0]!.effortRemaining).toBeCloseTo(144, 6)
    expect(planned.tasks[0]!.effortVariance).toBeCloseTo(-24, 6)
  })
})

describe('the threshold', () => {
  it('ignores the performance factor early, where the sample is too small', () => {
    const early = task('early', { percentComplete: 5, actualHours: 60 })
    const result = calculateProgressVariance({ tasks: [early], calendar })
    // A factor of 0.2 would triple the job. Below the threshold, plan-based is used instead.
    expect(result.tasks[0]!.performanceFactor).toBeCloseTo(0.2, 9) // still reported
    expect(result.tasks[0]!.basis).toBe('plan') // but not applied
    expect(result.tasks[0]!.effortRemaining).toBeCloseTo(228, 6)
  })

  it('applies it once past the threshold', () => {
    const along = task('along', { percentComplete: 25, actualHours: 75 })
    const result = calculateProgressVariance({ tasks: [along], calendar })
    expect(result.tasks[0]!.basis).toBe('performance')
  })
})

describe('baselines and change orders', () => {
  it('measures against the baseline, not a revised estimate', () => {
    const baseline = captureBaseline({ tasks: [task('framing')], capturedAt: h(0), calendar }) // 240 committed

    // A change order adds 40 units. Without a baseline the variance would silently rebase.
    const revised = task('framing', {
      effort: 280,
      duration: 70,
      percentComplete: 50,
      actualHours: 140,
    })

    const withBaseline = calculateProgressVariance({ tasks: [revised], calendar, baseline })
    expect(withBaseline.tasks[0]!.baselineEffort).toBe(240)
    expect(withBaseline.tasks[0]!.earned).toBe(120) // 50% of the committed 240

    const without = calculateProgressVariance({ tasks: [revised], calendar })
    expect(without.tasks[0]!.baselineEffort).toBe(280)
    expect(without.tasks[0]!.earned).toBe(140) // the crew appears to have earned more for nothing
  })

  it('reports schedule variance against the frozen dates', () => {
    const baseline = captureBaseline({ tasks: [task('framing')], capturedAt: h(0), calendar })
    const slipped = task('framing', { start: h(24) })
    const result = calculateProgressVariance({ tasks: [slipped], calendar, baseline })
    expect(result.tasks[0]!.startVarianceHours).toBe(24)
    expect(result.tasks[0]!.finishVarianceHours).toBe(24)
    expect(result.projectFinishVarianceHours).toBe(24)
  })

  it('reports negative variance for work running early', () => {
    const baseline = captureBaseline({ tasks: [task('a', { start: h(48) })], capturedAt: h(0), calendar })
    const early = task('a', { start: h(24) })
    expect(
      calculateProgressVariance({ tasks: [early], calendar, baseline }).tasks[0]!
        .startVarianceHours,
    ).toBe(-24)
  })

  it('handles a task added after the baseline was taken', () => {
    const baseline = captureBaseline({ tasks: [task('original')], capturedAt: h(0), calendar })
    const result = calculateProgressVariance({
      tasks: [task('original'), task('added')],
      calendar,
      baseline,
    })
    const added = result.tasks.find((entry) => entry.taskId === 'added')!
    expect(added.baselineFinish).toBeUndefined()
    expect(added.finishVarianceHours).toBeUndefined()
    expect(added.baselineEffort).toBe(240) // falls back to its own estimate
  })
})

describe('aggregation', () => {
  const tasks = [
    task('framing', { resourceType: 'framer', percentComplete: 50, actualHours: 150 }),
    task('roofing', { resourceType: 'framer', percentComplete: 50, actualHours: 100 }),
    task('wiring', {
      resourceType: 'electrician',
      effort: 80,
      resourceCount: 2,
      duration: 40,
      percentComplete: 50,
      actualHours: 20,
    }),
  ]
  const result = calculateProgressVariance({ tasks, calendar })

  it('totals the whole schedule', () => {
    expect(result.overall.baselineEffort).toBe(560) // 240 + 240 + 80
    expect(result.overall.earned).toBe(280)
    expect(result.overall.actualHours).toBe(270)
    expect(result.overall.taskCount).toBe(3)
  })

  it('aggregates the factor as total earned over total actual', () => {
    // Not the mean of 0.8, 1.2 and 2.0 - that would let the small task weigh as much as the big.
    expect(result.overall.performanceFactor).toBeCloseTo(280 / 270, 9)
  })

  it('groups by resource type, which is the calibration data', () => {
    const framers = result.byResourceType.find((entry) => entry.key === 'framer')!
    const electricians = result.byResourceType.find((entry) => entry.key === 'electrician')!
    expect(framers.taskCount).toBe(2)
    expect(framers.performanceFactor).toBeCloseTo(240 / 250, 9)
    expect(electricians.performanceFactor).toBeCloseTo(40 / 20, 9)
  })

  it('omits the factor where nothing has been booked', () => {
    const fresh = calculateProgressVariance({ tasks: [task('untouched')], calendar })
    expect(fresh.overall.performanceFactor).toBeUndefined()
    expect(fresh.tasks[0]!.basis).toBe('not-started')
  })
})

describe('structure', () => {
  it('excludes parents so their children are not counted twice', () => {
    const tasks = [
      task('phase', { basis: 'duration', duration: 0, effort: 0 }),
      task('child', { parentId: 'phase' }),
    ]
    const result = calculateProgressVariance({ tasks, calendar })
    expect(result.tasks.map((entry) => entry.taskId)).toEqual(['child'])
    expect(result.overall.baselineEffort).toBe(240) // not 240 plus the parent
  })

  it('treats a finished task as having nothing left', () => {
    const done = task('done', { percentComplete: 100, actualHours: 300 })
    const result = calculateProgressVariance({ tasks: [done], calendar })
    expect(result.tasks[0]!.effortRemaining).toBe(0)
    expect(result.tasks[0]!.forecastEffort).toBe(300)
    expect(result.tasks[0]!.effortVariance).toBe(-60) // 240 committed, 300 spent
    expect(result.tasks[0]!.basis).toBe('complete')
  })

  it('handles an empty schedule', () => {
    const result = calculateProgressVariance({ tasks: [], calendar })
    expect(result.tasks).toEqual([])
    expect(result.overall.taskCount).toBe(0)
    expect(result.projectFinish).toBeUndefined()
  })
})

describe('properties', () => {
  const anyProgress = fc.record({
    effort: fc.integer({ min: 1, max: 1_000 }),
    resourceCount: fc.integer({ min: 1, max: 10 }),
    percentComplete: fc.integer({ min: 0, max: 100 }),
    actualHours: fc.integer({ min: 0, max: 1_500 }),
  })

  const build = (spec: {
    effort: number
    resourceCount: number
    percentComplete: number
    actualHours: number
  }): Task =>
    task('t', {
      effort: spec.effort,
      resourceCount: spec.resourceCount,
      duration: spec.effort / spec.resourceCount,
      percentComplete: spec.percentComplete,
      actualHours: spec.actualHours,
    })

  it('forecast is always spent plus remaining', () => {
    fc.assert(
      fc.property(anyProgress, (spec) => {
        const result = calculateProgressVariance({ tasks: [build(spec)], calendar })
        const entry = result.tasks[0]!
        expect(entry.forecastEffort).toBeCloseTo(entry.actualHours + entry.effortRemaining, 6)
      }),
    )
  })

  it('variance is always committed minus forecast', () => {
    fc.assert(
      fc.property(anyProgress, (spec) => {
        const entry = calculateProgressVariance({ tasks: [build(spec)], calendar }).tasks[0]!
        expect(entry.effortVariance).toBeCloseTo(entry.baselineEffort - entry.forecastEffort, 6)
      }),
    )
  })

  it('earned never exceeds what was committed, and remaining is never negative', () => {
    fc.assert(
      fc.property(anyProgress, (spec) => {
        const entry = calculateProgressVariance({ tasks: [build(spec)], calendar }).tasks[0]!
        expect(entry.earned).toBeLessThanOrEqual(entry.baselineEffort + 1e-9)
        expect(entry.earned).toBeGreaterThanOrEqual(0)
        expect(entry.effortRemaining).toBeGreaterThanOrEqual(0)
      }),
    )
  })

  it('a baseline of the unchanged plan produces no schedule variance', () => {
    fc.assert(
      fc.property(anyProgress, (spec) => {
        const built = build(spec)
        const baseline = captureBaseline({ tasks: [built], capturedAt: h(0), calendar })
        const result = calculateProgressVariance({ tasks: [built], calendar, baseline })
        expect(result.tasks[0]!.startVarianceHours).toBe(0)
        expect(result.tasks[0]!.finishVarianceHours).toBe(0)
      }),
    )
  })

  it('aggregate totals equal the sum of their parts', () => {
    fc.assert(
      fc.property(fc.array(anyProgress, { minLength: 1, maxLength: 8 }), (specs) => {
        const tasks = specs.map((spec, index) => ({ ...build(spec), id: `t${index}` }))
        const result = calculateProgressVariance({ tasks, calendar })
        const summed = result.tasks.reduce((total, entry) => total + entry.earned, 0)
        expect(result.overall.earned).toBeCloseTo(summed, 6)
        expect(result.overall.taskCount).toBe(tasks.length)
      }),
    )
  })
})
