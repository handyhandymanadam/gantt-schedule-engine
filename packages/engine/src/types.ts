/**
 * Core data model.
 *
 * Working **hours** are the cardinal time unit throughout the engine. Person-hours are an
 * authoring surface; days are a display surface derived from the scheduled span. Nothing in
 * here is construction-specific by name — `resourceType` is an opaque grouping key.
 */

/** Elapsed working hours. The cardinal unit. */
export type Hours = number

/** Work units, conventionally person-hours. */
export type WorkUnits = number

/**
 * Which quantity the user authored. That quantity is held constant; the other is derived.
 *
 * - `'effort'` — work is the invariant. Change `resourceCount` and `duration` recomputes.
 * - `'duration'` — the window is the invariant. Change `resourceCount` and `effort` recomputes.
 *
 * This is per-task rather than per-project because both kinds coexist on one schedule: framing
 * is effort-driven, concrete curing is not, and a global switch would let you cure a slab faster
 * by adding labourers.
 */
export type EffortBasis = 'duration' | 'effort'

/** v1 supports Finish-to-Start only. SS/FF/SF are deferred. */
export type LinkType = 'FS'

/**
 * `'manual'` tasks are fixed anchors: they constrain successors but are never moved by
 * auto-scheduling. Every graph needs at least one.
 */
export type SchedulingMode = 'auto' | 'manual'

export interface Task {
  id: string

  /** Which of `duration`/`effort` the user authored. See {@link EffortBasis}. */
  basis: EffortBasis

  /** Required when `basis === 'effort'`. */
  effort?: WorkUnits

  /**
   * Planned headcount, driving the duration math. Fractional is legal and meaningful — a foreman
   * split across three jobs is `0.33`. Must be greater than zero.
   *
   * Deliberately independent of {@link Assignment}: this is *planned* capacity, assignments are
   * *named* people. You plan before you staff, and the gap between the two is a useful signal.
   */
  resourceCount: number

  /**
   * Elapsed working hours. Canonical — this is the only quantity CPM reads. Derived from
   * `effort / resourceCount` when `basis === 'effort'`.
   *
   * Zero duration means a milestone. There is deliberately no separate `isMilestone` flag, so
   * a contradictory state cannot be represented.
   */
  duration: Hours

  /** What kind of resource this task needs. Opaque grouping key used for capacity matching. */
  resourceType?: string

  start: Date

  schedulingMode: SchedulingMode

  parentId?: string

  actualStart?: Date
  actualFinish?: Date

  /**
   * Hours burned, from timesheets. Deliberately independent of `percentComplete` — the
   * performance factor lives in the gap between the two, so deriving either from the other
   * would make variance identically zero.
   */
  actualHours?: WorkUnits

  /** Physical progress as judged by the crew, 0–100. Independent of `actualHours`. */
  percentComplete?: number
}

export interface Link {
  id: string
  /** Predecessor task id. */
  source: string
  /** Successor task id. */
  target: string
  type: LinkType
  /** Working hours between predecessor finish and successor start. Negative means lead. */
  lag: Hours
}

export interface Resource {
  id: string
  /** Opaque grouping key. Capacity is computed per type, since work is not fungible across them. */
  type?: string
}

export interface Assignment {
  taskId: string
  resourceId: string
}

/**
 * A frozen snapshot to measure variance against. Earned value must be computed against the
 * baselined estimate, not the current one — otherwise an approved change order silently rebases
 * every variance figure.
 */
export interface BaselineEntry {
  taskId: string
  start: Date
  finish: Date
  duration: Hours
  effort?: WorkUnits
}

export interface Baseline {
  capturedAt: Date
  entries: BaselineEntry[]
}
