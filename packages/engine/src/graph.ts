/**
 * Graph utilities shared by validation and the critical-path pass.
 *
 * Cycle detection is not a separate feature bolted on. The forward pass *is* a topological
 * traversal, so Kahn's algorithm yields both the ordering CPM needs and the cycle report for
 * free. A cyclic graph has no schedule at all, so this is an error path, not a warning.
 */

export interface Edge {
  from: string
  to: string
}

export interface TopologicalResult {
  /** Ids in dependency order. Excludes anything caught in, or downstream of, a cycle. */
  order: string[]
  /** Ids that could not be ordered: members of a cycle, or reachable only through one. */
  unresolved: string[]
  /** Concrete cycles, one representative path each. Every path ends where it began. */
  cycles: string[][]
}

/**
 * Kahn's algorithm. Edge endpoints absent from `ids` are ignored here; report unknown endpoints
 * separately in validation if they should be an error.
 */
export function topologicalSort(ids: readonly string[], edges: readonly Edge[]): TopologicalResult {
  const present = new Set(ids)
  const successors = new Map<string, string[]>()
  const inDegree = new Map<string, number>()

  for (const id of ids) {
    successors.set(id, [])
    inDegree.set(id, 0)
  }

  for (const edge of edges) {
    if (!present.has(edge.from) || !present.has(edge.to)) continue
    successors.get(edge.from)!.push(edge.to)
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }

  const queue: string[] = []
  for (const id of ids) {
    if ((inDegree.get(id) ?? 0) === 0) queue.push(id)
  }

  const order: string[] = []
  let cursor = 0
  while (cursor < queue.length) {
    const id = queue[cursor]!
    cursor += 1
    order.push(id)
    for (const next of successors.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }

  if (order.length === ids.length) {
    return { order, unresolved: [], cycles: [] }
  }

  const ordered = new Set(order)
  const unresolved = ids.filter((id) => !ordered.has(id))
  return { order, unresolved, cycles: findCycles(unresolved, successors) }
}

/**
 * Depth-first search over the unresolved subgraph, collecting one representative path per cycle.
 *
 * Deliberately not an exhaustive enumeration of elementary cycles, which is exponential; one
 * concrete example per cycle is what an error message actually needs.
 *
 * Iterative rather than recursive. A recursive walk is shorter to read, but its depth is the
 * length of the chain, and a library that throws RangeError on a large cyclic graph has replaced
 * a clear diagnostic with an obscure crash - in the exact case where the user most needs telling
 * what is wrong.
 */
function findCycles(unresolved: readonly string[], successors: Map<string, string[]>): string[][] {
  const candidates = new Set(unresolved)
  const state = new Map<string, 'visiting' | 'done'>()
  const cycles: string[][] = []
  const seen = new Set<string>()

  interface Frame {
    id: string
    next: number
  }

  for (const root of unresolved) {
    if (state.get(root) !== undefined) continue

    const stack: Frame[] = [{ id: root, next: 0 }]
    const path: string[] = [root]
    const onPath = new Set<string>([root])
    state.set(root, 'visiting')

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const children = successors.get(frame.id) ?? []

      if (frame.next >= children.length) {
        state.set(frame.id, 'done')
        onPath.delete(frame.id)
        path.pop()
        stack.pop()
        continue
      }

      const child = children[frame.next]!
      frame.next += 1
      if (!candidates.has(child)) continue

      if (onPath.has(child)) {
        const at = path.indexOf(child)
        if (at !== -1) {
          const cycle = [...path.slice(at), child]
          const key = canonicalKey(cycle)
          if (!seen.has(key)) {
            seen.add(key)
            cycles.push(cycle)
          }
        }
        continue
      }

      if (state.get(child) === undefined) {
        state.set(child, 'visiting')
        onPath.add(child)
        path.push(child)
        stack.push({ id: child, next: 0 })
      }
    }
  }

  return cycles
}

/** Rotation-independent key, so that A-B-A and B-A-B are recognised as the same cycle. */
function canonicalKey(cycle: string[]): string {
  const nodes = cycle.slice(0, -1)
  if (nodes.length === 0) return ''
  let lowest = 0
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i]! < nodes[lowest]!) lowest = i
  }
  return [...nodes.slice(lowest), ...nodes.slice(0, lowest)].join(' ')
}
