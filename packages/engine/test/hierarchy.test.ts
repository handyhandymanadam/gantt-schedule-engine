import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ContinuousCalendar } from '../src/calendar.js'
import { expandHierarchy, parentIds, rollUpParents } from '../src/hierarchy.js'
import { calculateCriticalPath } from '../src/critical-path.js'
import { autoSchedule } from '../src/auto-schedule.js'
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

describe('expandHierarchy', () => {
  it('leaves a flat task list untouched', () => {
    const tasks = [task('a', 1), task('b', 2)]
    const links = [link('a', 'b')]
    const expanded = expandHierarchy(tasks, links)
    expect(expanded.tasks).toEqual(tasks)
    expect(expanded.links).toEqual(links)
    expect(expanded.synthetic.size).toBe(0)
  })

  it('removes parents from the schedulable set', () => {
    const tasks = [task('phase', 0), task('a', 4, { parentId: 'phase' })]
    const expanded = expandHierarchy(tasks, [])
    expect(expanded.tasks.map((entry) => entry.id)).toEqual(['a'])
  })

  it('creates boundary nodes only for parents that appear in a link', () => {
    const tasks = [
      task('unlinked', 0),
      task('x', 2, { parentId: 'unlinked' }),
      task('linked', 0),
      task('y', 2, { parentId: 'linked' }),
      task('after', 1),
    ]
    const expanded = expandHierarchy(tasks, [link('linked', 'after')])
    expect([...expanded.synthetic].sort()).toEqual(['linked#finish', 'linked#start'])
  })

  it('rewrites a phase-to-phase link onto boundary nodes', () => {
    const tasks = [
      task('foundation', 0),
      task('pour', 8, { parentId: 'foundation' }),
      task('framing', 0),
      task('walls', 8, { parentId: 'framing' }),
    ]
    const expanded = expandHierarchy(tasks, [link('foundation', 'framing')])
    const rewritten = expanded.links.find((entry) => entry.id === 'foundation->framing')
    expect(rewritten).toMatchObject({ source: 'foundation#finish', target: 'framing#start' })
  })

  it('wires every leaf into its phase boundaries', () => {
    const tasks = [
      task('phase', 0),
      task('a', 4, { parentId: 'phase' }),
      task('b', 4, { parentId: 'phase' }),
      task('after', 1),
    ]
    const expanded = expandHierarchy(tasks, [link('phase', 'after')])
    const ids = expanded.links.map((entry) => `${entry.source}=>${entry.target}`)
    expect(ids).toContain('phase#start=>a')
    expect(ids).toContain('phase#start=>b')
    expect(ids).toContain('a=>phase#finish')
    expect(ids).toContain('b=>phase#finish')
  })

  it('reaches leaves nested several levels down', () => {
    const tasks = [
      task('top', 0),
      task('middle', 0, { parentId: 'top' }),
      task('leaf', 4, { parentId: 'middle' }),
      task('after', 1),
    ]
    const expanded = expandHierarchy(tasks, [link('top', 'after')])
    const ids = expanded.links.map((entry) => `${entry.source}=>${entry.target}`)
    expect(ids).toContain('top#start=>leaf')
    expect(ids).toContain('leaf=>top#finish')
  })

  it('gives an empty phase a single instant of extent', () => {
    const tasks = [task('empty', 0), task('child', 0, { parentId: 'empty' }), task('after', 1)]
    // 'child' is itself a parent of nothing, so it is a leaf; make a genuinely empty phase.
    const onlyParent = [task('empty', 0), task('ghost', 1, { parentId: 'nothing' }), task('after', 1)]
    expect(() => expandHierarchy(tasks, [link('empty', 'after')])).not.toThrow()
    expect(() => expandHierarchy(onlyParent, [link('nothing', 'after')])).not.toThrow()
  })

  it('refuses to shadow an existing task id', () => {
    const tasks = [
      task('phase', 0),
      task('phase#start', 1), // collides with the boundary node id
      task('a', 4, { parentId: 'phase' }),
      task('after', 1),
    ]
    expect(() => expandHierarchy(tasks, [link('phase', 'after')])).toThrow(/already in use/)
  })

  it('orders parents so children settle first', () => {
    const tasks = [
      task('top', 0),
      task('middle', 0, { parentId: 'top' }),
      task('leaf', 4, { parentId: 'middle' }),
    ]
    const expanded = expandHierarchy(tasks, [])
    expect(expanded.parentsBottomUp).toEqual(['middle', 'top'])
  })

  it('identifies parents', () => {
    const tasks = [task('p', 0), task('c', 1, { parentId: 'p' })]
    expect([...parentIds(tasks)]).toEqual(['p'])
  })
})

