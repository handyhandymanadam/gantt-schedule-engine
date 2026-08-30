import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ContinuousCalendar } from '../src/calendar.js'
import { WorkingWeekCalendar } from '../src/working-week.js'
import { autoSchedule } from '../src/auto-schedule.js'
import { CyclicScheduleError } from '../src/critical-path.js'
import { withResourceCount } from '../src/effort.js'
import type { Link, Task } from '../src/types.js'

const calendar = new ContinuousCalendar(24)
const BASE = new Date('2026-01-01T00:00:00Z')
const h = (hours: number): Date => new Date(BASE.getTime() + hours * 3_600_000)
const hoursFrom = (date: Date): number => (date.getTime() - BASE.getTime()) / 3_600_000

const task = (id: string, duration: number, overrides: Partial<Task> = {}): Task => ({
  id,
  basis: 'duration',
  resourceCount: 1,
  duration,
  start: BASE,
  schedulingMode: 'auto',
  ...overrides,
})

const link = (source: string, target: string, lag = 0): Link => ({
  id: `${source}->${target}`,
  source,
  target,
  type: 'FS',
  lag,
})

const startsAt = (result: ReturnType<typeof autoSchedule>): Record<string, number> =>
  Object.fromEntries(result.tasks.map((entry) => [entry.id, hoursFrom(entry.start)]))

describe('autoSchedule: cascading', () => {
  it('starts a successor when its predecessor finishes', () => {
    const result = autoSchedule({
      tasks: [task('A', 4, { schedulingMode: 'manual' }), task('B', 3)],
      links: [link('A', 'B')],
      calendar,
    })
    expect(startsAt(result)).toEqual({ A: 0, B: 4 })
    expect(hoursFrom(result.finishes.get('B')!)).toBe(7)
  })

  it('cascades a whole chain when the anchor moves', () => {
    const moved = task('A', 4, { schedulingMode: 'manual', start: h(10) })
    const result = autoSchedule({
      tasks: [moved, task('B', 3), task('C', 2)],
      links: [link('A', 'B'), link('B', 'C')],
      calendar,
    })
    expect(startsAt(result)).toEqual({ A: 10, B: 14, C: 17 })
  })

  it('takes the latest predecessor when several converge', () => {
    const result = autoSchedule({
      tasks: [
        task('short', 2, { schedulingMode: 'manual' }),
        task('long', 9, { schedulingMode: 'manual' }),
        task('after', 1),
      ],
      links: [link('short', 'after'), link('long', 'after')],
      calendar,
    })
    expect(startsAt(result)['after']).toBe(9)
  })

  it('honours lag and lead', () => {
    const withLag = autoSchedule({
      tasks: [task('A', 2, { schedulingMode: 'manual' }), task('B', 1)],
      links: [link('A', 'B', 3)],
      calendar,
    })
    expect(startsAt(withLag)['B']).toBe(5)

    const withLead = autoSchedule({
      tasks: [task('A', 4, { schedulingMode: 'manual' }), task('B', 1)],
      links: [link('A', 'B', -1)],
      calendar,
    })
    expect(startsAt(withLead)['B']).toBe(3)
  })

  it('reports only the tasks that actually move', () => {
    // B is already correctly placed; only C is wrong.
    const tasks = [
      task('A', 4, { schedulingMode: 'manual' }),
      task('B', 3, { start: h(4) }),
      task('C', 2, { start: h(99) }),
    ]
    const result = autoSchedule({ tasks, links: [link('A', 'B'), link('B', 'C')], calendar })
    expect(result.changes.map((change) => change.taskId)).toEqual(['C'])
    expect(result.changes[0]).toMatchObject({ reason: 'cascade', startDeltaHours: -92 })
  })

  it('never mutates the input', () => {
    const tasks = [task('A', 4, { schedulingMode: 'manual' }), task('B', 3, { start: h(50) })]
    autoSchedule({ tasks, links: [link('A', 'B')], calendar })
    expect(hoursFrom(tasks[1]!.start)).toBe(50)
  })

  it('throws on a cyclic graph', () => {
    expect(() =>
      autoSchedule({
        tasks: [task('A', 1), task('B', 1)],
        links: [link('A', 'B'), link('B', 'A')],
        calendar,
      }),
    ).toThrow(CyclicScheduleError)
  })

  it('handles an empty schedule', () => {
    const result = autoSchedule({ tasks: [], calendar })
    expect(result.changes).toEqual([])
    expect(result.tasks).toEqual([])
  })
})

