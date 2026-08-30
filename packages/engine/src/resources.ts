import { placeFinish, placeStart, type Calendar } from './calendar.js'
import { parentIds } from './hierarchy.js'
import type { Assignment, Resource, Task } from './types.js'

/**
 * Resource conflict detection.
 *
 * Deliberately **flagging, not levelling**. The engine says where the plan asks for more than
 * exists and which tasks could absorb it; it never rearranges anyone's assignments. Automatic
 * resource levelling is a problem even mature dedicated scheduling tools have not solved well,
 * and a heuristic that silently moves work is worse than an honest flag.
 *
 * Two different questions get answered here, and they need different data:
 *
 * - **Double-booking** asks whether a *named* resource is on two overlapping tasks. It needs
 *   assignments and nothing else.
 * - **Capacity** asks whether enough resources of a given *type* exist to cover what is planned.
 *   It needs the resource pool, and it works on tasks nobody has been assigned to yet - which is
 *   the forward-looking case that actually matters when deciding whether a month is staffable.
 *
 * Neither knows about projects. The data model is flat, so passing tasks from several projects
 * finds conflicts across all of them, which is exactly right: a resource double-booked across two
 * jobs is still double-booked.
 */

export interface ConflictWindow {
  from: Date
  to: Date
  /** Tasks active throughout the window. */
  taskIds: string[]
  /**
   * Those of `taskIds` that could absorb the conflict by stretching: work-driven and unfinished.
   * A duration-driven task cannot give - concrete cures for as long as it cures - so a window
   * with none of these has no scheduling remedy, only a staffing one.
   */
  elasticTaskIds: string[]
}

export interface DoubleBooking extends ConflictWindow {
  kind: 'double-booking'
  resourceId: string
  resourceType?: string
}

export interface CapacityShortfall extends ConflictWindow {
  kind: 'capacity'
  resourceType: string
  /** Resources of this type the plan asks for, summed across active tasks. */
  demand: number
  /** Resources of this type that exist. */
  supply: number
  /** `demand - supply`: how many more are needed. */
  shortfall: number
}

export type ResourceConflict = DoubleBooking | CapacityShortfall

export interface ResourceConflictResult {
  conflicts: ResourceConflict[]
  doubleBookings: DoubleBooking[]
  capacityShortfalls: CapacityShortfall[]
}

export interface ResourceConflictInput {
  tasks: readonly Task[]
  assignments?: readonly Assignment[]
  resources?: readonly Resource[]
  calendar: Calendar
  /**
   * Scheduled dates per task, typically `autoSchedule`'s output. Without it, each task's own
   * stored start and duration are used - which is only meaningful if the schedule is already
   * settled.
   */
  placement?: ReadonlyMap<string, { start: Date; finish: Date }>
}

interface Span {
  taskId: string
  from: number
  to: number
  weight: number
}

