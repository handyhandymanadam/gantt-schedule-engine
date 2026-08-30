import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { validate, type ValidationCode } from '../src/validate.js'
import type { Link, Task } from '../src/types.js'

const START = new Date('2026-09-01T08:00:00Z')

/** A valid duration-basis task. Overrides are applied on top. */
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  basis: 'duration',
  resourceCount: 1,
  duration: 8,
  start: START,
  schedulingMode: 'manual',
  ...overrides,
})

const link = (id: string, source: string, target: string, lag = 0): Link => ({
  id,
  source,
  target,
  type: 'FS',
  lag,
})

const codes = (result: { problems: { code: ValidationCode }[] }): ValidationCode[] =>
  result.problems.map((problem) => problem.code)

describe('validate', () => {
  it('accepts a minimal valid schedule', () => {
    const result = validate({ tasks: [task('a')], links: [] })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('accepts an effort-basis task whose invariant holds', () => {
    const framing = task('framing', {
      basis: 'effort',
      effort: 240,
      resourceCount: 4,
      duration: 60,
    })
    const result = validate({ tasks: [framing] })
    expect(result.ok).toBe(true)
  })

  it('rejects an effort-basis task with no effort value', () => {
    const result = validate({ tasks: [task('a', { basis: 'effort' })] })
    expect(codes(result)).toContain('MISSING_EFFORT')
    expect(result.ok).toBe(false)
  })

  it('rejects effort and duration that have drifted apart', () => {
    const drifted = task('framing', {
      basis: 'effort',
      effort: 240,
      resourceCount: 4,
      duration: 48, // should be 60
    })
    const result = validate({ tasks: [drifted] })
    expect(codes(result)).toContain('EFFORT_INVARIANT')
  })

  it('tolerates floating point imprecision in the invariant', () => {
    const sevenCrew = task('framing', {
      basis: 'effort',
      effort: 240,
      resourceCount: 7,
      duration: 240 / 7,
    })
    expect(validate({ tasks: [sevenCrew] }).ok).toBe(true)
  })

  it('accepts a fractional resource count', () => {
    const foreman = task('supervision', {
      basis: 'effort',
      effort: 12,
      resourceCount: 0.33,
      duration: 12 / 0.33,
    })
    expect(validate({ tasks: [foreman] }).ok).toBe(true)
  })

  it('rejects a zero or negative resource count', () => {
    expect(codes(validate({ tasks: [task('a', { resourceCount: 0 })] }))).toContain('INVALID_RESOURCE_COUNT')
    expect(codes(validate({ tasks: [task('a', { resourceCount: -2 })] }))).toContain('INVALID_RESOURCE_COUNT')
  })

  it('accepts zero duration as a milestone', () => {
    const result = validate({ tasks: [task('inspection', { duration: 0 })] })
    expect(result.ok).toBe(true)
  })

  it('warns when a milestone carries effort', () => {
    const result = validate({
      tasks: [task('inspection', { duration: 0, effort: 4 })],
    })
    expect(codes(result)).toContain('MILESTONE_WITH_EFFORT')
    expect(result.ok).toBe(true) // a warning, not an error
  })

  it('rejects a negative duration', () => {
    expect(codes(validate({ tasks: [task('a', { duration: -1 })] }))).toContain('INVALID_DURATION')
  })

  it('rejects percentComplete outside 0 to 100', () => {
    expect(codes(validate({ tasks: [task('a', { percentComplete: 101 })] }))).toContain('INVALID_PERCENT_COMPLETE')
    expect(codes(validate({ tasks: [task('a', { percentComplete: -1 })] }))).toContain('INVALID_PERCENT_COMPLETE')
    expect(validate({ tasks: [task('a', { percentComplete: 0 })] }).ok).toBe(true)
    expect(validate({ tasks: [task('a', { percentComplete: 100 })] }).ok).toBe(true)
  })

  it('rejects negative actual hours', () => {
    expect(codes(validate({ tasks: [task('a', { actualHours: -5 })] }))).toContain('INVALID_ACTUAL_HOURS')
  })

  it('rejects an invalid start date', () => {
    expect(codes(validate({ tasks: [task('a', { start: new Date('nonsense') })] }))).toContain('INVALID_DATE')
  })

  it('rejects duplicate task ids', () => {
    expect(codes(validate({ tasks: [task('a'), task('a')] }))).toContain('DUPLICATE_TASK_ID')
  })

  it('rejects duplicate link ids', () => {
    const result = validate({
      tasks: [task('a'), task('b')],
      links: [link('l1', 'a', 'b'), link('l1', 'b', 'a')],
    })
    expect(codes(result)).toContain('DUPLICATE_LINK_ID')
  })

  it('rejects links pointing at unknown tasks', () => {
    const result = validate({ tasks: [task('a')], links: [link('l1', 'a', 'ghost')] })
    expect(codes(result)).toContain('UNKNOWN_LINK_TARGET')
  })

  it('rejects a self-link', () => {
    const result = validate({ tasks: [task('a')], links: [link('l1', 'a', 'a')] })
    expect(codes(result)).toContain('SELF_LINK')
  })

  it('rejects a dependency cycle and names the loop', () => {
    const result = validate({
      tasks: [task('a'), task('b')],
      links: [link('l1', 'a', 'b'), link('l2', 'b', 'a')],
    })
    const cycle = result.errors.find((problem) => problem.code === 'DEPENDENCY_CYCLE')
    expect(cycle).toBeDefined()
    expect(cycle!.cycle).toEqual(['a', 'b', 'a'])
  })

  it('rejects an unknown parent', () => {
    expect(codes(validate({ tasks: [task('a', { parentId: 'ghost' })] }))).toContain('UNKNOWN_PARENT')
  })

  it('rejects a parent cycle', () => {
    const result = validate({
      tasks: [task('a', { parentId: 'b' }), task('b', { parentId: 'a' })],
    })
    expect(codes(result)).toContain('PARENT_CYCLE')
  })

  it('warns that a parent task has an authored duration, since it is derived', () => {
    const result = validate({
      tasks: [task('phase', { duration: 40 }), task('child', { parentId: 'phase' })],
    })
    expect(codes(result)).toContain('PARENT_WITH_AUTHORED_DURATION')
    expect(result.ok).toBe(true)
  })

  it('allows links on parent tasks, which the engine expands to boundary nodes', () => {
    const result = validate({
      tasks: [
        task('foundation'),
        task('framing'),
        task('pour', { parentId: 'foundation' }),
        task('walls', { parentId: 'framing' }),
      ],
      links: [link('l1', 'foundation', 'framing')],
    })
    expect(result.errors).toEqual([])
  })

  it('warns when nothing anchors the schedule', () => {
    const result = validate({ tasks: [task('a', { schedulingMode: 'auto' })] })
    expect(codes(result)).toContain('NO_ANCHOR')
    expect(result.ok).toBe(true)
  })

  it('rejects assignments naming unknown tasks or resources', () => {
    const result = validate({
      tasks: [task('a')],
      resources: [{ id: 'r1', type: 'framer' }],
      assignments: [
        { taskId: 'ghost', resourceId: 'r1' },
        { taskId: 'a', resourceId: 'nobody' },
      ],
    })
    expect(codes(result)).toContain('UNKNOWN_ASSIGNMENT_TASK')
    expect(codes(result)).toContain('UNKNOWN_ASSIGNMENT_RESOURCE')
  })

  it('separates errors from warnings', () => {
    const result = validate({
      tasks: [task('a', { schedulingMode: 'auto', resourceCount: 0 })],
    })
    expect(result.errors.every((problem) => problem.severity === 'error')).toBe(true)
    expect(result.warnings.every((problem) => problem.severity === 'warning')).toBe(true)
    expect(result.problems).toHaveLength(result.errors.length + result.warnings.length)
  })

  it('handles an empty schedule', () => {
    const result = validate({ tasks: [] })
    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
  })
})

describe('validate properties', () => {
  it('never reports an error for a well-formed effort-basis task', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 40 }),
        (effort, resourceCount) => {
          const built = task('t', {
            basis: 'effort',
            effort,
            resourceCount,
            duration: effort / resourceCount,
          })
          expect(validate({ tasks: [built] }).errors).toEqual([])
        },
      ),
    )
  })

  it('ok is exactly the absence of errors', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            duration: fc.integer({ min: -5, max: 40 }),
            resourceCount: fc.integer({ min: -2, max: 6 }),
            percentComplete: fc.integer({ min: -10, max: 110 }),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        (specs) => {
          const tasks = specs.map((spec, index) => task(`t${index}`, spec))
          const result = validate({ tasks })
          expect(result.ok).toBe(result.errors.length === 0)
        },
      ),
    )
  })
})
