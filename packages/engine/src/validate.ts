import { topologicalSort, type Edge } from './graph.js'
import type { Assignment, Link, Resource, Task } from './types.js'

/**
 * Structural validation of a schedule.
 *
 * This is the engine's single authoritative rule set. A consuming app's client-side validation
 * should mirror these rules rather than hand-write a second, independently drifting copy: a
 * client that accepts what the engine rejects produces a failure with no visible cause at entry
 * time, which is precisely what client-side validation exists to prevent.
 */

export type Severity = 'error' | 'warning'

export type ValidationCode =
  | 'DUPLICATE_TASK_ID'
  | 'DUPLICATE_LINK_ID'
  | 'UNKNOWN_LINK_SOURCE'
  | 'UNKNOWN_LINK_TARGET'
  | 'SELF_LINK'
  | 'UNKNOWN_PARENT'
  | 'PARENT_CYCLE'
  | 'MISSING_EFFORT'
  | 'INVALID_RESOURCE_COUNT'
  | 'INVALID_DURATION'
  | 'INVALID_EFFORT'
  | 'INVALID_PERCENT_COMPLETE'
  | 'INVALID_ACTUAL_HOURS'
  | 'INVALID_DATE'
  | 'INVALID_LAG'
  | 'DEPENDENCY_CYCLE'
  | 'EFFORT_INVARIANT'
  | 'UNKNOWN_ASSIGNMENT_TASK'
  | 'UNKNOWN_ASSIGNMENT_RESOURCE'
  | 'MILESTONE_WITH_EFFORT'
  | 'PARENT_WITH_AUTHORED_DURATION'
  | 'NO_ANCHOR'

export interface ValidationProblem {
  code: ValidationCode
  severity: Severity
  message: string
  taskId?: string
  linkId?: string
  /** Present on DEPENDENCY_CYCLE and PARENT_CYCLE: the ids forming the loop. */
  cycle?: string[]
}

export interface ValidationResult {
  /** True when there are no errors. Warnings do not make a schedule invalid. */
  ok: boolean
  problems: ValidationProblem[]
  errors: ValidationProblem[]
  warnings: ValidationProblem[]
}

export interface ValidateInput {
  tasks: readonly Task[]
  links?: readonly Link[]
  resources?: readonly Resource[]
  assignments?: readonly Assignment[]
}

/** Tolerance for the effort/duration invariant, in hours. Floats will not land exactly. */
const EPSILON = 1e-6

type ProblemContext = { taskId?: string; linkId?: string; cycle?: string[] }

const problem = (
  code: ValidationCode,
  severity: Severity,
  message: string,
  context: ProblemContext = {},
): ValidationProblem => ({ code, severity, message, ...context })

const isValidDate = (value: Date): boolean =>
  value instanceof Date && Number.isFinite(value.getTime())

export function validate(input: ValidateInput): ValidationResult {
  const { tasks, links = [], resources = [], assignments = [] } = input
  const problems: ValidationProblem[] = []

  const taskIds = new Set<string>()
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      problems.push(
        problem('DUPLICATE_TASK_ID', 'error', `Task id "${task.id}" appears more than once.`, {
          taskId: task.id,
        }),
      )
    }
    taskIds.add(task.id)
  }

  for (const task of tasks) {
    validateTask(task, taskIds, problems)
  }

  validateParents(tasks, problems)
  validateLinks(links, taskIds, problems)
  validateDependencyGraph(tasks, links, taskIds, problems)
  validateAssignments(assignments, taskIds, resources, problems)

  if (tasks.length > 0 && !tasks.some((task) => task.schedulingMode === 'manual')) {
    problems.push(
      problem(
        'NO_ANCHOR',
        'warning',
        'No task uses schedulingMode "manual". A schedule with no fixed point has nothing to anchor its dates to.',
      ),
    )
  }

  const errors = problems.filter((entry) => entry.severity === 'error')
  const warnings = problems.filter((entry) => entry.severity === 'warning')
  return { ok: errors.length === 0, problems, errors, warnings }
}