describe('autoSchedule: the data date', () => {
  it('never plans unstarted work into the past', () => {
    const result = autoSchedule({
      tasks: [task('future', 5, { start: BASE })],
      calendar,
      statusDate: h(48),
    })
    expect(startsAt(result)['future']).toBe(48)
    expect(result.changes[0]!.reason).toBe('data-date')
  })

  it('leaves work already beyond the data date alone', () => {
    const result = autoSchedule({
      tasks: [task('later', 5, { start: h(100), schedulingMode: 'manual' })],
      calendar,
      statusDate: h(48),
    })
    expect(result.changes).toEqual([])
  })

  it('does not move completed work, even from before the data date', () => {
    const done = task('done', 8, {
      start: h(0),
      actualStart: h(0),
      actualFinish: h(9),
      percentComplete: 100,
    })
    const result = autoSchedule({
      tasks: [done, task('next', 2)],
      links: [link('done', 'next')],
      calendar,
      statusDate: h(48),
    })
    expect(result.changes.map((change) => change.taskId)).not.toContain('done')
    expect(hoursFrom(result.finishes.get('done')!)).toBe(9)
    // The successor is still floored at the data date rather than following the old finish.
    expect(startsAt(result)['next']).toBe(48)
  })

  it('plans from each task own dates when no data date is given', () => {
    const result = autoSchedule({
      tasks: [task('a', 5, { start: h(3), schedulingMode: 'manual' })],
      calendar,
    })
    expect(startsAt(result)['a']).toBe(3)
  })
})

describe('autoSchedule: in-progress work', () => {
  it('re-projects remaining work forward from the data date', () => {
    // 240 units, 4 resources, 60 hours planned. Half done, so 30 hours remain.
    const framing = task('framing', 60, {
      basis: 'effort',
      effort: 240,
      resourceCount: 4,
      actualStart: h(0),
      percentComplete: 50,
      actualHours: 120, // exactly on estimate, so the performance factor is 1
    })
    const result = autoSchedule({ tasks: [framing], calendar, statusDate: h(30) })
    expect(hoursFrom(result.finishes.get('framing')!)).toBe(60)
    expect(result.tasks[0]!.start.getTime()).toBe(h(0).getTime()) // the start already happened
  })

  it('extends the finish when the crew is running behind', () => {
    // Half done but 150 hours burned against 120 earned: a factor of 0.8.
    // Remaining plan work is 120 units, which at 0.8 projects to 150, or 37.5 hours for 4.
    const framing = task('framing', 60, {
      basis: 'effort',
      effort: 240,
      resourceCount: 4,
      actualStart: h(0),
      percentComplete: 50,
      actualHours: 150,
    })
    const result = autoSchedule({ tasks: [framing], calendar, statusDate: h(30) })
    expect(hoursFrom(result.finishes.get('framing')!)).toBe(67.5)
  })

  it('ignores the performance factor below the threshold', () => {
    // Only 5% done: the factor is too small a sample to drive dates.
    const early = task('early', 60, {
      basis: 'effort',
      effort: 240,
      resourceCount: 4,
      actualStart: h(0),
      percentComplete: 5,
      actualHours: 60, // a factor of 0.2, which would triple the schedule
    })
    const result = autoSchedule({ tasks: [early], calendar, statusDate: h(10) })
    // Plan-based: 228 units remaining over 4 resources is 57 hours from the data date.
    expect(hoursFrom(result.finishes.get('early')!)).toBe(67)
  })

  it('can be told to use plan-based projection instead', () => {
    const framing = task('framing', 60, {
      basis: 'effort',
      effort: 240,
      resourceCount: 4,
      actualStart: h(0),
      percentComplete: 50,
      actualHours: 150,
    })
    const result = autoSchedule({
      tasks: [framing],
      calendar,
      statusDate: h(30),
      forecast: { method: 'plan' },
    })
    expect(hoursFrom(result.finishes.get('framing')!)).toBe(60)
  })

  it('cascades a slipping in-progress task into its successors', () => {
    const framing = task('framing', 60, {
      basis: 'effort',
      effort: 240,
      resourceCount: 4,
      actualStart: h(0),
      percentComplete: 50,
      actualHours: 150,
    })
    const result = autoSchedule({
      tasks: [framing, task('drywall', 16)],
      links: [link('framing', 'drywall')],
      calendar,
      statusDate: h(30),
    })
    expect(startsAt(result)['drywall']).toBe(67.5)
    expect(result.changes.map((change) => change.taskId)).toContain('drywall')
  })

  it('shows the downstream effect of losing a crew member', () => {
    // The scenario the API shape exists for: propose, show the ripple, then decide.
    const framing = task('framing', 60, {
      basis: 'effort',
      effort: 240,
      resourceCount: 4,
      schedulingMode: 'manual',
    })
    // Already laid out consistently: framing 0-60, drywall 60-76, paint 76-84.
    const drywall = task('drywall', 16, { start: h(60) })
    const paint = task('paint', 8, { start: h(76) })

    const before = autoSchedule({
      tasks: [framing, drywall, paint],
      links: [link('framing', 'drywall'), link('drywall', 'paint')],
      calendar,
    })
    expect(before.changes).toEqual([])

    const shortHanded = withResourceCount(framing, 3, calendar) // 80 hours instead of 60
    const after = autoSchedule({
      tasks: [shortHanded, drywall, paint],
      links: [link('framing', 'drywall'), link('drywall', 'paint')],
      calendar,
    })
    expect(after.changes.map((change) => change.taskId)).toEqual(['drywall', 'paint'])
    expect(after.changes.every((change) => change.startDeltaHours === 20)).toBe(true)
  })
})

