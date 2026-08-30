import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ContinuousCalendar } from '../src/calendar.js'
import { findResourceConflicts } from '../src/resources.js'
import type { Assignment, Resource, Task } from '../src/types.js'

const calendar = new ContinuousCalendar(24)
const BASE = new Date('2026-01-01T00:00:00Z')
const h = (hours: number): Date => new Date(BASE.getTime() + hours * 3_600_000)
const hoursFrom = (date: Date): number => (date.getTime() - BASE.getTime()) / 3_600_000

const task = (id: string, start: number, duration: number, overrides: Partial<Task> = {}): Task => ({
  id,
  basis: 'duration',
  resourceCount: 1,
  duration,
  start: h(start),
  schedulingMode: 'manual',
  ...overrides,
})

const assign = (taskId: string, resourceId: string): Assignment => ({ taskId, resourceId })
const person = (id: string, type?: string): Resource => (type === undefined ? { id } : { id, type })

describe('double-booking', () => {
  it('finds one resource on two overlapping tasks', () => {
    const result = findResourceConflicts({
      tasks: [task('a', 0, 10), task('b', 5, 10)],
      assignments: [assign('a', 'sam'), assign('b', 'sam')],
      calendar,
    })
    expect(result.doubleBookings).toHaveLength(1)
    const conflict = result.doubleBookings[0]!
    expect(conflict.resourceId).toBe('sam')
    expect(conflict.taskIds).toEqual(['a', 'b'])
    expect(hoursFrom(conflict.from)).toBe(5)
    expect(hoursFrom(conflict.to)).toBe(10)
  })

  it('does not flag tasks that merely touch', () => {
    const result = findResourceConflicts({
      tasks: [task('a', 0, 10), task('b', 10, 10)],
      assignments: [assign('a', 'sam'), assign('b', 'sam')],
      calendar,
    })
    expect(result.doubleBookings).toEqual([])
  })

  it('does not flag different people on overlapping tasks', () => {
    const result = findResourceConflicts({
      tasks: [task('a', 0, 10), task('b', 5, 10)],
      assignments: [assign('a', 'sam'), assign('b', 'alex')],
      calendar,
    })
    expect(result.doubleBookings).toEqual([])
  })

  it('reports one window when three tasks overlap together', () => {
    const result = findResourceConflicts({
      tasks: [task('a', 0, 20), task('b', 5, 20), task('c', 6, 20)],
      assignments: [assign('a', 'sam'), assign('b', 'sam'), assign('c', 'sam')],
      calendar,
    })
    // Windows are split where the active set changes, not fragmented arbitrarily.
    expect(result.doubleBookings.length).toBeGreaterThan(0)
    const widest = result.doubleBookings.find((entry) => entry.taskIds.length === 3)!
    expect(widest.taskIds).toEqual(['a', 'b', 'c'])
    expect(hoursFrom(widest.from)).toBe(6)
  })

  it('ignores milestones, which consume nobody', () => {
    const result = findResourceConflicts({
      tasks: [task('a', 0, 10), task('m', 5, 0)],
      assignments: [assign('a', 'sam'), assign('m', 'sam')],
      calendar,
    })
    expect(result.doubleBookings).toEqual([])
  })

  it('carries the resource type when the pool declares one', () => {
    const result = findResourceConflicts({
      tasks: [task('a', 0, 10), task('b', 5, 10)],
      assignments: [assign('a', 'sam'), assign('b', 'sam')],
      resources: [person('sam', 'carpenter')],
      calendar,
    })
    expect(result.doubleBookings[0]!.resourceType).toBe('carpenter')
  })

  it('finds a booking that spans two separate projects', () => {
    // Nothing in the model names a project; passing tasks from both is all it takes.
    const result = findResourceConflicts({
      tasks: [task('siteA-framing', 0, 10), task('siteB-framing', 4, 10)],
      assignments: [assign('siteA-framing', 'sam'), assign('siteB-framing', 'sam')],
      calendar,
    })
    expect(result.doubleBookings).toHaveLength(1)
    expect(result.doubleBookings[0]!.taskIds).toEqual(['siteA-framing', 'siteB-framing'])
  })
})

