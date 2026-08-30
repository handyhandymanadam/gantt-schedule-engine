import type { Calendar } from './calendar.js'
import type { Hours, Task, WorkUnits } from './types.js'

/**
 * Conversion between work and duration.
 *
 * These are the only place the two are allowed to be derived from one another, and they are
 * always called explicitly at authoring time. Scheduling never invokes them: the well-known
 * failure in commercial tools is three coupled quantities where changing one silently recomputes
 * an unpredictable second, and keeping derivation out of the scheduling path is what prevents it.
 *
 * The core stays exact. Rounding is an authoring convention, applied once at the edge and never
 * accumulated through a chain of tasks.
 */

export type Rounding = 'up' | 'nearest' | 'down'

export interface SnapOptions {
  /**
   * Snap granularity as a fraction of a working day. `0.5` snaps to half days, `1` to whole
   * days, `0.25` to quarter days. Resolved against the calendar's nominal day, so it follows a
   * ten-hour week without reconfiguration.
   */
  dayFraction: number

  /**
   * Defaults to `'up'`. Under-stating a duration is the harmful direction in a schedule: it
   * produces a plan that was never achievable rather than one with a little slack in it.
   */
  rounding?: Rounding
}

/**
 * Duration from work and resource count: `effort / resourceCount`, optionally snapped.
 *
 * Nobody schedules to the quarter hour, so 240 work units across 7 resources — 34.29 hours —
 * usually wants rounding. Pass `snap` to get it; omit for the exact value.
 */
export function deriveDuration(
  effort: WorkUnits,
  resourceCount: number,
  calendar: Calendar,
  snap?: SnapOptions,
): Hours {
  if (!Number.isFinite(effort) || effort < 0) {
    throw new RangeError(`effort must be a finite non-negative number, received ${effort}`)
  }
  if (!Number.isFinite(resourceCount) || resourceCount <= 0) {
    throw new RangeError(`resourceCount must be a positive finite number, received ${resourceCount}`)
  }

  const exact = effort / resourceCount
  return snap === undefined ? exact : snapHours(exact, calendar, snap)
}

/** Work from duration and resource count: `duration * resourceCount`. Never snapped. */
export function deriveEffort(duration: Hours, resourceCount: number): WorkUnits {
  if (!Number.isFinite(duration) || duration < 0) {
    throw new RangeError(`duration must be a finite non-negative number, received ${duration}`)
  }
  if (!Number.isFinite(resourceCount) || resourceCount <= 0) {
    throw new RangeError(`resourceCount must be a positive finite number, received ${resourceCount}`)
  }
  return duration * resourceCount
}

/**
 * Round a duration to a fraction of a working day.
 *
 * Two guards matter more than the arithmetic. Zero stays zero, because a milestone that rounds up
 * into half a day of work is no longer a milestone. And a positive duration never rounds down to
 * zero — a one-hour task under half-day snapping becomes half a day, not a milestone. Silently
 * converting work into an instant is the worst available outcome.
 */
export function snapHours(hours: Hours, calendar: Calendar, snap: SnapOptions): Hours {
  const { dayFraction, rounding = 'up' } = snap

  if (!Number.isFinite(dayFraction) || dayFraction <= 0) {
    throw new RangeError(`dayFraction must be a positive finite number, received ${dayFraction}`)
  }
  if (!Number.isFinite(hours) || hours < 0) {
    throw new RangeError(`hours must be a finite non-negative number, received ${hours}`)
  }

  if (hours === 0) return 0

  const unit = dayFraction * calendar.nominalHoursPerDay
  const units = hours / unit

  let rounded: number
  switch (rounding) {
    case 'up':
      rounded = Math.ceil(units)
      break
    case 'down':
      rounded = Math.floor(units)
      break
    case 'nearest':
      rounded = Math.round(units)
      break
  }

  // Real work never collapses to an instant.
  if (rounded < 1) rounded = 1

  return rounded * unit
}

/**
 * Recompute whichever quantity a task derives, leaving the authored one untouched.
 *
 * Call this whenever the authored value or the resource count changes, so the stored pair cannot
 * drift apart. `validate()` reports the drift if it ever does.
 */
export function reconcileTask(task: Task, calendar: Calendar, snap?: SnapOptions): Task {
  if (task.basis === 'effort') {
    if (task.effort === undefined) {
      throw new RangeError(`Task "${task.id}" declares basis "effort" but has no effort value`)
    }
    return { ...task, duration: deriveDuration(task.effort, task.resourceCount, calendar, snap) }
  }
  return { ...task, effort: deriveEffort(task.duration, task.resourceCount) }
}

/**
 * A task with a new resource count, and whichever quantity it derives brought back into line.
 *
 * This is the operation behind a resource joining or leaving: on a work-driven task the duration
 * moves and the work is preserved, and on a duration-driven task the window holds and the work
 * moves. Which one gives is decided by the task's own `basis`, so the outcome is predictable
 * before the call.
 *
 * The result is a new task; nothing is mutated. Feed it to `autoSchedule` to see what the change
 * does to everything downstream before committing to it.
 */
export function withResourceCount(
  task: Task,
  resourceCount: number,
  calendar: Calendar,
  snap?: SnapOptions,
): Task {
  return reconcileTask({ ...task, resourceCount }, calendar, snap)
}

/** Duration expressed in working days, for display. Derived from the calendar's nominal day. */
export function durationInDays(duration: Hours, calendar: Calendar): number {
  return duration / calendar.nominalHoursPerDay
}
