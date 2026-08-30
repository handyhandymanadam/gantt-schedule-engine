import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ContinuousCalendar } from '../src/calendar.js'
import { CyclicScheduleError, calculateCriticalPath } from '../src/critical-path.js'
import type { Link, Task } from '../src/types.js'

/**
 * These run on the continuous calendar, where every hour is a working hour, so durations read
 * directly as elapsed hours and the expected values below can be worked out by hand. A real
 * working-week calendar must reproduce exactly these results when given a 24/7 week, which is
 * the regression guarantee that catches off-by-one-working-day errors later.
 */
const calendar = new ContinuousCalendar(24)

const BASE = new Date('2026-01-01T00:00:00Z')

/** Hours after the project epoch, as a Date. */
const h = (hours: number): Date => new Date(BASE.getTime() + hours * 3_600_000)

/** Hours between the project epoch and a date. */
const hoursFrom = (date: Date): number => (date.getTime() - BASE.getTime()) / 3_600_000

const task = (id: string, duration: number, mode: 'auto' | 'manual' = 'auto'): Task => ({
  id,
  basis: 'duration',
  resourceCount: 1,
  duration,
  start: BASE,
  schedulingMode: mode,
})

const link = (source: string, target: string, lag = 0): Link => ({
  id: `${source}->${target}`,
  source,
  target,
  type: 'FS',
  lag,
})

/** Reduces a result to { id: [earlyStart, earlyFinish, lateStart, lateFinish, slack] } in hours. */
const table = (result: ReturnType<typeof calculateCriticalPath>) =>
  Object.fromEntries(
    result.tasks.map((entry) => [
      entry.taskId,
      [
        hoursFrom(entry.earlyStart),
        hoursFrom(entry.earlyFinish),
        hoursFrom(entry.lateStart),
        hoursFrom(entry.lateFinish),
        entry.totalSlack,
      ],
    ]),
  )

describe('calculateCriticalPath: worked example', () => {
  /**
   * A standard two-chain network converging on a shared successor:
   *
   *   A(3) --> C(2) --\
   *                    E(4) --> F(2)
   *   B(4) --> D(5) --/
   *
   * Worked by hand:
   *   forward   A 0-3   B 0-4   C 3-5   D 4-9   E 9-13   F 13-15
   *   backward  A 4-7   B 0-4   C 7-9   D 4-9   E 9-13   F 13-15
   *   slack     A 4     B 0     C 4     D 0     E 0      F 0
   *
   * Critical path is B -> D -> E -> F, totalling 4 + 5 + 4 + 2 = 15 hours.
   */
  const tasks = [
    task('A', 3, 'manual'),
    task('B', 4, 'manual'),
    task('C', 2),
    task('D', 5),
    task('E', 4),
    task('F', 2),
  ]
  const links = [
    link('A', 'C'),
    link('B', 'D'),
    link('C', 'E'),
    link('D', 'E'),
    link('E', 'F'),
  ]

  const result = calculateCriticalPath({ tasks, links, calendar })

  it('computes the forward and backward passes exactly', () => {
    expect(table(result)).toEqual({
      A: [0, 3, 4, 7, 4],
      B: [0, 4, 0, 4, 0],
      C: [3, 5, 7, 9, 4],
      D: [4, 9, 4, 9, 0],
      E: [9, 13, 9, 13, 0],
      F: [13, 15, 13, 15, 0],
    })
  })

  it('identifies the critical path', () => {
    expect(result.criticalPath).toEqual(['B', 'D', 'E', 'F'])
  })

  it('reports project bounds and duration', () => {
    expect(result.projectStart).toEqual(h(0))
    expect(result.projectFinish).toEqual(h(15))
    expect(result.projectDuration).toBe(15)
  })

  it('distinguishes free slack from total slack', () => {
    const bySlack = Object.fromEntries(
      result.tasks.map((entry) => [entry.taskId, [entry.totalSlack, entry.freeSlack]]),
    )
    // A has four hours of total slack but none of it is free: spending any of it pushes C,
    // even though C itself has slack. C holds the free slack on that branch.
    expect(bySlack['A']).toEqual([4, 0])
    expect(bySlack['C']).toEqual([4, 4])
    expect(bySlack['D']).toEqual([0, 0])
  })

  it('reports no constraint violations', () => {
    expect(result.violations).toEqual([])
  })

  it('returns tasks in dependency order', () => {
    const position = result.tasks.map((entry) => entry.taskId)
    for (const edge of links) {
      expect(position.indexOf(edge.source)).toBeLessThan(position.indexOf(edge.target))
    }
  })
})

