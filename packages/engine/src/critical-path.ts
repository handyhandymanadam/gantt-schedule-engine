import { placeFinish, placeStart, type Calendar } from './calendar.js'
import { topologicalSort, type Edge } from './graph.js'
import { expandHierarchy, rollUpParents, type ParentRollup } from './hierarchy.js'
import type { Hours, Link, Task } from './types.js'

/**
 * Critical Path Method.
 *
 * Standard CPM, built to textbook correctness: a forward pass producing early start and finish,
 * a backward pass producing late start and finish, slack as the difference, and the critical
 * path as the chain of zero-slack tasks. This is public-domain operations-research mathematics,
 * so there is no reason for it to be less correct here than in a commercial implementation.
 *
 * All arithmetic goes through the {@link Calendar}, so results are in working time. Under the
 * continuous 24/7 calendar this reduces to naive date arithmetic, which is what makes that
 * calendar a useful oracle: a real working-week calendar must reproduce these same results when
 * every hour is a working hour.
 *
 * Hierarchy is not interpreted here. Every task passed in is treated as a schedulable node;
 * parent rollup and the boundary-node expansion that makes links between parents work are a
 * later, separate pass over these results.
 */

export interface ScheduledTask {
  taskId: string

  /** Earliest the task can start without violating any dependency. */
  earlyStart: Date
  /** Earliest it can finish: early start advanced by its duration in working time. */
  earlyFinish: Date

  /** Latest it can start without delaying the project. */
  lateStart: Date
  /** Latest it can finish without delaying the project. */
  lateFinish: Date

  /**
   * Working hours the task can slip without delaying the project as a whole.
   * Zero means critical.
   */
  totalSlack: Hours

  /**
   * Working hours the task can slip without delaying *any successor's* early start. Always less
   * than or equal to total slack. This is the slack a scheduler can spend with no knock-on
   * effect at all, which is usually the more actionable of the two.
   */
  freeSlack: Hours

  isCritical: boolean
}

export interface ConstraintViolation {
  taskId: string
  /** Where dependencies say the task must start. */
  requiredStart: Date
  /** Where the task is pinned by its own manual start date. */
  pinnedStart: Date
  /** Working hours by which the pin precedes what dependencies allow. */
  shortfallHours: Hours
}

export interface CriticalPathResult {
  /** One entry per input task, in dependency order. */
  tasks: ScheduledTask[]
  /** Ids of the zero-slack tasks, in dependency order. */
  criticalPath: string[]
  projectStart: Date
  projectFinish: Date
  /** Working hours from project start to project finish. */
  projectDuration: Hours
  /**
   * Manual tasks pinned earlier than their predecessors permit. CPM still returns a result;
   * these say where the plan contradicts itself.
   */
  violations: ConstraintViolation[]
  /**
   * Parents derived from their descendants. Parents are never scheduled directly, so they do not
   * appear in `tasks` or on the critical path; their extent is whatever their children occupy.
   */
  parents: ParentRollup[]
}

export interface CriticalPathInput {
  tasks: readonly Task[]
  links?: readonly Link[]
  calendar: Calendar
  /**
   * Hours below which slack counts as zero. Floating-point division (240 hours across 7 people)
   * will not land exactly on zero, and a task missing the critical path by 1e-13 hours is a
   * rounding artefact rather than a scheduling fact.
   */
  slackTolerance?: Hours
}

const DEFAULT_SLACK_TOLERANCE = 1e-6

/**
 * Thrown when the dependency graph contains a cycle. A cyclic graph has no schedule at all, so
 * this is an error rather than a degraded result. Use `validate()` first to report cycles as
 * data instead.
 */
export class CyclicScheduleError extends Error {
  readonly cycles: string[][]

  constructor(cycles: string[][]) {
    const described = cycles.map((cycle) => cycle.join(' -> ')).join('; ')
    super(`Cannot compute a schedule: the dependency graph contains a cycle (${described}).`)
    this.name = 'CyclicScheduleError'
    this.cycles = cycles
  }
}