function validateTask(task: Task, taskIds: Set<string>, problems: ValidationProblem[]): void {
  const at = { taskId: task.id }

  if (!isValidDate(task.start)) {
    problems.push(problem('INVALID_DATE', 'error', `Task "${task.id}" has an invalid start date.`, at))
  }
  if (task.actualStart !== undefined && !isValidDate(task.actualStart)) {
    problems.push(problem('INVALID_DATE', 'error', `Task "${task.id}" has an invalid actualStart.`, at))
  }
  if (task.actualFinish !== undefined && !isValidDate(task.actualFinish)) {
    problems.push(problem('INVALID_DATE', 'error', `Task "${task.id}" has an invalid actualFinish.`, at))
  }

  if (!Number.isFinite(task.resourceCount) || task.resourceCount <= 0) {
    problems.push(
      problem(
        'INVALID_RESOURCE_COUNT',
        'error',
        `Task "${task.id}" has resourceCount ${task.resourceCount}; it must be a positive finite number. Fractional values are legal.`,
        at,
      ),
    )
  }

  if (!Number.isFinite(task.duration) || task.duration < 0) {
    problems.push(
      problem(
        'INVALID_DURATION',
        'error',
        `Task "${task.id}" has duration ${task.duration}; it must be a finite number of hours, zero or greater. Zero means a milestone.`,
        at,
      ),
    )
  }

  if (task.effort !== undefined && (!Number.isFinite(task.effort) || task.effort < 0)) {
    problems.push(
      problem('INVALID_EFFORT', 'error', `Task "${task.id}" has effort ${task.effort}; it must be finite and non-negative.`, at),
    )
  }

  if (task.basis === 'effort') {
    if (task.effort === undefined) {
      problems.push(
        problem(
          'MISSING_EFFORT',
          'error',
          `Task "${task.id}" declares basis "effort" but has no effort value. The authored quantity cannot be absent.`,
          at,
        ),
      )
    } else if (
      Number.isFinite(task.effort) &&
      Number.isFinite(task.duration) &&
      Number.isFinite(task.resourceCount) &&
      task.resourceCount > 0
    ) {
      const expected = task.effort / task.resourceCount
      if (Math.abs(expected - task.duration) > EPSILON) {
        problems.push(
          problem(
            'EFFORT_INVARIANT',
            'error',
            `Task "${task.id}" violates effort / resourceCount === duration: ${task.effort} / ${task.resourceCount} is ${expected}, but duration is ${task.duration}. The stored values have drifted apart.`,
            at,
          ),
        )
      }
    }
  }

  if (task.percentComplete !== undefined) {
    if (!Number.isFinite(task.percentComplete) || task.percentComplete < 0 || task.percentComplete > 100) {
      problems.push(
        problem(
          'INVALID_PERCENT_COMPLETE',
          'error',
          `Task "${task.id}" has percentComplete ${task.percentComplete}; it must be between 0 and 100.`,
          at,
        ),
      )
    }
  }

  if (task.actualHours !== undefined && (!Number.isFinite(task.actualHours) || task.actualHours < 0)) {
    problems.push(
      problem('INVALID_ACTUAL_HOURS', 'error', `Task "${task.id}" has actualHours ${task.actualHours}; it must be finite and non-negative.`, at),
    )
  }

  if (task.parentId !== undefined && !taskIds.has(task.parentId)) {
    problems.push(
      problem('UNKNOWN_PARENT', 'error', `Task "${task.id}" names parent "${task.parentId}", which is not a known task.`, at),
    )
  }

  if (task.duration === 0 && task.effort !== undefined && task.effort > 0) {
    problems.push(
      problem(
        'MILESTONE_WITH_EFFORT',
        'warning',
        `Task "${task.id}" has zero duration, making it a milestone, but carries ${task.effort} effort. Milestones represent an instant, not work.`,
        at,
      ),
    )
  }
}

