import type { Calendar } from './calendar.js'
import type { Hours, Link, Task, WorkUnits } from './types.js'

/**
 * Task hierarchy: scheduling parents out of the graph, and deriving them back afterwards.
 *
 * Scheduling runs on leaves only. A parent has no duration of its own to schedule - its extent
 * is whatever its children turn out to occupy - so treating it as a node would double-count the
 * work its children already represent.
 *
 * That leaves the question of what a link *to* a parent means, since planning in phases is how
 * most people actually think. The answer here is to materialise two zero-duration boundary nodes
 * per linked parent and rewrite the link onto them: everything inside the phase feeds the finish
 * node, the start node feeds everything inside, and a phase-to-phase link becomes an ordinary
 * leaf-level link between two instants. The scheduler needs no knowledge of hierarchy at all.
 *
 * This works without special-casing because the forward pass takes the *maximum* over
 * predecessors: a start boundary acts as a lower bound rather than a forced equality, so a leaf
 * with a later predecessor of its own still starts when its own logic says.
 *
 * The alternative - asking authors to place explicit milestones at phase boundaries - was
 * rejected because a milestone is only correct if every leaf in the phase was wired to it. Add a
 * task six weeks later, forget the wiring, and the milestone fires early with no error. A
 * parent's extent is derived and cannot miss a task.
 */

export const BOUNDARY_START_SUFFIX = '#start'
export const BOUNDARY_FINISH_SUFFIX = '#finish'

export interface ExpandedGraph {
  /** Leaves plus any synthetic boundary nodes. Parents are absent. */
  tasks: Task[]
  /** Links rewritten onto boundary nodes, plus the containment links. */
  links: Link[]
  /** Ids of the synthetic nodes, so results can be stripped of them again. */
  synthetic: Set<string>
  /** Direct children by parent id, in input order. */
  childrenOf: Map<string, string[]>
  /** Parent ids, deepest last, so rollup can run bottom-up. */
  parentsBottomUp: string[]
}

export interface ParentRollup {
  taskId: string
  /** Earliest start among descendants. */
  start: Date
  /** Latest finish among descendants. */
  finish: Date
  /** Working hours spanned, start to finish. Not the sum of its children's durations. */
  duration: Hours
  /** Sum of descendant work. Unlike duration, work does sum cleanly up a hierarchy. */
  effort: WorkUnits
  /** Sum of descendant actual hours. */
  actualHours: WorkUnits
  /**
   * Work-weighted progress. A straight average would let a four-hour snag item count as much as
   * a two-hundred-hour phase, which makes phase-level progress meaningless.
   */
  percentComplete: number
  childIds: string[]
  leafCount: number
}

/** Ids that are named as a parent by at least one task. */
export function parentIds(tasks: readonly Task[]): Set<string> {
  const parents = new Set<string>()
  for (const task of tasks) {
    if (task.parentId !== undefined) parents.add(task.parentId)
  }
  return parents
}

export function expandHierarchy(tasks: readonly Task[], links: readonly Link[]): ExpandedGraph {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const parents = parentIds(tasks)

  const childrenOf = new Map<string, string[]>()
  for (const task of tasks) {
    if (task.parentId === undefined) continue
    const siblings = childrenOf.get(task.parentId)
    if (siblings === undefined) childrenOf.set(task.parentId, [task.id])
    else siblings.push(task.id)
  }

  const leaves = tasks.filter((task) => !parents.has(task.id))

  if (parents.size === 0) {
    return {
      tasks: [...tasks],
      links: [...links],
      synthetic: new Set(),
      childrenOf,
      parentsBottomUp: [],
    }
  }

  // Only parents that actually appear in a link need boundary nodes; the rest are pure rollup.
  const linked = new Set<string>()
  for (const link of links) {
    if (parents.has(link.source)) linked.add(link.source)
    if (parents.has(link.target)) linked.add(link.target)
  }

  const synthetic = new Set<string>()
  const syntheticTasks: Task[] = []
  const expandedLinks: Link[] = []

  const boundaryId = (parentId: string, suffix: string): string => {
    const id = `${parentId}${suffix}`
    if (byId.has(id)) {
      throw new RangeError(
        `Cannot create a boundary node for parent "${parentId}": the id "${id}" is already in use`,
      )
    }
    return id
  }

  for (const parent of linked) {
    const descendants = leafDescendants(parent, childrenOf, parents)
    const anchor = earliestStart(descendants.map((id) => byId.get(id)!)) ?? byId.get(parent)!.start

    const startId = boundaryId(parent, BOUNDARY_START_SUFFIX)
    const finishId = boundaryId(parent, BOUNDARY_FINISH_SUFFIX)
    synthetic.add(startId)
    synthetic.add(finishId)

    // Both are automatic: a start boundary has to follow an incoming phase-to-phase link, which
    // is the entire reason it exists. With no such link it falls back to its anchor and
    // constrains nothing. Schedulers exclude synthetic nodes from the data-date floor
    // separately, so a phase boundary never drags its contents forward.
    syntheticTasks.push(makeBoundary(startId, anchor, 'auto'), makeBoundary(finishId, anchor, 'auto'))

    if (descendants.length === 0) {
      // An empty phase still has an extent: a single instant.
      expandedLinks.push(containment(startId, finishId))
      continue
    }
    for (const leaf of descendants) {
      expandedLinks.push(containment(startId, leaf), containment(leaf, finishId))
    }
  }

  for (const link of links) {
    const sourceIsParent = parents.has(link.source)
    const targetIsParent = parents.has(link.target)
    if (!sourceIsParent && !targetIsParent) {
      expandedLinks.push(link)
      continue
    }
    expandedLinks.push({
      ...link,
      source: sourceIsParent ? `${link.source}${BOUNDARY_FINISH_SUFFIX}` : link.source,
      target: targetIsParent ? `${link.target}${BOUNDARY_START_SUFFIX}` : link.target,
    })
  }

  return {
    tasks: [...leaves, ...syntheticTasks],
    links: expandedLinks,
    synthetic,
    childrenOf,
    parentsBottomUp: orderBottomUp(parents, byId),
  }
}