export function calculateCriticalPath(input: CriticalPathInput): CriticalPathResult {
  const { tasks, links = [], calendar, slackTolerance = DEFAULT_SLACK_TOLERANCE } = input

  if (tasks.length === 0) {
    const epoch = new Date(0)
    return {
      tasks: [],
      criticalPath: [],
      projectStart: epoch,
      projectFinish: epoch,
      projectDuration: 0,
      violations: [],
      parents: [],
    }
  }

  // Parents are not schedulable nodes. Expansion replaces them with zero-duration boundary
  // nodes so the passes below never need to know hierarchy exists.
  const expanded = expandHierarchy(tasks, links)
  const scheduleTasks = expanded.tasks
  const scheduleLinks = expanded.links

  const byId = new Map(scheduleTasks.map((task) => [task.id, task]))
  const relevant = scheduleLinks.filter((link) => byId.has(link.source) && byId.has(link.target))

  const predecessors = new Map<string, Link[]>()
  const successors = new Map<string, Link[]>()
  for (const task of scheduleTasks) {
    predecessors.set(task.id, [])
    successors.set(task.id, [])
  }
  for (const link of relevant) {
    predecessors.get(link.target)!.push(link)
    successors.get(link.source)!.push(link)
  }

  const edges: Edge[] = relevant.map((link) => ({ from: link.source, to: link.target }))
  const { order, cycles, unresolved } = topologicalSort(
    scheduleTasks.map((task) => task.id),
    edges,
  )

  if (cycles.length > 0 || unresolved.length > 0) {
    throw new CyclicScheduleError(cycles.length > 0 ? cycles : [unresolved])
  }

  // ---- Forward pass: earliest possible dates, in dependency order. ----

  const earlyStart = new Map<string, Date>()
  const earlyFinish = new Map<string, Date>()
  const violations: ConstraintViolation[] = []

  for (const id of order) {
    const task = byId.get(id)!
    const incoming = predecessors.get(id)!

    // A predecessor constrains its successor to start at the predecessor's finish, plus lag.
    let required: Date | undefined
    for (const link of incoming) {
      const constrained = calendar.addWorkingTime(earlyFinish.get(link.source)!, link.lag)
      if (required === undefined || constrained.getTime() > required.getTime()) {
        required = constrained
      }
    }

    let start: Date
    if (required === undefined) {
      // No predecessors: the task's own date is its anchor.
      start = task.start
    } else if (task.schedulingMode === 'manual') {
      // Pinned. Dependencies do not move it, but a pin that precedes them is a contradiction
      // in the plan, so report it rather than silently honouring one side.
      start = task.start
      if (task.start.getTime() < required.getTime()) {
        violations.push({
          taskId: id,
          requiredStart: required,
          pinnedStart: task.start,
          shortfallHours: calendar.workingHoursBetween(task.start, required),
        })
      }
    } else {
      start = required
    }

    const normalisedStart = placeStart(start, task.duration, calendar)
    const finish = placeFinish(normalisedStart, task.duration, calendar)

    earlyStart.set(id, normalisedStart)
    earlyFinish.set(id, finish)
  }

  const projectStart = earliest([...earlyStart.values()])
  const projectFinish = latest([...earlyFinish.values()])

  // ---- Backward pass: latest dates that still hit the project finish, in reverse order. ----

  const lateStart = new Map<string, Date>()
  const lateFinish = new Map<string, Date>()

  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index]!
    const task = byId.get(id)!
    const outgoing = successors.get(id)!

    // A successor constrains its predecessor to finish by the successor's late start, less lag.
    let limit: Date | undefined
    for (const link of outgoing) {
      const constrained = calendar.addWorkingTime(lateStart.get(link.target)!, -link.lag)
      if (limit === undefined || constrained.getTime() < limit.getTime()) {
        limit = constrained
      }
    }

    // A task with no successors may run until the project ends.
    const finish = limit ?? projectFinish
    const start =
      task.duration === 0 ? finish : calendar.addWorkingTime(finish, -task.duration)

    lateFinish.set(id, finish)
    lateStart.set(id, start)
  }

  // ---- Slack and the critical chain. ----

  const allScheduled: ScheduledTask[] = order.map((id) => {
    const es = earlyStart.get(id)!
    const ef = earlyFinish.get(id)!
    const ls = lateStart.get(id)!
    const lf = lateFinish.get(id)!

    const totalSlack = calendar.workingHoursBetween(es, ls)

    // Free slack is bounded by the earliest early start among successors, not by the project.
    const outgoing = successors.get(id)!
    let freeSlack = totalSlack
    for (const link of outgoing) {
      const successorAllows = calendar.workingHoursBetween(
        calendar.addWorkingTime(ef, link.lag),
        earlyStart.get(link.target)!,
      )
      if (successorAllows < freeSlack) freeSlack = successorAllows
    }

    return {
      taskId: id,
      earlyStart: es,
      earlyFinish: ef,
      lateStart: ls,
      lateFinish: lf,
      totalSlack: normaliseSlack(totalSlack, slackTolerance),
      freeSlack: normaliseSlack(freeSlack, slackTolerance),
      isCritical: Math.abs(totalSlack) <= slackTolerance,
    }
  })

  // Boundary nodes exist only to carry phase-level links; they are not part of the plan.
  const scheduled = allScheduled.filter((entry) => !expanded.synthetic.has(entry.taskId))

  const placement = new Map(
    scheduled.map((entry) => [entry.taskId, { start: entry.earlyStart, finish: entry.earlyFinish }]),
  )
  const parents = rollUpParents(tasks, placement, calendar, expanded)

  return {
    tasks: scheduled,
    criticalPath: scheduled.filter((entry) => entry.isCritical).map((entry) => entry.taskId),
    projectStart,
    projectFinish,
    projectDuration: calendar.workingHoursBetween(projectStart, projectFinish),
    violations: violations.filter((entry) => !expanded.synthetic.has(entry.taskId)),
    parents: [...parents.values()],
  }
}

/** Collapse rounding dust to exactly zero so callers can compare slack against 0 directly. */
function normaliseSlack(value: Hours, tolerance: Hours): Hours {
  return Math.abs(value) <= tolerance ? 0 : value
}

function earliest(dates: Date[]): Date {
  let result = dates[0]!
  for (const date of dates) {
    if (date.getTime() < result.getTime()) result = date
  }
  return new Date(result.getTime())
}

function latest(dates: Date[]): Date {
  let result = dates[0]!
  for (const date of dates) {
    if (date.getTime() > result.getTime()) result = date
  }
  return new Date(result.getTime())
}