describe('autoSchedule: pins and conflicts', () => {
  it('holds a manual task and reports the contradiction', () => {
    const result = autoSchedule({
      tasks: [
        task('A', 5, { schedulingMode: 'manual' }),
        task('B', 2, { schedulingMode: 'manual', start: h(1) }),
      ],
      links: [link('A', 'B')],
      calendar,
    })
    expect(startsAt(result)['B']).toBe(1) // pinned, not moved
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({
      taskId: 'B',
      shortfallHours: 4,
      cause: 'manual-pin',
    })
  })

  it('reports an in-progress task that started before its predecessor allows', () => {
    const result = autoSchedule({
      tasks: [
        task('A', 10, { schedulingMode: 'manual' }),
        task('B', 4, { actualStart: h(2), percentComplete: 25, actualHours: 1 }),
      ],
      links: [link('A', 'B')],
      calendar,
      statusDate: h(3),
    })
    expect(result.conflicts[0]).toMatchObject({ taskId: 'B', cause: 'in-progress' })
  })
})

describe('autoSchedule: calendars', () => {
  const week = new WorkingWeekCalendar()
  const mondayEight = new Date('2026-01-05T08:00:00Z')
  const isoOf = (date: Date): string => date.toISOString().slice(0, 16).replace('T', ' ')

  it('cascades across a weekend', () => {
    const result = autoSchedule({
      tasks: [
        { ...task('A', 24), start: mondayEight, schedulingMode: 'manual' },
        task('B', 8, { start: mondayEight }),
      ],
      links: [link('A', 'B')],
      calendar: week,
      // A runs Mon-Wed; B should take the whole of Thursday.
    })
    expect(isoOf(result.finishes.get('A')!)).toBe('2026-01-07 16:00')
    expect(isoOf(result.tasks[1]!.start)).toBe('2026-01-08 08:00')
    expect(isoOf(result.finishes.get('B')!)).toBe('2026-01-08 16:00')
  })

  it('pushes a successor over the weekend when the predecessor ends on Friday', () => {
    const thursday = new Date('2026-01-08T08:00:00Z')
    const result = autoSchedule({
      tasks: [
        { ...task('A', 16), start: thursday, schedulingMode: 'manual' },
        task('B', 8, { start: thursday }),
      ],
      links: [link('A', 'B')],
      calendar: week,
    })
    expect(isoOf(result.finishes.get('A')!)).toBe('2026-01-09 16:00') // Friday
    expect(isoOf(result.tasks[1]!.start)).toBe('2026-01-12 08:00') // Monday
  })

  it('places a milestone at the predecessor finish, not the next morning', () => {
    const result = autoSchedule({
      tasks: [
        { ...task('A', 8), start: mondayEight, schedulingMode: 'manual' },
        task('M', 0, { start: mondayEight }),
      ],
      links: [link('A', 'M')],
      calendar: week,
    })
    // The finish instant normalises backward, so the milestone reads Monday 16:00 rather than
    // appearing to drift into Tuesday.
    expect(isoOf(result.finishes.get('M')!)).toBe('2026-01-05 16:00')
  })
})