function validateParents(tasks: readonly Task[], problems: ValidationProblem[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const hasChildren = new Set<string>()
  for (const task of tasks) {
    if (task.parentId !== undefined) hasChildren.add(task.parentId)
  }

  for (const task of tasks) {
    if (hasChildren.has(task.id) && task.duration > 0) {
      problems.push(
        problem(
          'PARENT_WITH_AUTHORED_DURATION',
          'warning',
          `Task "${task.id}" has children, so its duration is derived from their span. The authored value of ${task.duration} will be ignored.`,
          { taskId: task.id },
        ),
      )
    }
  }

  const settled = new Set<string>()
  for (const task of tasks) {
    if (settled.has(task.id)) continue
    const path: string[] = []
    const onPath = new Set<string>()
    let current: Task | undefined = task

    while (current !== undefined) {
      if (onPath.has(current.id)) {
        const at = path.indexOf(current.id)
        problems.push(
          problem('PARENT_CYCLE', 'error', `Task "${current.id}" is its own ancestor through parentId.`, {
            taskId: current.id,
            cycle: [...path.slice(at), current.id],
          }),
        )
        break
      }
      if (settled.has(current.id)) break
      path.push(current.id)
      onPath.add(current.id)
      current = current.parentId === undefined ? undefined : byId.get(current.parentId)
    }

    for (const id of path) settled.add(id)
  }
}

function validateLinks(
  links: readonly Link[],
  taskIds: Set<string>,
  problems: ValidationProblem[],
): void {
  const linkIds = new Set<string>()

  for (const link of links) {
    const at = { linkId: link.id }

    if (linkIds.has(link.id)) {
      problems.push(problem('DUPLICATE_LINK_ID', 'error', `Link id "${link.id}" appears more than once.`, at))
    }
    linkIds.add(link.id)

    if (!taskIds.has(link.source)) {
      problems.push(
        problem('UNKNOWN_LINK_SOURCE', 'error', `Link "${link.id}" names source "${link.source}", which is not a known task.`, at),
      )
    }
    if (!taskIds.has(link.target)) {
      problems.push(
        problem('UNKNOWN_LINK_TARGET', 'error', `Link "${link.id}" names target "${link.target}", which is not a known task.`, at),
      )
    }
    if (link.source === link.target) {
      problems.push(
        problem('SELF_LINK', 'error', `Link "${link.id}" connects task "${link.source}" to itself.`, at),
      )
    }
    if (!Number.isFinite(link.lag)) {
      problems.push(problem('INVALID_LAG', 'error', `Link "${link.id}" has a non-finite lag.`, at))
    }
  }
}

function validateDependencyGraph(
  tasks: readonly Task[],
  links: readonly Link[],
  taskIds: Set<string>,
  problems: ValidationProblem[],
): void {
  const ids = tasks.map((task) => task.id)
  const edges: Edge[] = links
    .filter((link) => taskIds.has(link.source) && taskIds.has(link.target))
    .map((link) => ({ from: link.source, to: link.target }))

  const { cycles, unresolved } = topologicalSort(ids, edges)

  for (const cycle of cycles) {
    problems.push(
      problem(
        'DEPENDENCY_CYCLE',
        'error',
        `Dependency cycle: ${cycle.join(' -> ')}. A cyclic graph has no schedule, so this cannot be computed at all.`,
        { cycle },
      ),
    )
  }

  if (cycles.length === 0 && unresolved.length > 0) {
    problems.push(
      problem(
        'DEPENDENCY_CYCLE',
        'error',
        `${unresolved.length} task(s) could not be ordered because they depend on a cycle: ${unresolved.join(', ')}.`,
        { cycle: unresolved },
      ),
    )
  }
}

function validateAssignments(
  assignments: readonly Assignment[],
  taskIds: Set<string>,
  resources: readonly Resource[],
  problems: ValidationProblem[],
): void {
  const resourceIds = new Set(resources.map((resource) => resource.id))
  const checkResources = resources.length > 0

  for (const assignment of assignments) {
    if (!taskIds.has(assignment.taskId)) {
      problems.push(
        problem(
          'UNKNOWN_ASSIGNMENT_TASK',
          'error',
          `Assignment names task "${assignment.taskId}", which is not a known task.`,
          { taskId: assignment.taskId },
        ),
      )
    }
    if (checkResources && !resourceIds.has(assignment.resourceId)) {
      problems.push(
        problem(
          'UNKNOWN_ASSIGNMENT_RESOURCE',
          'error',
          `Assignment names resource "${assignment.resourceId}", which is not a known resource.`,
        ),
      )
    }
  }
}