/**
 * Derive every parent from its descendants, bottom-up so nested phases see settled children.
 *
 * `placement` supplies scheduled dates per leaf; parents computed earlier in the pass become
 * available to their own parents.
 */
export function rollUpParents(
  tasks: readonly Task[],
  placement: ReadonlyMap<string, { start: Date; finish: Date }>,
  calendar: Calendar,
  expanded?: ExpandedGraph,
): Map<string, ParentRollup> {
  const graph = expanded ?? expandHierarchy(tasks, [])
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const rollups = new Map<string, ParentRollup>()

  const extentOf = (id: string): { start: Date; finish: Date } | undefined => {
    const rolled = rollups.get(id)
    if (rolled !== undefined) return { start: rolled.start, finish: rolled.finish }
    return placement.get(id)
  }

  for (const parentId of graph.parentsBottomUp) {
    const childIds = graph.childrenOf.get(parentId) ?? []
    const extents = childIds.map(extentOf).filter((entry) => entry !== undefined)
    if (extents.length === 0) continue

    const start = new Date(Math.min(...extents.map((entry) => entry.start.getTime())))
    const finish = new Date(Math.max(...extents.map((entry) => entry.finish.getTime())))

    let effort = 0
    let actualHours = 0
    let earned = 0
    let leafCount = 0

    for (const childId of childIds) {
      const rolled = rollups.get(childId)
      if (rolled !== undefined) {
        effort += rolled.effort
        actualHours += rolled.actualHours
        earned += (rolled.percentComplete / 100) * rolled.effort
        leafCount += rolled.leafCount
        continue
      }
      const child = byId.get(childId)
      if (child === undefined) continue
      const childEffort = child.effort ?? child.duration * child.resourceCount
      effort += childEffort
      actualHours += child.actualHours ?? 0
      earned += ((child.percentComplete ?? 0) / 100) * childEffort
      leafCount += 1
    }

    rollups.set(parentId, {
      taskId: parentId,
      start,
      finish,
      duration: calendar.workingHoursBetween(start, finish),
      effort,
      actualHours,
      percentComplete: effort > 0 ? (earned / effort) * 100 : 0,
      childIds,
      leafCount,
    })
  }

  return rollups
}

function makeBoundary(id: string, start: Date, mode: 'auto'): Task {
  return {
    id,
    basis: 'duration',
    resourceCount: 1,
    duration: 0,
    start,
    schedulingMode: mode,
  }
}

function containment(source: string, target: string): Link {
  return { id: `${source}=>${target}`, source, target, type: 'FS', lag: 0 }
}

function earliestStart(tasks: readonly Task[]): Date | undefined {
  if (tasks.length === 0) return undefined
  return new Date(Math.min(...tasks.map((task) => task.start.getTime())))
}

/** Every leaf beneath a parent, at any depth. */
function leafDescendants(
  parentId: string,
  childrenOf: ReadonlyMap<string, string[]>,
  parents: ReadonlySet<string>,
): string[] {
  const found: string[] = []
  const walk = (id: string): void => {
    for (const child of childrenOf.get(id) ?? []) {
      if (parents.has(child)) walk(child)
      else found.push(child)
    }
  }
  walk(parentId)
  return found
}

/** Parents ordered so that a parent always follows its own children. */
function orderBottomUp(parents: ReadonlySet<string>, byId: ReadonlyMap<string, Task>): string[] {
  const depthOf = (id: string): number => {
    let depth = 0
    let current = byId.get(id)
    const seen = new Set<string>([id])
    while (current?.parentId !== undefined) {
      if (seen.has(current.parentId)) break // guard against a parent cycle; validate() reports it
      seen.add(current.parentId)
      depth += 1
      current = byId.get(current.parentId)
    }
    return depth
  }
  return [...parents].sort((a, b) => depthOf(b) - depthOf(a))
}
