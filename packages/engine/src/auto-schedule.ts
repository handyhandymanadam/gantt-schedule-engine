import { placeFinish, placeStart, type Calendar } from './calendar.js'
import { CyclicScheduleError } from './critical-path.js'
import { topologicalSort, type Edge } from './graph.js'
import { expandHierarchy, parentIds, rollUpParents, type ParentRollup } from './hierarchy.js'
import { calculateRemainingWork, type ForecastOptions } from './progress.js'
import type { Hours, Link, Task } from './types.js'

/**
 * Cascading auto-scheduling.
 *
 * Forward planning along Finish-to-Start dependencies: a successor starts when its predecessor
 * finishes, plus any lag, and moving a predecessor carries its successors with it.
 *
 * Two things distinguish this from a naive cascade.
 *
 * It **proposes rather than applies**. The return value is the set of changes it would make, so
 * an application can show "this moves six downstream tasks" and let a human decide. That is what
 * makes it safe to default to the more pessimistic forecast: nothing shifts under anyone.
 *
 * It respects a **data date**. Work already done never moves, and work not yet started is never
 * scheduled into the past. Without that, a reschedule quietly rewrites history and reports a
 * finish date that was never achievable.
 */

export type ChangeReason =
  /** A predecessor moved, so this moved with it. */
  | 'cascade'
  /** Pulled forward or pushed out to the data date; work cannot be planned in the past. */
  | 'data-date'
  /** In progress: the remaining work was re-projected from the data date. */
  | 'progress'

export interface ProposedChange {
  taskId: string
  fromStart: Date
  fromFinish: Date
  toStart: Date
  toFinish: Date
  /** Working hours the start moves by. Positive is later. */
  startDeltaHours: Hours
  /** Working hours the finish moves by. Positive is later. */
  finishDeltaHours: Hours
  reason: ChangeReason
}

export interface ScheduleConflict {
  taskId: string
  /** Where dependencies require the task to start. */
  requiredStart: Date
  /** Where it is pinned, by a manual start or by work already under way. */
  actualStart: Date
  /** Working hours by which the pin precedes what dependencies allow. */
  shortfallHours: Hours
  cause: 'manual-pin' | 'in-progress'
}

export interface AutoScheduleResult {
  /** Only tasks whose dates actually move. Empty means the schedule is already consistent. */
  changes: ProposedChange[]
  /**
   * The full proposed task list, in the input's original order, with new dates applied. The
   * input array is never mutated; apply this only once the changes have been accepted.
   */
  tasks: Task[]
  /** Scheduled finish per task, including those that did not move. */
  finishes: Map<string, Date>
  /** Places where a pin contradicts the dependency logic. Reported, never silently resolved. */
  conflicts: ScheduleConflict[]
  /** Parents derived from their descendants, after the reschedule. */
  parents: ParentRollup[]
}

export interface AutoScheduleInput {
  tasks: readonly Task[]
  links?: readonly Link[]
  calendar: Calendar

  /**
   * The boundary between history and plan, often called the data date.
   *
   * Nothing is scheduled to start before it, and in-progress work is re-projected forward from
   * it. Omit it to plan a schedule that has not started, in which case each task's own dates are
   * the only anchors.
   */
  statusDate?: Date

  /** How remaining work on in-progress tasks is projected. See {@link ForecastOptions}. */
  forecast?: ForecastOptions
}

