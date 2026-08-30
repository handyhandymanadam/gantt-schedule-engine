/**
 * gantt-schedule-engine
 *
 * A headless project-scheduling engine. Pure functions over plain data: no DOM, no framework,
 * no fetching. The consuming application assembles the arrays and decides what to do with the
 * results.
 */

export type {
  Assignment,
  Baseline,
  BaselineEntry,
  EffortBasis,
  Hours,
  Link,
  LinkType,
  Resource,
  SchedulingMode,
  Task,
  WorkUnits,
} from './types.js'

export { ContinuousCalendar, continuousCalendar, MS_PER_HOUR, placeFinish, placeStart } from './calendar.js'
export type { Calendar } from './calendar.js'

export { hostOffset, localUtcOffsetMinutes, offsetForZone } from './timezone.js'
export type { UtcOffsetResolver } from './timezone.js'

export { WorkingWeekCalendar } from './working-week.js'
export type { Shift, Weekday, WorkingWeekOptions } from './working-week.js'

export { topologicalSort } from './graph.js'
export type { Edge, TopologicalResult } from './graph.js'

export {
  deriveDuration,
  deriveEffort,
  durationInDays,
  reconcileTask,
  snapHours,
  withResourceCount,
} from './effort.js'
export type { Rounding, SnapOptions } from './effort.js'

export { calculateCriticalPath, CyclicScheduleError } from './critical-path.js'
export type {
  ConstraintViolation,
  CriticalPathInput,
  CriticalPathResult,
  ScheduledTask,
} from './critical-path.js'

export { expandHierarchy, parentIds, rollUpParents } from './hierarchy.js'
export type { ExpandedGraph, ParentRollup } from './hierarchy.js'

export { autoSchedule } from './auto-schedule.js'
export type {
  AutoScheduleInput,
  AutoScheduleResult,
  ChangeReason,
  ProposedChange,
  ScheduleConflict,
} from './auto-schedule.js'

export { findResourceConflicts } from './resources.js'
export type {
  CapacityShortfall,
  ConflictWindow,
  DoubleBooking,
  ResourceConflict,
  ResourceConflictInput,
  ResourceConflictResult,
} from './resources.js'

export { baselineEffort, calculateRemainingWork } from './progress.js'
export type { ForecastMethod, ForecastOptions, RemainingWork } from './progress.js'

export { validate } from './validate.js'
export type {
  Severity,
  ValidateInput,
  ValidationCode,
  ValidationProblem,
  ValidationResult,
} from './validate.js'