describe('calculateCriticalPath: lag and lead', () => {
  it('delays a successor by positive lag', () => {
    const result = calculateCriticalPath({
      tasks: [task('A', 2, 'manual'), task('B', 4)],
      links: [link('A', 'B', 3)],
      calendar,
    })
    expect(table(result)).toEqual({
      A: [0, 2, 0, 2, 0],
      B: [5, 9, 5, 9, 0],
    })
    expect(result.projectDuration).toBe(9)
    expect(result.criticalPath).toEqual(['A', 'B'])
  })

  it('overlaps tasks on negative lag (lead time)', () => {
    const result = calculateCriticalPath({
      tasks: [task('A', 4, 'manual'), task('B', 3)],
      links: [link('A', 'B', -1)],
      calendar,
    })
    expect(table(result)).toEqual({
      A: [0, 4, 0, 4, 0],
      B: [3, 6, 3, 6, 0],
    })
    expect(result.projectDuration).toBe(6)
  })
})

describe('calculateCriticalPath: milestones', () => {
  it('treats a zero-duration task as an instant on the chain', () => {
    const result = calculateCriticalPath({
      tasks: [task('A', 3, 'manual'), task('M', 0), task('B', 2)],
      links: [link('A', 'M'), link('M', 'B')],
      calendar,
    })
    expect(table(result)).toEqual({
      A: [0, 3, 0, 3, 0],
      M: [3, 3, 3, 3, 0],
      B: [3, 5, 3, 5, 0],
    })
  })

  it('gives a milestone slack when its branch is not critical', () => {
    const result = calculateCriticalPath({
      tasks: [task('long', 10, 'manual'), task('short', 2, 'manual'), task('M', 0), task('end', 1)],
      links: [link('short', 'M'), link('M', 'end'), link('long', 'end')],
      calendar,
    })
    const milestone = result.tasks.find((entry) => entry.taskId === 'M')!
    expect(milestone.earlyStart).toEqual(milestone.earlyFinish)
    expect(milestone.totalSlack).toBe(8)
    expect(milestone.isCritical).toBe(false)
  })
})

describe('calculateCriticalPath: structure', () => {
  it('handles a single task', () => {
    const result = calculateCriticalPath({ tasks: [task('solo', 6, 'manual')], calendar })
    expect(table(result)).toEqual({ solo: [0, 6, 0, 6, 0] })
    expect(result.criticalPath).toEqual(['solo'])
    expect(result.projectDuration).toBe(6)
  })

  it('handles independent parallel chains, taking the longest as the project duration', () => {
    const result = calculateCriticalPath({
      tasks: [task('x1', 5, 'manual'), task('x2', 3), task('y1', 2, 'manual')],
      links: [link('x1', 'x2')],
      calendar,
    })
    expect(result.projectDuration).toBe(8)
    expect(result.criticalPath).toEqual(['x1', 'x2'])
    // The short standalone chain has six hours of float against the long one.
    expect(result.tasks.find((entry) => entry.taskId === 'y1')!.totalSlack).toBe(6)
  })

  it('handles a diamond where both middles are critical when equal', () => {
    const result = calculateCriticalPath({
      tasks: [task('start', 1, 'manual'), task('up', 4), task('down', 4), task('end', 1)],
      links: [link('start', 'up'), link('start', 'down'), link('up', 'end'), link('down', 'end')],
      calendar,
    })
    expect(result.criticalPath.sort()).toEqual(['down', 'end', 'start', 'up'])
    expect(result.projectDuration).toBe(6)
  })

  it('returns an empty result for no tasks', () => {
    const result = calculateCriticalPath({ tasks: [], calendar })
    expect(result.tasks).toEqual([])
    expect(result.criticalPath).toEqual([])
    expect(result.projectDuration).toBe(0)
  })

  it('ignores links whose endpoints are not in the task set', () => {
    const result = calculateCriticalPath({
      tasks: [task('A', 2, 'manual')],
      links: [link('A', 'ghost')],
      calendar,
    })
    expect(result.projectDuration).toBe(2)
  })
})

