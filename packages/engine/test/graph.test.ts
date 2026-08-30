import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { topologicalSort, type Edge } from '../src/graph.js'

describe('topologicalSort', () => {
  it('orders a simple chain', () => {
    const result = topologicalSort(['c', 'a', 'b'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ])
    expect(result.order).toEqual(['a', 'b', 'c'])
    expect(result.cycles).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  it('orders a diamond so both middles follow the head and precede the tail', () => {
    const result = topologicalSort(['a', 'b', 'c', 'd'], [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ])
    const position = (id: string): number => result.order.indexOf(id)
    expect(position('a')).toBeLessThan(position('b'))
    expect(position('a')).toBeLessThan(position('c'))
    expect(position('b')).toBeLessThan(position('d'))
    expect(position('c')).toBeLessThan(position('d'))
  })

  it('detects a two-node cycle', () => {
    const result = topologicalSort(['a', 'b'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ])
    expect(result.cycles).toHaveLength(1)
    expect(result.cycles[0]).toEqual(['a', 'b', 'a'])
    expect(result.unresolved.sort()).toEqual(['a', 'b'])
  })

  it('detects a longer cycle and reports it as a closed path', () => {
    const result = topologicalSort(['a', 'b', 'c'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
    ])
    expect(result.cycles).toHaveLength(1)
    const cycle = result.cycles[0]!
    expect(cycle[0]).toBe(cycle[cycle.length - 1])
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('reports a self-loop as a cycle', () => {
    const result = topologicalSort(['a'], [{ from: 'a', to: 'a' }])
    expect(result.cycles).toEqual([['a', 'a']])
  })

  it('reports the same cycle once regardless of which node it is entered from', () => {
    const result = topologicalSort(['a', 'b', 'c'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'b' },
    ])
    expect(result.cycles).toHaveLength(2)
  })

  it('leaves clean tasks orderable when a cycle exists elsewhere', () => {
    const result = topologicalSort(['x', 'a', 'b'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ])
    expect(result.order).toEqual(['x'])
    expect(result.unresolved.sort()).toEqual(['a', 'b'])
  })

  it('treats a task downstream of a cycle as unresolved', () => {
    const result = topologicalSort(['a', 'b', 'z'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'b', to: 'z' },
    ])
    expect(result.unresolved).toContain('z')
  })

  it('ignores edges whose endpoints are not in the id set', () => {
    const result = topologicalSort(['a'], [{ from: 'a', to: 'ghost' }])
    expect(result.order).toEqual(['a'])
    expect(result.cycles).toEqual([])
  })

  it('handles an empty graph', () => {
    expect(topologicalSort([], [])).toEqual({ order: [], unresolved: [], cycles: [] })
  })
})

describe('topologicalSort properties', () => {
  /** Generates a random DAG by only allowing edges from a lower index to a higher one. */
  const anyDag = fc.integer({ min: 1, max: 25 }).chain((count) => {
    const ids = Array.from({ length: count }, (_, index) => `t${index}`)
    const possible: Edge[] = []
    for (let from = 0; from < count; from++) {
      for (let to = from + 1; to < count; to++) {
        possible.push({ from: `t${from}`, to: `t${to}` })
      }
    }
    return fc.record({
      ids: fc.constant(ids),
      edges: possible.length === 0 ? fc.constant([]) : fc.subarray(possible),
    })
  })

  it('orders every task exactly once when the graph is acyclic', () => {
    fc.assert(
      fc.property(anyDag, ({ ids, edges }) => {
        const result = topologicalSort(ids, edges)
        expect(result.order.length).toBe(ids.length)
        expect(new Set(result.order).size).toBe(ids.length)
        expect(result.cycles).toEqual([])
      }),
    )
  })

  it('places every predecessor before its successor', () => {
    fc.assert(
      fc.property(anyDag, ({ ids, edges }) => {
        const result = topologicalSort(ids, edges)
        const position = new Map(result.order.map((id, index) => [id, index]))
        for (const edge of edges) {
          expect(position.get(edge.from)!).toBeLessThan(position.get(edge.to)!)
        }
      }),
    )
  })

  it('always finds a cycle when one is introduced', () => {
    fc.assert(
      fc.property(anyDag, ({ ids, edges }) => {
        fc.pre(ids.length >= 2)
        const last = ids[ids.length - 1]!
        const first = ids[0]!
        const withCycle = [...edges, { from: first, to: last }, { from: last, to: first }]
        const result = topologicalSort(ids, withCycle)
        expect(result.cycles.length).toBeGreaterThan(0)
        expect(result.order.length).toBeLessThan(ids.length)
      }),
    )
  })
})