describe('capacity', () => {
  const framers = [person('f1', 'framer'), person('f2', 'framer'), person('f3', 'framer')]

  it('flags demand beyond the pool', () => {
    const result = findResourceConflicts({
      tasks: [
        task('walls', 0, 10, { resourceType: 'framer', resourceCount: 2 }),
        task('roof', 5, 10, { resourceType: 'framer', resourceCount: 2 }),
      ],
      resources: framers,
      calendar,
    })
    expect(result.capacityShortfalls).toHaveLength(1)
    const shortfall = result.capacityShortfalls[0]!
    expect(shortfall).toMatchObject({ resourceType: 'framer', demand: 4, supply: 3, shortfall: 1 })
    expect(hoursFrom(shortfall.from)).toBe(5)
    expect(hoursFrom(shortfall.to)).toBe(10)
  })

  it('accepts demand that fits', () => {
    const result = findResourceConflicts({
      tasks: [
        task('walls', 0, 10, { resourceType: 'framer', resourceCount: 2 }),
        task('roof', 5, 10, { resourceType: 'framer', resourceCount: 1 }),
      ],
      resources: framers,
      calendar,
    })
    expect(result.capacityShortfalls).toEqual([])
  })

  it('works on tasks nobody has been assigned to yet', () => {
    // The forward-looking question: can this month even be staffed?
    const result = findResourceConflicts({
      tasks: [
        task('future1', 100, 10, { resourceType: 'framer', resourceCount: 3 }),
        task('future2', 100, 10, { resourceType: 'framer', resourceCount: 3 }),
      ],
      assignments: [],
      resources: framers,
      calendar,
    })
    expect(result.capacityShortfalls[0]).toMatchObject({ demand: 6, supply: 3, shortfall: 3 })
  })

  it('keeps trades separate, since work is not fungible across them', () => {
    const result = findResourceConflicts({
      tasks: [
        task('walls', 0, 10, { resourceType: 'framer', resourceCount: 3 }),
        task('wiring', 0, 10, { resourceType: 'electrician', resourceCount: 1 }),
      ],
      resources: [...framers, person('e1', 'electrician')],
      calendar,
    })
    // Four people are busy at once, but each trade is within its own pool.
    expect(result.capacityShortfalls).toEqual([])
  })

  it('does not report a type with no declared pool', () => {
    const result = findResourceConflicts({
      tasks: [task('plumbing', 0, 10, { resourceType: 'plumber', resourceCount: 9 })],
      resources: framers,
      calendar,
    })
    expect(result.capacityShortfalls).toEqual([])
  })

  it('handles fractional resource counts', () => {
    const result = findResourceConflicts({
      tasks: [
        task('a', 0, 10, { resourceType: 'foreman', resourceCount: 0.5 }),
        task('b', 0, 10, { resourceType: 'foreman', resourceCount: 0.75 }),
      ],
      resources: [person('boss', 'foreman')],
      calendar,
    })
    expect(result.capacityShortfalls[0]).toMatchObject({ demand: 1.25, supply: 1 })
  })

  it('flags a single task that alone exceeds the pool', () => {
    const result = findResourceConflicts({
      tasks: [task('big', 0, 10, { resourceType: 'framer', resourceCount: 8 })],
      resources: framers,
      calendar,
    })
    expect(result.capacityShortfalls[0]).toMatchObject({ demand: 8, shortfall: 5 })
  })
})

describe('elasticity', () => {
  it('names the tasks that could absorb the conflict', () => {
    const result = findResourceConflicts({
      tasks: [
        // Work-driven: can run longer with fewer people.
        task('framing', 0, 10, { basis: 'effort', effort: 10, resourceCount: 1 }),
        // Duration-driven: cures for as long as it cures.
        task('curing', 5, 10),
      ],
      assignments: [assign('framing', 'sam'), assign('curing', 'sam')],
      calendar,
    })
    const conflict = result.doubleBookings[0]!
    expect(conflict.taskIds).toEqual(['curing', 'framing'])
    expect(conflict.elasticTaskIds).toEqual(['framing'])
  })

  it('treats a finished task as unable to give', () => {
    const result = findResourceConflicts({
      tasks: [
        task('done', 0, 10, { basis: 'effort', effort: 10, percentComplete: 100 }),
        task('other', 5, 10, { basis: 'effort', effort: 10 }),
      ],
      assignments: [assign('done', 'sam'), assign('other', 'sam')],
      calendar,
    })
    expect(result.doubleBookings[0]!.elasticTaskIds).toEqual(['other'])
  })

  it('reports an empty list when nothing can move', () => {
    const result = findResourceConflicts({
      tasks: [task('a', 0, 10), task('b', 5, 10)],
      assignments: [assign('a', 'sam'), assign('b', 'sam')],
      calendar,
    })
    // No scheduling remedy exists here, only a staffing one.
    expect(result.doubleBookings[0]!.elasticTaskIds).toEqual([])
  })
})

