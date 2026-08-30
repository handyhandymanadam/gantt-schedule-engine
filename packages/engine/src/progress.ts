import type { Hours, Task, WorkUnits } from './types.js'

/**
 * How much work is left.
 *
 * A task that has started cannot be rescheduled from its original estimate: some of the work is
 * already done, and rescheduling from the beginning silently rewrites history. What matters is
 * the *remaining* work, and there are two defensible ways to project it.
 *
 * The inputs stay independent by design. `percentComplete` is a human judgement of physical
 * progress and `actualHours` comes from timesheets; derive either from the other and the gap
 * between them - which is the entire signal - collapses to zero.
 */

export type ForecastMethod = 'plan' | 'performance'

export interface ForecastOptions {
  /**
   * `'performance'` (the default) scales remaining work by measured productivity. `'plan'`
   * assumes the rest goes to estimate.
   *
   * Performance is the better predictor once there is enough of a sample, and defaulting to plan
   * means the schedule keeps reporting that everything is fine while the timesheets say
   * otherwise. It is safe to default to because scheduling proposes rather than applies.
   */
  method?: ForecastMethod

  /**
   * Percent complete below which the performance factor is ignored and plan-based projection is
   * used instead. Defaults to 20.
   *
   * The factor is wildly unstable early: one rained-off morning at 5% complete implies a
   * catastrophic overrun. Around a fifth of the way through it settles enough to mean something.
   */
  performanceThreshold?: number
}

export interface RemainingWork {
  /** Work units still to do. */
  effortRemaining: WorkUnits
  /** Working hours still to do, at the task's current resource count. */
  durationRemaining: Hours
  /** Work units the reported progress has earned: `percentComplete * baseline effort`. */
  earned: WorkUnits
  /**
   * Earned over actual. Above 1 is ahead of estimate, below 1 is behind. Undefined when nothing
   * has been booked against the task, or when no progress has been reported.
   */
  performanceFactor?: number
  /** Which projection was actually applied, and why. */
  basis: 'not-started' | 'complete' | 'plan' | 'performance'
}

const DEFAULT_THRESHOLD = 20

/** Total work for a task, whichever quantity it was authored from. */
export function baselineEffort(task: Task): WorkUnits {
  return task.effort ?? task.duration * task.resourceCount
}

export function calculateRemainingWork(task: Task, options: ForecastOptions = {}): RemainingWork {
  const { method = 'performance', performanceThreshold = DEFAULT_THRESHOLD } = options

  const total = baselineEffort(task)
  const percent = task.percentComplete ?? 0

  if (percent >= 100) {
    return { effortRemaining: 0, durationRemaining: 0, earned: total, basis: 'complete' }
  }

  const earned = (percent / 100) * total
  const planRemaining = total - earned

  const started = percent > 0 || (task.actualHours ?? 0) > 0
  if (!started) {
    return {
      effortRemaining: total,
      durationRemaining: total / task.resourceCount,
      earned: 0,
      basis: 'not-started',
    }
  }

  const actual = task.actualHours ?? 0
  const factor = actual > 0 && earned > 0 ? earned / actual : undefined

  const usePerformance =
    method === 'performance' && factor !== undefined && factor > 0 && percent >= performanceThreshold

  const effortRemaining = usePerformance ? planRemaining / factor : planRemaining

  const result: RemainingWork = {
    effortRemaining,
    durationRemaining: effortRemaining / task.resourceCount,
    earned,
    basis: usePerformance ? 'performance' : 'plan',
  }
  return factor === undefined ? result : { ...result, performanceFactor: factor }
}