export function autoSchedule(input: AutoScheduleInput): AutoScheduleResult {
  const { tasks, links = [], calendar, statusDate, forecast } = input

  if (tasks.length === 0) {
    return { changes: [], tasks: [], finishes: new Map(), conflicts: [], parents: [] }
  }

  // Parents carry no schedulable duration of their own; expansion swaps them for zero-duration
  // boundary nodes so the cascade below never has to know about hierarchy.
  const expanded = expandHierarchy(tasks, links)
  const scheduleTasks = expanded.tasks

  const byId = new Map(scheduleTasks.map((task) => [task.id, task]))
  const relevant = expanded.links.filter(
    (link) => byId.has(link.source) && byId.has(link.target),
  )

  const predecessors = new Map<string, Link[]>()
  for (const task of scheduleTasks) predecessors.set(task.id, [])
  for (const link of relevant) predecessors.get(link.target)!.push(link)

  const edges: Edge[] = relevant.map((link) => ({ from: link.source, to: link.target }))
  const { order, cycles, unresolved } = topologicalSort(
    scheduleTasks.map((task) => task.id),
    edges,
  )
  if (cycles.length > 0 || unresolved.length > 0) {
    throw new CyclicScheduleError(cycles.length > 0 ? cycles : [unresolved])
  }

  const starts = new Map<string, Date>()
  const finishes = new Map<string, Date>()
  const reasons = new Map<string, ChangeReason>()
  const conflicts: ScheduleConflict[] = []

  for (const id of order) {
    const task = byId.get(id)!

    // What dependencies require.
    let required: Date | undefined
    for (const link of predecessors.get(id)!) {
      const constrained = calendar.addWorkingTime(finishes.get(link.source)!, link.lag)
      if (required === undefined || constrained.getTime() > required.getTime()) {
        required = constrained
      }
    }

    const percent = task.percentComplete ?? 0
    const isComplete = percent >= 100 || task.actualFinish !== undefined
    const isUnderway = !isComplete && (task.actualStart !== undefined || percent > 0)

    let start: Date
    let finish: Date
    let reason: ChangeReason = 'cascade'

    if (isComplete) {
      // History. Recorded actuals win outright; nothing about a finished task is negotiable.
      start = task.actualStart ?? task.start
      finish = task.actualFinish ?? calendar.addWorkingTime(start, task.duration)
    } else if (isUnderway) {
      // Started but unfinished. The start already happened, so only the remaining work moves,
      // and it runs forward from the data date rather than from the original estimate.
      start = task.actualStart ?? task.start
      const remaining = calculateRemainingWork(task, forecast)
      const resumeFrom =
        statusDate !== undefined && statusDate.getTime() > start.getTime() ? statusDate : start
      const resumeAt = placeStart(resumeFrom, remaining.durationRemaining, calendar)
      finish = placeFinish(resumeAt, remaining.durationRemaining, calendar)
      reason = 'progress'

      if (required !== undefined && start.getTime() < required.getTime()) {
        conflicts.push({
          taskId: id,
          requiredStart: required,
          actualStart: start,
          shortfallHours: calendar.workingHoursBetween(start, required),
          cause: 'in-progress',
        })
      }
    } else if (task.schedulingMode === 'manual') {
      // Pinned by hand. Dependencies do not move it; a pin that precedes them is a contradiction
      // in the plan, so report it rather than quietly honouring one side.
      start = task.start
      if (required !== undefined && start.getTime() < required.getTime()) {
        conflicts.push({
          taskId: id,
          requiredStart: required,
          actualStart: start,
          shortfallHours: calendar.workingHoursBetween(start, required),
          cause: 'manual-pin',
        })
      }
      start = placeStart(start, task.duration, calendar)
      finish = placeFinish(start, task.duration, calendar)
    } else {
      // Not started and automatic: the ordinary case. Dependencies decide, floored at the data
      // date so nothing is planned into the past.
      const candidates: Date[] = [required ?? task.start]
      if (statusDate !== undefined && !expanded.synthetic.has(id)) candidates.push(statusDate)
      const chosen = candidates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b))

      if (required === undefined || chosen.getTime() !== required.getTime()) {
        reason = 'data-date'
      }
      start = placeStart(chosen, task.duration, calendar)
      finish = placeFinish(start, task.duration, calendar)
    }

    starts.set(id, start)
    finishes.set(id, finish)
    reasons.set(id, reason)
  }

  // ---- Diff against the input. ----

  const placement = new Map<string, { start: Date; finish: Date }>()
  for (const id of order) {
    if (expanded.synthetic.has(id)) continue
    placement.set(id, { start: starts.get(id)!, finish: finishes.get(id)! })
  }
  const parents = rollUpParents(tasks, placement, calendar, expanded)
  for (const [id, rollup] of parents) {
    starts.set(id, rollup.start)
    finishes.set(id, rollup.finish)
  }

  const isParent = parentIds(tasks)

  const changes: ProposedChange[] = []
  const proposed: Task[] = tasks.map((task) => {
    // A parent's dates are derived from its children, so they are written back rather than
    // proposed: both the extent and the span, so the array stays self-consistent for anyone
    // persisting it.
    const rollup = parents.get(task.id)
    if (rollup !== undefined) {
      return { ...task, start: rollup.start, duration: rollup.duration }
    }
    const start = starts.get(task.id)
    if (start === undefined || start.getTime() === task.start.getTime()) return task
    return { ...task, start }
  })

  for (const task of tasks) {
    // Parents are reported through `parents`, not as proposals. Nothing about a parent is a
    // decision anyone can accept or decline - it follows from whatever its children do.
    if (isParent.has(task.id)) continue

    const toStart = starts.get(task.id)
    const toFinish = finishes.get(task.id)
    if (toStart === undefined || toFinish === undefined) continue
    // Compare against the task's *effective* current dates. A completed task whose recorded
    // actual finish differs from its planned duration has not moved, and reporting it as a
    // change would mean every finished task showed up in every reschedule.
    const fromStart = task.actualStart ?? task.start
    const fromFinish = task.actualFinish ?? placeFinish(fromStart, task.duration, calendar)

    if (
      toStart.getTime() === fromStart.getTime() &&
      toFinish.getTime() === fromFinish.getTime()
    ) {
      continue
    }

    changes.push({
      taskId: task.id,
      fromStart,
      fromFinish,
      toStart,
      toFinish,
      startDeltaHours: calendar.workingHoursBetween(fromStart, toStart),
      finishDeltaHours: calendar.workingHoursBetween(fromFinish, toFinish),
      reason: reasons.get(task.id)!,
    })
  }

  for (const id of expanded.synthetic) finishes.delete(id)

  return {
    changes,
    tasks: proposed,
    finishes,
    conflicts: conflicts.filter((entry) => !expanded.synthetic.has(entry.taskId)),
    parents: [...parents.values()],
  }
}