describe('autoSchedule: properties', () => {
  const anySchedule = fc
    .integer({ min: 1, max: 14 })
    .chain((count) =>
      fc.record({
        durations: fc.array(fc.integer({ min: 0, max: 30 }), {
          minLength: count,
          maxLength: count,
        }),
        offsets: fc.array(fc.integer({ min: 0, max: 60 }), { minLength: count, maxLength: count }),
        edges: fc.subarray(
          Array.from({ length: count }, (_, from) =>
            Array.from({ length: count - from - 1 }, (_, offset) => ({
              from,
              to: from + offset + 1,
            })),
          ).flat(),
        ),
      }),
    )
    .map(({ durations, offsets, edges }) => {
      const hasPredecessor = new Set(edges.map((edge) => edge.to))
      return {
        tasks: durations.map((duration, index) =>
          task(`t${index}`, duration, {
            start: h(offsets[index]!),
            schedulingMode: hasPredecessor.has(index) ? 'auto' : 'manual',
          }),
        ),
        links: edges.map((edge) => link(`t${edge.from}`, `t${edge.to}`)),
      }
    })

  it('is idempotent: rescheduling its own output proposes nothing', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const first = autoSchedule({ tasks, links, calendar })
        const second = autoSchedule({ tasks: first.tasks, links, calendar })
        expect(second.changes).toEqual([])
      }),
    )
  })

  it('is idempotent under a working-week calendar too', () => {
    const week = new WorkingWeekCalendar()
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const first = autoSchedule({ tasks, links, calendar: week })
        const second = autoSchedule({ tasks: first.tasks, links, calendar: week })
        expect(second.changes).toEqual([])
      }),
    )
  })

  it('satisfies every dependency once applied', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const result = autoSchedule({ tasks, links, calendar })
        const byId = new Map(result.tasks.map((entry) => [entry.id, entry]))
        for (const edge of links) {
          const predecessorFinish = result.finishes.get(edge.source)!
          const successorStart = byId.get(edge.target)!.start
          expect(successorStart.getTime()).toBeGreaterThanOrEqual(predecessorFinish.getTime())
        }
      }),
    )
  })

  it('never schedules anything before the data date except work already under way', () => {
    fc.assert(
      fc.property(anySchedule, fc.integer({ min: 0, max: 120 }), ({ tasks, links }, offset) => {
        const statusDate = h(offset)
        const result = autoSchedule({ tasks, links, calendar, statusDate })
        for (const entry of result.tasks) {
          if (entry.schedulingMode === 'manual') continue
          expect(entry.start.getTime()).toBeGreaterThanOrEqual(statusDate.getTime())
        }
      }),
    )
  })

  it('reports a change for exactly those tasks whose dates differ', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const result = autoSchedule({ tasks, links, calendar })
        const changed = new Set(result.changes.map((change) => change.taskId))
        const byId = new Map(result.tasks.map((entry) => [entry.id, entry]))
        for (const original of tasks) {
          const moved = byId.get(original.id)!.start.getTime() !== original.start.getTime()
          if (moved) expect(changed.has(original.id)).toBe(true)
        }
      }),
    )
  })

  it('preserves task count, identity and order', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const result = autoSchedule({ tasks, links, calendar })
        expect(result.tasks.map((entry) => entry.id)).toEqual(tasks.map((entry) => entry.id))
      }),
    )
  })
})