describe('rollUpParents', () => {
  it('spans its children rather than summing their durations', () => {
    const tasks = [
      task('phase', 0),
      task('a', 4, { parentId: 'phase' }),
      task('b', 4, { parentId: 'phase' }),
    ]
    // The two children run in parallel: 0-4 each. The span is 4, not 8.
    const placement = new Map([
      ['a', { start: h(0), finish: h(4) }],
      ['b', { start: h(0), finish: h(4) }],
    ])
    const rolled = rollUpParents(tasks, placement, calendar).get('phase')!
    expect(rolled.duration).toBe(4)
    expect(hoursFrom(rolled.start)).toBe(0)
    expect(hoursFrom(rolled.finish)).toBe(4)
  })

  it('sums work, which unlike duration does add up a hierarchy', () => {
    const tasks = [
      task('phase', 0),
      task('a', 4, { parentId: 'phase', resourceCount: 2 }), // 8 units
      task('b', 4, { parentId: 'phase', resourceCount: 3 }), // 12 units
    ]
    const placement = new Map([
      ['a', { start: h(0), finish: h(4) }],
      ['b', { start: h(0), finish: h(4) }],
    ])
    expect(rollUpParents(tasks, placement, calendar).get('phase')!.effort).toBe(20)
  })

  it('weights progress by work, not by task count', () => {
    const tasks = [
      task('phase', 0),
      task('big', 200, { parentId: 'phase', percentComplete: 0 }),
      task('snag', 4, { parentId: 'phase', percentComplete: 100 }),
    ]
    const placement = new Map([
      ['big', { start: h(0), finish: h(200) }],
      ['snag', { start: h(0), finish: h(4) }],
    ])
    const rolled = rollUpParents(tasks, placement, calendar).get('phase')!
    // A straight average would claim 50%. Work-weighted, it is 4/204.
    expect(rolled.percentComplete).toBeCloseTo((4 / 204) * 100, 6)
  })

  it('accumulates actual hours', () => {
    const tasks = [
      task('phase', 0),
      task('a', 4, { parentId: 'phase', actualHours: 6 }),
      task('b', 4, { parentId: 'phase', actualHours: 5 }),
    ]
    const placement = new Map([
      ['a', { start: h(0), finish: h(4) }],
      ['b', { start: h(0), finish: h(4) }],
    ])
    expect(rollUpParents(tasks, placement, calendar).get('phase')!.actualHours).toBe(11)
  })

  it('rolls nested parents bottom-up', () => {
    const tasks = [
      task('top', 0),
      task('middle', 0, { parentId: 'top' }),
      task('leaf1', 4, { parentId: 'middle' }),
      task('leaf2', 4, { parentId: 'middle' }),
      task('direct', 4, { parentId: 'top' }),
    ]
    const placement = new Map([
      ['leaf1', { start: h(0), finish: h(4) }],
      ['leaf2', { start: h(4), finish: h(8) }],
      ['direct', { start: h(8), finish: h(12) }],
    ])
    const rollups = rollUpParents(tasks, placement, calendar)
    expect(rollups.get('middle')!.duration).toBe(8)
    expect(rollups.get('top')!.duration).toBe(12)
    expect(rollups.get('top')!.effort).toBe(12) // 4 + 4 + 4
    expect(rollups.get('top')!.leafCount).toBe(3)
  })
})