describe('inputs', () => {
  it('uses supplied placement over the tasks own dates', () => {
    const tasks = [task('a', 0, 10), task('b', 50, 10)]
    const placement = new Map([
      ['a', { start: h(0), finish: h(10) }],
      ['b', { start: h(5), finish: h(15) }], // rescheduled on top of a
    ])
    const result = findResourceConflicts({
      tasks,
      assignments: [assign('a', 'sam'), assign('b', 'sam')],
      calendar,
      placement,
    })
    expect(result.doubleBookings).toHaveLength(1)
  })

  it('skips parents, whose children carry the real work', () => {
    const result = findResourceConflicts({
      tasks: [
        task('phase', 0, 10),
        task('child', 0, 10, { parentId: 'phase' }),
        task('other', 0, 10),
      ],
      assignments: [assign('phase', 'sam'), assign('child', 'sam'), assign('other', 'sam')],
      calendar,
    })
    const flagged = new Set(result.doubleBookings.flatMap((entry) => entry.taskIds))
    expect(flagged.has('phase')).toBe(false)
    expect(flagged.has('child')).toBe(true)
  })

  it('ignores assignments naming unknown tasks', () => {
    const result = findResourceConflicts({
      tasks: [task('a', 0, 10)],
      assignments: [assign('a', 'sam'), assign('ghost', 'sam')],
      calendar,
    })
    expect(result.conflicts).toEqual([])
  })

  it('returns nothing for an empty schedule', () => {
    expect(findResourceConflicts({ tasks: [], calendar }).conflicts).toEqual([])
  })

  it('returns both kinds sorted by start', () => {
    const result = findResourceConflicts({
      tasks: [
        task('early1', 0, 10, { resourceType: 'framer', resourceCount: 2 }),
        task('early2', 0, 10, { resourceType: 'framer', resourceCount: 2 }),
        task('lateA', 50, 10),
        task('lateB', 55, 10),
      ],
      assignments: [assign('lateA', 'sam'), assign('lateB', 'sam')],
      resources: [person('f1', 'framer'), person('f2', 'framer')],
      calendar,
    })
    expect(result.conflicts.length).toBeGreaterThanOrEqual(2)
    const starts = result.conflicts.map((entry) => entry.from.getTime())
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })
})

describe('properties', () => {
  const anySchedule = fc.array(
    fc.record({
      start: fc.integer({ min: 0, max: 100 }),
      duration: fc.integer({ min: 1, max: 30 }),
      resourceCount: fc.integer({ min: 1, max: 4 }),
    }),
    { minLength: 1, maxLength: 10 },
  )

  it('every reported window has at least two tasks, or a single task over capacity', () => {
    fc.assert(
      fc.property(anySchedule, (specs) => {
        const tasks = specs.map((spec, index) =>
          task(`t${index}`, spec.start, spec.duration, {
            resourceType: 'framer',
            resourceCount: spec.resourceCount,
          }),
        )
        const result = findResourceConflicts({
          tasks,
          resources: [person('f1', 'framer'), person('f2', 'framer')],
          calendar,
        })
        for (const conflict of result.capacityShortfalls) {
          expect(conflict.taskIds.length).toBeGreaterThan(0)
          expect(conflict.demand).toBeGreaterThan(conflict.supply)
          expect(conflict.shortfall).toBeCloseTo(conflict.demand - conflict.supply, 9)
        }
      }),
    )
  })

  it('never reports a window outside the tasks it names', () => {
    fc.assert(
      fc.property(anySchedule, (specs) => {
        const tasks = specs.map((spec, index) =>
          task(`t${index}`, spec.start, spec.duration, {
            resourceType: 'framer',
            resourceCount: spec.resourceCount,
          }),
        )
        const byId = new Map(tasks.map((entry) => [entry.id, entry]))
        const result = findResourceConflicts({
          tasks,
          resources: [person('f1', 'framer')],
          calendar,
        })
        for (const conflict of result.capacityShortfalls) {
          for (const id of conflict.taskIds) {
            const owner = byId.get(id)!
            const from = owner.start.getTime()
            const to = from + owner.duration * 3_600_000
            expect(conflict.from.getTime()).toBeGreaterThanOrEqual(from)
            expect(conflict.to.getTime()).toBeLessThanOrEqual(to)
          }
        }
      }),
    )
  })

  it('a pool larger than any possible demand produces no shortfall', () => {
    fc.assert(
      fc.property(anySchedule, (specs) => {
        const tasks = specs.map((spec, index) =>
          task(`t${index}`, spec.start, spec.duration, {
            resourceType: 'framer',
            resourceCount: spec.resourceCount,
          }),
        )
        const generous = Array.from({ length: 100 }, (_, index) => person(`f${index}`, 'framer'))
        const result = findResourceConflicts({ tasks, resources: generous, calendar })
        expect(result.capacityShortfalls).toEqual([])
      }),
    )
  })

  it('elastic tasks are always a subset of the tasks named', () => {
    fc.assert(
      fc.property(anySchedule, (specs) => {
        const tasks = specs.map((spec, index) =>
          task(`t${index}`, spec.start, spec.duration, {
            resourceType: 'framer',
            resourceCount: spec.resourceCount,
            ...(index % 2 === 0
              ? { basis: 'effort' as const, effort: spec.duration * spec.resourceCount }
              : {}),
          }),
        )
        const result = findResourceConflicts({
          tasks,
          resources: [person('f1', 'framer')],
          calendar,
        })
        for (const conflict of result.conflicts) {
          for (const id of conflict.elasticTaskIds) {
            expect(conflict.taskIds).toContain(id)
          }
        }
      }),
    )
  })
})
