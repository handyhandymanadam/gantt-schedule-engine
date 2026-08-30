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

export { ContinuousCalendar, continuousCalendar, MS_PER_HOUR } from './calendar.js'
export type { Calendar } from './calendar.js'

export { WorkingWeekCalendar } from './working-week.js'
export type { Shift, Weekday, WorkingWeekOptions } from './working-week.js'

export { topologicalSort } from './graph.js'
export type { Edge, TopologicalResult } from './graph.js'

export { calculateCriticalPath, CyclicScheduleError } from './critical-path.js'
export type {
  ConstraintViolation,
  CriticalPathInput,
  CriticalPathResult,
  ScheduledTask,
} from './critical-path.js'

export { validate } from './validate.js'
export type {
  Severity,
  ValidateInput,
  ValidationCode,
  ValidationProblem,
  ValidationResult,
} from './validate.js'