describe('critical path with hierarchy', () => {
  it('schedules a phase-to-phase link through boundary nodes', () => {
    const tasks = [
      task('foundation', 0),
      task('excavate', 8, { parentId: 'foundation', schedulingMode: 'manual' }),
      task('pour', 4, { parentId: 'foundation', schedulingMode: 'manual' }),
      task('framing', 0),
      task('walls', 6, { parentId: 'framing' }),
    ]
    const result = calculateCriticalPath({
      tasks,
      links: [link('foundation', 'framing')],
      calendar,
    })

    // Both foundation leaves are pinned at 0; the phase finishes when the longer one does.
    const foundation = result.parents.find((entry) => entry.taskId === 'foundation')!
    expect(hoursFrom(foundation.finish)).toBe(8)

    // Walls waits for the whole phase, not just one task in it.
    const walls = result.tasks.find((entry) => entry.taskId === 'walls')!
    expect(hoursFrom(walls.earlyStart)).toBe(8)
  })

  it('keeps parents and boundary nodes out of the scheduled tasks and critical path', () => {
    const tasks = [
      task('phase', 0),
      task('a', 4, { parentId: 'phase', schedulingMode: 'manual' }),
      task('after', 2),
    ]
    const result = calculateCriticalPath({ tasks, links: [link('phase', 'after')], calendar })
    const ids = result.tasks.map((entry) => entry.taskId)
    expect(ids).toEqual(expect.arrayContaining(['a', 'after']))
    expect(ids).not.toContain('phase')
    expect(ids.some((id) => id.includes('#'))).toBe(false)
    expect(result.criticalPath.some((id) => id.includes('#'))).toBe(false)
  })

  it('a start boundary is a lower bound, not a forced equality', () => {
    // 'late' has its own predecessor finishing after the phase opens, so it must not be pulled
    // back to the phase boundary.
    const tasks = [
      task('gate', 20, { schedulingMode: 'manual' }),
      task('phase', 0),
      task('early', 2, { parentId: 'phase', schedulingMode: 'manual' }),
      task('late', 2, { parentId: 'phase' }),
      task('after', 1),
    ]
    const result = calculateCriticalPath({
      tasks,
      links: [link('gate', 'late'), link('phase', 'after')],
      calendar,
    })
    const late = result.tasks.find((entry) => entry.taskId === 'late')!
    expect(hoursFrom(late.earlyStart)).toBe(20)
    // The phase therefore extends to cover it.
    const phase = result.parents.find((entry) => entry.taskId === 'phase')!
    expect(hoursFrom(phase.finish)).toBe(22)
  })
})

