import { placeFinish, placeStart, type Calendar } from './calendar.js'
import { parentIds } from './hierarchy.js'
import { baselineEffort, calculateRemainingWork, type ForecastOptions } from './progress.js'
import type { Baseline, BaselineEntry, Hours, Task, WorkUnits } from './types.js'

/**
 * Earned value: what the plan said, what was actually spent, and where that leads.
 *
 * The three inputs stay independent by design. `percentComplete` is a human judgement of physical
 * progress, `actualHours` comes from timesheets, and the baseline is a frozen snapshot. Derive
 * any of them from another and the variance is identically zero, which is the one outcome
 * guaranteed to be useless.
 *
 * **Measure against the baseline, not the current estimate.** Approve a change order that adds
 * work to a task and, without a baseline, every variance figure silently rebases: the team
 * appears to gain efficiency for doing nothing. Freezing the estimate field is not the answer,
 * because scope revisions are legitimate and routine. Baselining is, because re-baselining then
 * becomes an explicit and auditable act rather than a quiet edit.
 *
 * **Read the performance factor as a trend, not a verdict.** One task at 0.8 may only mean the
 * crew hit rock. The signal is real across many tasks, crews and months - which is also what
 * makes it worth accumulating, since measured productivity is what turns the next estimate from
 * a guess into a calculation.
 *
 * Parents are excluded throughout. Their work is the sum of their children's, so including both
 * would double every total.
 */

export interface TaskVariance {
  taskId: string

  /** Work the baseline committed to, or the current estimate when no baseline is supplied. */
  baselineEffort: WorkUnits
  /** Work the reported progress has earned: `percentComplete * baselineEffort`. */
  earned: WorkUnits
  /** Work actually booked against the task. */
  actualHours: WorkUnits
  /** Earned over actual. Above 1 is ahead of estimate, below 1 is behind. */
  performanceFactor?: number

  percentComplete: number
  effortRemaining: WorkUnits
  /** Projected total at completion: what has been spent plus what is left. */
  forecastEffort: WorkUnits
  /** `baselineEffort - forecastEffort`. Negative is an overrun. */
  effortVariance: WorkUnits
  /** Which projection produced `effortRemaining`. */
  basis: 'not-started' | 'complete' | 'plan' | 'performance'

  baselineStart?: Date
  baselineFinish?: Date
  currentStart: Date
  currentFinish: Date
  /** Working hours later than the baseline start. Negative is early. */
  startVarianceHours?: Hours
  /** Working hours later than the baseline finish. Negative is early. */
  finishVarianceHours?: Hours
}

export interface GroupVariance {
  /** A resource type, or `'all'` for the whole schedule. */
  key: string
  taskCount: number
  baselineEffort: WorkUnits
  earned: WorkUnits
  actualHours: WorkUnits
  forecastEffort: WorkUnits
  effortVariance: WorkUnits
  /**
   * Aggregated as total earned over total actual, not as a mean of the per-task factors. An
   * average would let a two-hour task weigh as much as a two-hundred-hour one.
   */
  performanceFactor?: number
  percentComplete: number
}

export interface ProgressVarianceResult {
  tasks: TaskVariance[]
  overall: GroupVariance
  /** The same figures per resource type - the calibration data for future estimating. */
  byResourceType: GroupVariance[]
  projectFinish?: Date
  baselineFinish?: Date
  /** Working hours the projected finish falls later than the baseline finish. */
  projectFinishVarianceHours?: Hours
}

export interface ProgressVarianceInput {
  tasks: readonly Task[]
  calendar: Calendar
  /** Freeze from `captureBaseline`. Without one, variance measures against current estimates. */
  baseline?: Baseline
  /** Scheduled dates, typically `autoSchedule`'s output. Falls back to each task's own dates. */
  placement?: ReadonlyMap<string, { start: Date; finish: Date }>
  forecast?: ForecastOptions
}

/**
 * Freeze the current plan so variance has something to measure against.
 *
 * Pure: the snapshot is returned, never stored. Persisting it, deciding which snapshot is
 * current, and any approval around re-baselining all belong to the application. Comparing against
 * two baselines - the original commitment and the post-change-order plan - is just calling this
 * twice and keeping both.
 */
export function captureBaseline(
  tasks: readonly Task[],
  capturedAt: Date,
  calendar: Calendar,
  placement?: ReadonlyMap<string, { start: Date; finish: Date }>,
): Baseline {
  const entries: BaselineEntry[] = tasks.map((task) => {
    const extent = extentOf(task, calendar, placement)
    const entry: BaselineEntry = {
      taskId: task.id,
      start: extent.start,
      finish: extent.finish,
      duration: task.duration,
    }
    const effort = task.effort ?? task.duration * task.resourceCount
    return { ...entry, effort }
  })

  return { capturedAt: new Date(capturedAt.getTime()), entries }
}