describe('calculateCriticalPath: cycles', () => {
  it('throws rather than returning a wrong schedule', () => {
    expect(() =>
      calculateCriticalPath({
        tasks: [task('A', 1, 'manual'), task('B', 1)],
        links: [link('A', 'B'), link('B', 'A')],
        calendar,
      }),
    ).toThrow(CyclicScheduleError)
  })

  it('names the cycle in the error', () => {
    try {
      calculateCriticalPath({
        tasks: [task('A', 1, 'manual'), task('B', 1), task('C', 1)],
        links: [link('A', 'B'), link('B', 'C'), link('C', 'A')],
        calendar,
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CyclicScheduleError)
      expect((error as CyclicScheduleError).cycles[0]).toBeDefined()
      expect((error as CyclicScheduleError).message).toContain('cycle')
    }
  })
})

describe('calculateCriticalPath: manual pins', () => {
  it('holds a manual task at its own start date', () => {
    const pinned = { ...task('B', 2, 'manual'), start: h(10) }
    const result = calculateCriticalPath({
      tasks: [task('A', 3, 'manual'), pinned],
      links: [link('A', 'B')],
      calendar,
    })
    const b = result.tasks.find((entry) => entry.taskId === 'B')!
    expect(hoursFrom(b.earlyStart)).toBe(10)
    expect(result.violations).toEqual([])
  })

  it('reports a pin that precedes what its dependencies allow', () => {
    const pinnedTooEarly = { ...task('B', 2, 'manual'), start: h(1) }
    const result = calculateCriticalPath({
      tasks: [task('A', 5, 'manual'), pinnedTooEarly],
      links: [link('A', 'B')],
      calendar,
    })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({ taskId: 'B', shortfallHours: 4 })
    expect(hoursFrom(result.violations[0]!.requiredStart)).toBe(5)
    expect(hoursFrom(result.violations[0]!.pinnedStart)).toBe(1)
  })

  it('does not let an auto task be pinned', () => {
    const auto = { ...task('B', 2), start: h(10) }
    const result = calculateCriticalPath({
      tasks: [task('A', 3, 'manual'), auto],
      links: [link('A', 'B')],
      calendar,
    })
    // Its own start is ignored; dependencies decide.
    expect(hoursFrom(result.tasks.find((entry) => entry.taskId === 'B')!.earlyStart)).toBe(3)
  })
})

describe('calculateCriticalPath: floating point', () => {
  it('treats near-zero slack as critical rather than missing it by rounding dust', () => {
    // 240 work units across 7 resources does not divide evenly.
    const awkward = 240 / 7
    const result = calculateCriticalPath({
      tasks: [task('A', awkward, 'manual'), task('B', awkward)],
      links: [link('A', 'B')],
      calendar,
    })
    expect(result.criticalPath).toEqual(['A', 'B'])
    expect(result.tasks.every((entry) => entry.totalSlack === 0)).toBe(true)
  })
})

describe('calculateCriticalPath: properties', () => {
  /** Random DAG: edges only run from a lower index to a higher one, so it cannot cycle. */
  const anySchedule = fc
    .integer({ min: 1, max: 18 })
    .chain((count) =>
      fc.record({
        durations: fc.array(fc.integer({ min: 0, max: 40 }), {
          minLength: count,
          maxLength: count,
        }),
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
    .map(({ durations, edges }) => {
      // Only genuine anchors are manual. A manual task with predecessors is *pinned*, so it
      // deliberately ignores them and reports a violation instead - correct behaviour, but a
      // different case from the auto-scheduled one these properties describe.
      const hasPredecessor = new Set(edges.map((edge) => edge.to))
      return {
        tasks: durations.map((duration, index) =>
          task(`t${index}`, duration, hasPredecessor.has(index) ? 'auto' : 'manual'),
        ),
        links: edges.map((edge) => link(`t${edge.from}`, `t${edge.to}`)),
      }
    })

  it('never produces negative slack when nothing is pinned into the past', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const result = calculateCriticalPath({ tasks, links, calendar })
        for (const entry of result.tasks) {
          expect(entry.totalSlack).toBeGreaterThanOrEqual(0)
        }
      }),
    )
  })

  it('always has at least one critical task', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const result = calculateCriticalPath({ tasks, links, calendar })
        expect(result.criticalPath.length).toBeGreaterThan(0)
      }),
    )
  })

  it('never starts a task before a predecessor finishes', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const result = calculateCriticalPath({ tasks, links, calendar })
        const byId = new Map(result.tasks.map((entry) => [entry.taskId, entry]))
        for (const edge of links) {
          const predecessor = byId.get(edge.source)!
          const successor = byId.get(edge.target)!
          expect(successor.earlyStart.getTime()).toBeGreaterThanOrEqual(
            predecessor.earlyFinish.getTime(),
          )
        }
      }),
    )
  })

  it('keeps free slack within total slack', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const result = calculateCriticalPath({ tasks, links, calendar })
        for (const entry of result.tasks) {
          expect(entry.freeSlack).toBeLessThanOrEqual(entry.totalSlack)
          expect(entry.freeSlack).toBeGreaterThanOrEqual(0)
        }
      }),
    )
  })

  it('finishes the project exactly when the last task finishes', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const result = calculateCriticalPath({ tasks, links, calendar })
        const lastFinish = Math.max(...result.tasks.map((entry) => entry.earlyFinish.getTime()))
        expect(result.projectFinish.getTime()).toBe(lastFinish)
      }),
    )
  })

  it('marks a task critical exactly when its slack is zero', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const result = calculateCriticalPath({ tasks, links, calendar })
        for (const entry of result.tasks) {
          expect(entry.isCritical).toBe(entry.totalSlack === 0)
        }
      }),
    )
  })

  it('is deterministic across repeated runs', () => {
    fc.assert(
      fc.property(anySchedule, ({ tasks, links }) => {
        const first = calculateCriticalPath({ tasks, links, calendar })
        const second = calculateCriticalPath({ tasks, links, calendar })
        expect(table(second)).toEqual(table(first))
      }),
    )
  })
})