export function findResourceConflicts(input: ResourceConflictInput): ResourceConflictResult {
  const { tasks, assignments = [], resources = [], calendar, placement } = input

  const parents = parentIds(tasks)
  const byId = new Map(tasks.map((task) => [task.id, task]))

  const extentOf = (task: Task): { from: number; to: number } | undefined => {
    // Milestones mark an instant and consume nobody, so they cannot overlap with anything.
    if (task.duration === 0) return undefined
    const placed = placement?.get(task.id)
    if (placed !== undefined) {
      return { from: placed.start.getTime(), to: placed.finish.getTime() }
    }
    const start = placeStart(task.start, task.duration, calendar)
    return { from: start.getTime(), to: placeFinish(start, task.duration, calendar).getTime() }
  }

  const isElastic = (taskId: string): boolean => {
    const task = byId.get(taskId)
    if (task === undefined) return false
    return task.basis === 'effort' && (task.percentComplete ?? 0) < 100
  }

  const decorate = <T extends { taskIds: string[] }>(window: T): T & { elasticTaskIds: string[] } => ({
    ...window,
    elasticTaskIds: window.taskIds.filter(isElastic),
  })

  // ---- Double-booking: one named resource, two overlapping tasks. ----

  const resourceById = new Map(resources.map((resource) => [resource.id, resource]))
  const spansByResource = new Map<string, Span[]>()

  for (const assignment of assignments) {
    const task = byId.get(assignment.taskId)
    if (task === undefined || parents.has(task.id)) continue
    const extent = extentOf(task)
    if (extent === undefined) continue
    const spans = spansByResource.get(assignment.resourceId)
    const span: Span = { taskId: task.id, from: extent.from, to: extent.to, weight: 1 }
    if (spans === undefined) spansByResource.set(assignment.resourceId, [span])
    else spans.push(span)
  }

  const doubleBookings: DoubleBooking[] = []
  for (const [resourceId, spans] of spansByResource) {
    for (const window of sweep(spans, (total) => total > 1)) {
      const type = resourceById.get(resourceId)?.type
      const booking: DoubleBooking = decorate({
        kind: 'double-booking',
        resourceId,
        taskIds: window.taskIds,
        from: new Date(window.from),
        to: new Date(window.to),
        elasticTaskIds: [],
      })
      doubleBookings.push(type === undefined ? booking : { ...booking, resourceType: type })
    }
  }

  // ---- Capacity: enough of a type to go round, whether or not anyone is named yet. ----

  const supplyByType = new Map<string, number>()
  for (const resource of resources) {
    if (resource.type === undefined) continue
    supplyByType.set(resource.type, (supplyByType.get(resource.type) ?? 0) + 1)
  }

  const demandByType = new Map<string, Span[]>()
  for (const task of tasks) {
    if (task.resourceType === undefined || parents.has(task.id)) continue
    const extent = extentOf(task)
    if (extent === undefined) continue
    const spans = demandByType.get(task.resourceType)
    const span: Span = { ...extent, taskId: task.id, weight: task.resourceCount }
    if (spans === undefined) demandByType.set(task.resourceType, [span])
    else spans.push(span)
  }

  const capacityShortfalls: CapacityShortfall[] = []
  for (const [resourceType, spans] of demandByType) {
    const supply = supplyByType.get(resourceType)
    // With no pool of this type declared there is nothing to compare against. Reporting every
    // such task as a shortfall would bury the real ones.
    if (supply === undefined) continue

    for (const window of sweep(spans, (total) => total > supply + EPSILON)) {
      capacityShortfalls.push(
        decorate({
          kind: 'capacity',
          resourceType,
          demand: window.total,
          supply,
          shortfall: window.total - supply,
          taskIds: window.taskIds,
          from: new Date(window.from),
          to: new Date(window.to),
          elasticTaskIds: [],
        }),
      )
    }
  }

  const conflicts = [...doubleBookings, ...capacityShortfalls].sort(
    (a, b) => a.from.getTime() - b.from.getTime(),
  )

  return { conflicts, doubleBookings, capacityShortfalls }
}

const EPSILON = 1e-9

interface SweptWindow {
  from: number
  to: number
  total: number
  taskIds: string[]
}

/**
 * Sweep a set of spans and return the maximal windows where `exceeds` holds.
 *
 * Adjacent segments with the same set of active tasks are merged, so a conflict reads as one
 * window rather than being chopped up at every unrelated boundary in the schedule.
 */
function sweep(spans: readonly Span[], exceeds: (total: number) => boolean): SweptWindow[] {
  if (spans.length < 2) {
    const only = spans[0]
    if (only === undefined || !exceeds(only.weight)) return []
    return [{ from: only.from, to: only.to, total: only.weight, taskIds: [only.taskId] }]
  }

  const boundaries = [...new Set(spans.flatMap((span) => [span.from, span.to]))].sort(
    (a, b) => a - b,
  )

  const windows: SweptWindow[] = []
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index]!
    const to = boundaries[index + 1]!

    const active = spans.filter((span) => span.from < to && span.to > from)
    if (active.length === 0) continue

    const total = active.reduce((sum, span) => sum + span.weight, 0)
    if (!exceeds(total)) continue

    const taskIds = active.map((span) => span.taskId).sort()
    const previous = windows[windows.length - 1]
    if (
      previous !== undefined &&
      previous.to === from &&
      previous.taskIds.length === taskIds.length &&
      previous.taskIds.every((id, position) => id === taskIds[position])
    ) {
      previous.to = to
      continue
    }
    windows.push({ from, to, total, taskIds })
  }

  return windows
}