describe('autoSchedule with hierarchy', () => {
  it('cascades a phase-to-phase dependency', () => {
    const tasks = [
      task('foundation', 0),
      task('pour', 10, { parentId: 'foundation', schedulingMode: 'manual' }),
      task('framing', 0),
      task('walls', 6, { parentId: 'framing' }),
    ]
    const result = autoSchedule({ tasks, links: [link('foundation', 'framing')], calendar })
    const walls = result.tasks.find((entry) => entry.id === 'walls')!
    expect(hoursFrom(walls.start)).toBe(10)
  })

  it('reports the derived parent extents', () => {
    const tasks = [
      task('phase', 0),
      task('a', 5, { parentId: 'phase', schedulingMode: 'manual' }),
      task('b', 3, { parentId: 'phase' }),
    ]
    const result = autoSchedule({ tasks, links: [link('a', 'b')], calendar })
    const phase = result.parents.find((entry) => entry.taskId === 'phase')!
    expect(hoursFrom(phase.start)).toBe(0)
    expect(hoursFrom(phase.finish)).toBe(8)
    expect(phase.duration).toBe(8)
  })

  it('does not let the data date drag a whole phase forward', () => {
    // The boundary node must not be floored at the data date, or every leaf inside would be
    // pushed even when it is already correctly placed beyond it.
    const tasks = [
      task('phase', 0, { start: h(100) }),
      task('a', 4, { parentId: 'phase', start: h(100), schedulingMode: 'manual' }),
      task('after', 1, { start: h(104) }),
    ]
    const result = autoSchedule({
      tasks,
      links: [link('phase', 'after')],
      calendar,
      statusDate: h(50),
    })
    expect(hoursFrom(result.tasks.find((entry) => entry.id === 'a')!.start)).toBe(100)
    expect(hoursFrom(result.tasks.find((entry) => entry.id === 'after')!.start)).toBe(104)
    expect(result.changes).toEqual([])
  })

  it('is idempotent with hierarchy present', () => {
    const tasks = [
      task('foundation', 0),
      task('pour', 10, { parentId: 'foundation', schedulingMode: 'manual' }),
      task('cure', 6, { parentId: 'foundation' }),
      task('framing', 0),
      task('walls', 6, { parentId: 'framing' }),
      task('roof', 4, { parentId: 'framing' }),
    ]
    const links = [link('pour', 'cure'), link('foundation', 'framing'), link('walls', 'roof')]
    const first = autoSchedule({ tasks, links, calendar })
    const second = autoSchedule({ tasks: first.tasks, links, calendar })
    expect(second.changes).toEqual([])
  })
})

describe('hierarchy properties', () => {
  const anyHierarchy = fc
    .integer({ min: 2, max: 10 })
    .chain((leafCount) =>
      fc.record({
        durations: fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: leafCount,
          maxLength: leafCount,
        }),
        grouping: fc.array(fc.integer({ min: 0, max: 2 }), {
          minLength: leafCount,
          maxLength: leafCount,
        }),
      }),
    )
    .map(({ durations, grouping }) => {
      const phases = [...new Set(grouping)].map((index) => task(`phase${index}`, 0))
      const leaves = durations.map((duration, index) =>
        task(`leaf${index}`, duration, {
          parentId: `phase${grouping[index]!}`,
          schedulingMode: 'manual',
          start: h(index * 3),
        }),
      )
      return { tasks: [...phases, ...leaves] }
    })

  it('a parent always contains every one of its children', () => {
    fc.assert(
      fc.property(anyHierarchy, ({ tasks }) => {
        const result = calculateCriticalPath({ tasks, calendar })
        const byId = new Map(result.tasks.map((entry) => [entry.taskId, entry]))
        for (const parent of result.parents) {
          for (const childId of parent.childIds) {
            const child = byId.get(childId)
            if (child === undefined) continue
            expect(child.earlyStart.getTime()).toBeGreaterThanOrEqual(parent.start.getTime())
            expect(child.earlyFinish.getTime()).toBeLessThanOrEqual(parent.finish.getTime())
          }
        }
      }),
    )
  })

  it('parent progress stays within 0 and 100', () => {
    fc.assert(
      fc.property(anyHierarchy, ({ tasks }) => {
        const result = calculateCriticalPath({ tasks, calendar })
        for (const parent of result.parents) {
          expect(parent.percentComplete).toBeGreaterThanOrEqual(0)
          expect(parent.percentComplete).toBeLessThanOrEqual(100)
        }
      }),
    )
  })

  it('leaf counts add up to the number of leaves', () => {
    fc.assert(
      fc.property(anyHierarchy, ({ tasks }) => {
        const result = calculateCriticalPath({ tasks, calendar })
        const total = result.parents.reduce((sum, parent) => sum + parent.leafCount, 0)
        expect(total).toBe(tasks.filter((entry) => entry.parentId !== undefined).length)
      }),
    )
  })
})