export function calculateProgressVariance(input: ProgressVarianceInput): ProgressVarianceResult {
  const { tasks, calendar, baseline, placement, forecast } = input

  const parents = parentIds(tasks)
  const baselineById = new Map((baseline?.entries ?? []).map((entry) => [entry.taskId, entry]))

  const variances: TaskVariance[] = []

  for (const task of tasks) {
    if (parents.has(task.id)) continue

    const frozen = baselineById.get(task.id)
    // The baseline is the commitment. Falling back to the current estimate is correct only when
    // there is no baseline at all; silently preferring the current one would erase the variance.
    const committed = frozen?.effort ?? baselineEffort(task)

    const percent = task.percentComplete ?? 0
    const earned = (percent / 100) * committed
    const actualHours = task.actualHours ?? 0

    const remaining = calculateRemainingWork(task, forecast)
    // Re-scale remaining work onto the committed figure, so a revised estimate does not quietly
    // replace what was promised.
    const currentTotal = baselineEffort(task)
    const scale = currentTotal > 0 ? committed / currentTotal : 1
    const effortRemaining = remaining.effortRemaining * scale
    const forecastEffort = actualHours + effortRemaining

    const extent = extentOf(task, calendar, placement)

    const entry: TaskVariance = {
      taskId: task.id,
      baselineEffort: committed,
      earned,
      actualHours,
      percentComplete: percent,
      effortRemaining,
      forecastEffort,
      effortVariance: committed - forecastEffort,
      basis: remaining.basis,
      currentStart: extent.start,
      currentFinish: extent.finish,
    }

    const withFactor =
      actualHours > 0 && earned > 0 ? { ...entry, performanceFactor: earned / actualHours } : entry

    variances.push(
      frozen === undefined
        ? withFactor
        : {
            ...withFactor,
            baselineStart: frozen.start,
            baselineFinish: frozen.finish,
            startVarianceHours: calendar.workingHoursBetween(frozen.start, extent.start),
            finishVarianceHours: calendar.workingHoursBetween(frozen.finish, extent.finish),
          },
    )
  }

  const overall = aggregate('all', variances)

  const groups = new Map<string, TaskVariance[]>()
  const typeOf = new Map(tasks.map((task) => [task.id, task.resourceType]))
  for (const variance of variances) {
    const type = typeOf.get(variance.taskId)
    if (type === undefined) continue
    const bucket = groups.get(type)
    if (bucket === undefined) groups.set(type, [variance])
    else bucket.push(variance)
  }

  const byResourceType = [...groups.entries()].map(([key, group]) => aggregate(key, group))

  const result: ProgressVarianceResult = { tasks: variances, overall, byResourceType }

  if (variances.length === 0) return result

  const projectFinish = new Date(
    Math.max(...variances.map((entry) => entry.currentFinish.getTime())),
  )
  const baselineFinishes = variances
    .map((entry) => entry.baselineFinish)
    .filter((value): value is Date => value !== undefined)

  if (baselineFinishes.length === 0) return { ...result, projectFinish }

  const baselineFinish = new Date(Math.max(...baselineFinishes.map((date) => date.getTime())))
  return {
    ...result,
    projectFinish,
    baselineFinish,
    projectFinishVarianceHours: calendar.workingHoursBetween(baselineFinish, projectFinish),
  }
}

function aggregate(key: string, group: readonly TaskVariance[]): GroupVariance {
  const sum = (pick: (entry: TaskVariance) => number): number =>
    group.reduce((total, entry) => total + pick(entry), 0)

  const committed = sum((entry) => entry.baselineEffort)
  const earned = sum((entry) => entry.earned)
  const actualHours = sum((entry) => entry.actualHours)
  const forecastEffort = sum((entry) => entry.forecastEffort)

  const base: GroupVariance = {
    key,
    taskCount: group.length,
    baselineEffort: committed,
    earned,
    actualHours,
    forecastEffort,
    effortVariance: committed - forecastEffort,
    percentComplete: committed > 0 ? (earned / committed) * 100 : 0,
  }

  return actualHours > 0 && earned > 0 ? { ...base, performanceFactor: earned / actualHours } : base
}

function extentOf(
  task: Task,
  calendar: Calendar,
  placement?: ReadonlyMap<string, { start: Date; finish: Date }>,
): { start: Date; finish: Date } {
  const placed = placement?.get(task.id)
  if (placed !== undefined) return placed
  const start = placeStart(task.actualStart ?? task.start, task.duration, calendar)
  return { start, finish: task.actualFinish ?? placeFinish(start, task.duration, calendar) }
}
