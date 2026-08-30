// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContinuousCalendar, WorkingWeekCalendar } from 'gantt-schedule-engine'
import type { Link, Task } from 'gantt-schedule-engine'
import { createGantt } from '../src/gantt.js'

const calendar = new ContinuousCalendar(24)
const BASE = new Date('2026-01-05T00:00:00Z') // a Monday
const h = (hours: number): Date => new Date(BASE.getTime() + hours * 3_600_000)

const task = (id: string, duration: number, overrides: Partial<Task> = {}): Task => ({
  id,
  basis: 'duration',
  resourceCount: 1,
  duration,
  start: BASE,
  schedulingMode: 'auto',
  ...overrides,
})

const link = (source: string, target: string): Link => ({
  id: `${source}->${target}`,
  source,
  target,
  type: 'FS',
  lag: 0,
})

let host: HTMLElement

beforeEach(() => {
  document.body.replaceChildren()
  host = document.createElement('div')
  document.body.append(host)
})

const bars = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.gantt-bar')]
const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.gantt-grid .gantt-row')]
const barFor = (id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`.gantt-bar[data-task-id="${id}"]`)!

describe('rendering', () => {
  it('draws a row and a bar per task', () => {
    createGantt(host, {
      tasks: [task('a', 8, { schedulingMode: 'manual' }), task('b', 4)],
      links: [link('a', 'b')],
      calendar,
    })
    expect(rows()).toHaveLength(2)
    expect(bars()).toHaveLength(2)
  })

  it('places a successor to the right of its predecessor', () => {
    createGantt(host, {
      tasks: [task('a', 24, { schedulingMode: 'manual' }), task('b', 24)],
      links: [link('a', 'b')],
      calendar,
    })
    const left = (id: string): number => parseFloat(barFor(id).style.left)
    expect(left('b')).toBeGreaterThan(left('a'))
  })

  it('marks the critical chain, and stops when asked', () => {
    const options = {
      tasks: [
        task('long', 48, { schedulingMode: 'manual' }),
        task('short', 4, { schedulingMode: 'manual' }),
        task('after', 8),
      ],
      links: [link('long', 'after')],
      calendar,
    }
    const chart = createGantt(host, options)
    expect(barFor('long').dataset['critical']).toBe('true')
    expect(barFor('short').dataset['critical']).toBe('false')

    chart.update({ showCriticalPath: false })
    expect(barFor('long').dataset['critical']).toBe('false')
  })

  it('distinguishes summaries, milestones and ordinary tasks', () => {
    createGantt(host, {
      tasks: [
        task('phase', 0),
        task('work', 8, { parentId: 'phase', schedulingMode: 'manual' }),
        task('done', 0, { parentId: 'phase' }),
      ],
      links: [link('work', 'done')],
      calendar,
    })
    expect(barFor('phase').dataset['kind']).toBe('summary')
    expect(barFor('work').dataset['kind']).toBe('task')
    expect(barFor('done').dataset['kind']).toBe('milestone')
  })

  it('draws a dependency arrow per visible link', () => {
    createGantt(host, {
      tasks: [task('a', 8, { schedulingMode: 'manual' }), task('b', 8), task('c', 8)],
      links: [link('a', 'b'), link('b', 'c')],
      calendar,
    })
    expect(host.querySelectorAll('.gantt-link-path')).toHaveLength(2)
  })

  it('shades non-working days', () => {
    createGantt(host, {
      tasks: [task('a', 40, { schedulingMode: 'manual' })],
      calendar: new WorkingWeekCalendar(),
    })
    // The range spans a working week plus padding, so at least one weekend is shaded.
    expect(host.querySelectorAll('.gantt-nonworking-band').length).toBeGreaterThan(0)
  })

  it('draws no shading on a continuous calendar', () => {
    createGantt(host, { tasks: [task('a', 40, { schedulingMode: 'manual' })], calendar })
    expect(host.querySelectorAll('.gantt-nonworking-band')).toHaveLength(0)
  })

  it('marks the data date', () => {
    createGantt(host, {
      tasks: [task('a', 48, { schedulingMode: 'manual' })],
      calendar,
      statusDate: h(24),
    })
    expect(host.querySelectorAll('.gantt-status-line')).toHaveLength(1)
  })

  it('shows progress on a started task', () => {
    createGantt(host, {
      tasks: [task('a', 8, { schedulingMode: 'manual', percentComplete: 40 })],
      calendar,
    })
    expect(barFor('a').querySelector<HTMLElement>('.gantt-bar-progress')!.style.width).toBe('40%')
  })

  it('uses the supplied label', () => {
    createGantt(host, {
      tasks: [task('a', 8, { schedulingMode: 'manual' })],
      calendar,
      labelOf: () => 'Site mobilisation',
    })
    expect(host.querySelector('.gantt-row-name')!.textContent).toBe('Site mobilisation')
  })

  it('still draws a cyclic schedule instead of failing', () => {
    // A cycle has no schedule at all, but the chart is how the user sees and fixes it.
    expect(() =>
      createGantt(host, {
        tasks: [task('a', 8), task('b', 8)],
        links: [link('a', 'b'), link('b', 'a')],
        calendar,
      }),
    ).not.toThrow()
    expect(bars()).toHaveLength(2)
  })

  it('handles an empty schedule', () => {
    createGantt(host, { tasks: [], calendar })
    expect(bars()).toHaveLength(0)
  })
})

describe('scroll containment', () => {
  const many = {
    tasks: Array.from({ length: 40 }, (_, index) =>
      task(`t${index}`, 8, { schedulingMode: 'manual', start: h(index * 8) }),
    ),
    calendar,
  }

  it('keeps rows in a layer that is translated, not scrolled', () => {
    // Scrolling that layer would clamp at its own content height, which is shorter than the
    // timeline's scroll range, and the two panes would drift apart at the bottom.
    createGantt(host, many)
    const layer = host.querySelector<HTMLElement>('.gantt-grid-rows')!
    expect(layer).not.toBeNull()
    expect(layer.querySelectorAll('.gantt-row').length).toBe(40)
    expect(host.querySelector('.gantt-grid-body > .gantt-row')).toBeNull()
  })

  it('translates the rows to match the timeline scroll', () => {
    createGantt(host, many)
    const timeline = host.querySelector<HTMLElement>('.gantt-timeline')!
    const layer = host.querySelector<HTMLElement>('.gantt-grid-rows')!

    Object.defineProperty(timeline, 'scrollTop', { value: 250, configurable: true })
    timeline.dispatchEvent(new Event('scroll'))
    expect(layer.style.transform).toBe('translateY(-250px)')

    Object.defineProperty(timeline, 'scrollTop', { value: 0, configurable: true })
    timeline.dispatchEvent(new Event('scroll'))
    expect(layer.style.transform).toBe('translateY(0px)')
  })

  it('keeps the drop indicator inside the translated layer', () => {
    // Otherwise it would sit still while the rows it points between move.
    createGantt(host, { ...many, reorderable: true })
    expect(host.querySelector('.gantt-grid-rows > .gantt-drop-line')).not.toBeNull()
  })
})

describe('hierarchy and interaction', () => {
  const nested = {
    tasks: [
      task('phase', 0),
      task('one', 8, { parentId: 'phase', schedulingMode: 'manual' }),
      task('two', 8, { parentId: 'phase' }),
      task('outside', 8, { schedulingMode: 'manual' }),
    ],
    links: [link('one', 'two')],
    calendar,
  }

  it('nests children under their parent', () => {
    createGantt(host, nested)
    const ids = rows().map((row) => row.dataset['taskId'])
    expect(ids).toEqual(['phase', 'one', 'two', 'outside'])
    expect(rows()[1]!.style.paddingLeft).not.toBe(rows()[0]!.style.paddingLeft)
  })

  it('collapses and expands a phase', () => {
    const chart = createGantt(host, nested)
    expect(rows()).toHaveLength(4)

    chart.toggle('phase')
    expect(rows().map((row) => row.dataset['taskId'])).toEqual(['phase', 'outside'])

    chart.toggle('phase')
    expect(rows()).toHaveLength(4)
  })

  it('collapses from the row toggle button', () => {
    createGantt(host, nested)
    host.querySelector<HTMLButtonElement>('.gantt-toggle')!.click()
    expect(rows()).toHaveLength(2)
  })

  it('reports selection', () => {
    const onSelect = vi.fn()
    createGantt(host, { ...nested, onSelect })
    host.querySelector<HTMLElement>('.gantt-row')!.click()
    expect(onSelect).toHaveBeenCalledWith('phase')
    expect(host.querySelector('.gantt-row')!.getAttribute('data-selected')).toBe('true')
  })

  it('removes itself on destroy', () => {
    const chart = createGantt(host, nested)
    expect(host.querySelector('.gantt')).not.toBeNull()
    chart.destroy()
    expect(host.querySelector('.gantt')).toBeNull()
  })
})

describe('dragging', () => {
  const drag = (id: string, byPixels: number): void => {
    const bar = barFor(id)
    const at = (type: string, x: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 0, button: 0 })
    bar.dispatchEvent(at('pointerdown', 0))
    window.dispatchEvent(at('pointermove', byPixels))
    window.dispatchEvent(at('pointerup', byPixels))
  }

  const schedule = {
    tasks: [
      task('a', 24, { schedulingMode: 'manual' }),
      task('b', 24),
      task('c', 24),
    ],
    links: [link('a', 'b'), link('b', 'c')],
    calendar,
  }

  it('proposes the downstream ripple without applying it', () => {
    const onChange = vi.fn()
    const tasks = schedule.tasks
    createGantt(host, { ...schedule, onChange, zoom: 'day' })

    drag('a', 180) // two days at the day zoom

    expect(onChange).toHaveBeenCalledTimes(1)
    const result = onChange.mock.calls[0]![0]
    expect(result.changes.map((change: { taskId: string }) => change.taskId)).toEqual(['b', 'c'])
    // Nothing was applied: the caller's array is untouched.
    expect(tasks[0]!.start.getTime()).toBe(BASE.getTime())
  })

  it('survives a pointer that cannot be captured', () => {
    // jsdom has no real pointer, so setPointerCapture throws. Losing the drag over that would
    // be worse than losing the capture.
    const onChange = vi.fn()
    createGantt(host, { ...schedule, onChange, zoom: 'day' })
    expect(() => drag('a', 90)).not.toThrow()
    expect(onChange).toHaveBeenCalled()
  })

  it('keeps the grabbed bar in the document', () => {
    // Selecting used to re-render, which replaced every bar mid-gesture. The drag then moved an
    // orphaned node while the visible chart sat still, so the chart looked frozen.
    createGantt(host, { ...schedule, zoom: 'day' })
    const bar = barFor('a')
    bar.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 0, button: 0 }),
    )
    expect(document.contains(bar)).toBe(true)
    expect(barFor('a')).toBe(bar)
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 0, button: 0 }))
  })

  it('selects without rebuilding the chart', () => {
    const chart = createGantt(host, { ...schedule, zoom: 'day' })
    const bar = barFor('b')
    chart.select('b')
    expect(barFor('b')).toBe(bar)
    expect(bar.dataset['selected']).toBe('true')
    chart.select('a')
    expect(bar.dataset['selected']).toBe('false')
  })

  it('offsets from where the bar is drawn, not from its stored start', () => {
    // 'b' is auto-scheduled, so the engine draws it after 'a' regardless of the stale date it
    // was authored with. Offsetting from the stored value would teleport it.
    const stale = [
      task('a', 24, { schedulingMode: 'manual' }),
      task('b', 24, { start: new Date(BASE.getTime() - 30 * 86_400_000) }),
    ]
    const onChange = vi.fn()
    createGantt(host, { tasks: stale, links: [link('a', 'b')], calendar, onChange, zoom: 'day' })

    drag('b', 90) // one day at the day zoom

    const proposed = onChange.mock.calls[0]![0].tasks.find((entry: Task) => entry.id === 'b')
    // Drawn at BASE + 24h, so a one-day drag lands two days after BASE - nowhere near the
    // month-old stored date.
    expect(proposed.start.getTime()).toBe(BASE.getTime() + 48 * 3_600_000)
  })

  it('ignores a click that does not move', () => {
    const onChange = vi.fn()
    createGantt(host, { ...schedule, onChange, zoom: 'day' })
    drag('a', 0)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not make summary bars draggable', () => {
    const onChange = vi.fn()
    createGantt(host, {
      tasks: [task('phase', 0), task('kid', 8, { parentId: 'phase', schedulingMode: 'manual' })],
      calendar,
      onChange,
      zoom: 'day',
    })
    drag('phase', 90)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('zoom', () => {
  it('widens the timeline as the zoom tightens', () => {
    const chart = createGantt(host, {
      tasks: [task('a', 240, { schedulingMode: 'manual' })],
      calendar,
      zoom: 'month',
    })
    const widthAt = (): number => parseFloat(host.querySelector<HTMLElement>('.gantt-body')!.style.width)

    const month = widthAt()
    chart.setZoom('week')
    const week = widthAt()
    chart.setZoom('day')
    const day = widthAt()

    expect(week).toBeGreaterThan(month)
    expect(day).toBeGreaterThan(week)
  })

  it('labels the header at every zoom', () => {
    const chart = createGantt(host, {
      tasks: [task('a', 240, { schedulingMode: 'manual' })],
      calendar,
    })
    for (const zoom of ['day', 'week', 'month'] as const) {
      chart.setZoom(zoom)
      expect(host.querySelectorAll('.gantt-tick').length).toBeGreaterThan(0)
    }
  })
})

describe('link editing', () => {
  const base = {
    tasks: [
      task('a', 24, { schedulingMode: 'manual' }),
      task('b', 24),
      task('c', 24),
    ],
    links: [link('a', 'b')],
    calendar,
    editableLinks: true as const,
  }

  /**
   * jsdom has no layout, so `elementFromPoint` always returns null and a link drag could never
   * find its target. Point it at a chosen bar for the duration of the gesture.
   */
  const dragHandleOnto = (from: string, to: string, side: 'start' | 'end' = 'end'): void => {
    const handle = barFor(from).querySelector<HTMLElement>(`.gantt-handle-${side}`)!
    const target = barFor(to)
    const original = document.elementFromPoint
    document.elementFromPoint = () => target
    try {
      const at = (type: string): PointerEvent =>
        new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0 })
      handle.dispatchEvent(at('pointerdown'))
      window.dispatchEvent(at('pointermove'))
      window.dispatchEvent(at('pointerup'))
    } finally {
      document.elementFromPoint = original
    }
  }

  it('offers a handle at each end of a bar, and none on a summary', () => {
    createGantt(host, {
      tasks: [task('phase', 0), task('kid', 8, { parentId: 'phase', schedulingMode: 'manual' })],
      calendar,
      editableLinks: true,
    })
    expect(barFor('kid').querySelectorAll('.gantt-handle')).toHaveLength(2)
    expect(barFor('phase').querySelectorAll('.gantt-handle')).toHaveLength(0)
  })

  it('draws no handles when editing is off', () => {
    createGantt(host, { ...base, editableLinks: false })
    expect(host.querySelectorAll('.gantt-handle')).toHaveLength(0)
  })

  it('creates a dependency by dragging from a finish handle', () => {
    const onLinksChange = vi.fn()
    createGantt(host, { ...base, onLinksChange })

    dragHandleOnto('b', 'c')

    expect(onLinksChange).toHaveBeenCalledTimes(1)
    const change = onLinksChange.mock.calls[0]![0]
    expect(change.added).toMatchObject({ source: 'b', target: 'c', type: 'FS', lag: 0 })
    expect(change.links).toHaveLength(2)
    // The new dependency moves 'c', and the proposal says so.
    expect(change.schedule.changes.map((entry: { taskId: string }) => entry.taskId)).toContain('c')
  })

  it('reverses the direction when dragged from a start handle', () => {
    const onLinksChange = vi.fn()
    createGantt(host, { ...base, onLinksChange })

    // Grabbing c's start handle and dropping on b means "c depends on b".
    dragHandleOnto('c', 'b', 'start')

    expect(onLinksChange.mock.calls[0]![0].added).toMatchObject({ source: 'b', target: 'c' })
  })

  it('refuses a link that would close a cycle', () => {
    const onLinksChange = vi.fn()
    const onLinkRejected = vi.fn()
    createGantt(host, { ...base, onLinksChange, onLinkRejected })

    dragHandleOnto('b', 'a') // a already precedes b

    expect(onLinkRejected).toHaveBeenCalledWith({ reason: 'cycle', source: 'b', target: 'a' })
    expect(onLinksChange).not.toHaveBeenCalled()
  })

  it('refuses a duplicate', () => {
    const onLinkRejected = vi.fn()
    createGantt(host, { ...base, onLinkRejected })
    dragHandleOnto('a', 'b')
    expect(onLinkRejected).toHaveBeenCalledWith({ reason: 'duplicate', source: 'a', target: 'b' })
  })

  it('refuses a task depending on itself', () => {
    const onLinkRejected = vi.fn()
    createGantt(host, { ...base, onLinkRejected })
    dragHandleOnto('a', 'a')
    expect(onLinkRejected).toHaveBeenCalledWith({ reason: 'self', source: 'a', target: 'a' })
  })

  it('cleans up the rubber band and the target highlight', () => {
    createGantt(host, base)
    dragHandleOnto('b', 'c')
    expect(host.querySelectorAll('.gantt-rubber')).toHaveLength(0)
    expect(host.querySelectorAll('.gantt-bar[data-link-target="true"]')).toHaveLength(0)
    expect(host.querySelector('.gantt')?.getAttribute('data-linking')).toBeNull()
  })

  it('selects a dependency from its arrow and removes it with Delete', () => {
    const onLinksChange = vi.fn()
    createGantt(host, { ...base, onLinksChange })

    const group = host.querySelector<SVGGElement>('.gantt-link-group')!
    group.querySelector('.gantt-link-hit')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(group.dataset['selected']).toBe('true')

    host
      .querySelector('.gantt')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))

    expect(onLinksChange).toHaveBeenCalledTimes(1)
    const change = onLinksChange.mock.calls[0]![0]
    expect(change.removed).toMatchObject({ source: 'a', target: 'b' })
    expect(change.links).toHaveLength(0)
  })

  it('removes a dependency from the right-click menu', () => {
    const onLinksChange = vi.fn()
    createGantt(host, { ...base, onLinksChange })

    const hit = host.querySelector('.gantt-link-hit')!
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    hit.dispatchEvent(event)

    // The browser's own menu must not also appear.
    expect(event.defaultPrevented).toBe(true)

    const menu = host.querySelector<HTMLElement>('.gantt-menu')!
    expect(menu.hidden).toBe(false)
    expect(menu.textContent).toContain('Remove dependency')

    menu.querySelector<HTMLButtonElement>('.gantt-menu-item')!.click()
    expect(onLinksChange.mock.calls[0]![0].removed).toMatchObject({ source: 'a', target: 'b' })
    expect(menu.hidden).toBe(true)
  })

  it('closes the menu on Escape and on an outside click', () => {
    createGantt(host, base)
    const hit = host.querySelector('.gantt-link-hit')!
    const menu = host.querySelector<HTMLElement>('.gantt-menu')!

    hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    expect(menu.hidden).toBe(false)
    host
      .querySelector('.gantt')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(menu.hidden).toBe(true)

    hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    expect(menu.hidden).toBe(false)
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(menu.hidden).toBe(true)
  })

  it('offers no menu when editing is off', () => {
    createGantt(host, { ...base, editableLinks: false })
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    host.querySelector('.gantt-link-hit')!.dispatchEvent(event)
    expect(host.querySelector<HTMLElement>('.gantt-menu')!.hidden).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })

  it('carries a remove button on every arrow, revealed only on the selected one', () => {
    // Built for all links and shown by CSS, because selection deliberately does not re-render.
    const chart = createGantt(host, { ...base, links: [link('a', 'b'), link('b', 'c')] })
    expect(host.querySelectorAll('.gantt-link-remove')).toHaveLength(2)

    chart.selectLink('a->b')
    const selectedGroups = host.querySelectorAll('.gantt-link-group[data-selected="true"]')
    expect(selectedGroups).toHaveLength(1)
    expect(selectedGroups[0]!.querySelector('.gantt-link-remove')).not.toBeNull()
  })

  it('removes a dependency from the button on the arrow', () => {
    const onLinksChange = vi.fn()
    const chart = createGantt(host, { ...base, onLinksChange })
    chart.selectLink('a->b')
    host
      .querySelector<SVGGElement>('.gantt-link-remove')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onLinksChange.mock.calls[0]![0].removed).toMatchObject({ source: 'a', target: 'b' })
  })

  it('removes a dependency through the API', () => {
    const onLinksChange = vi.fn()
    const chart = createGantt(host, { ...base, onLinksChange })
    chart.removeLink('a->b')
    expect(onLinksChange.mock.calls[0]![0].links).toEqual([])
  })

  it('ignores Delete when nothing is selected', () => {
    const onLinksChange = vi.fn()
    createGantt(host, { ...base, onLinksChange })
    host
      .querySelector('.gantt')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(onLinksChange).not.toHaveBeenCalled()
  })

  it('does not delete links when editing is off', () => {
    const onLinksChange = vi.fn()
    const chart = createGantt(host, { ...base, editableLinks: false, onLinksChange })
    chart.selectLink('a->b')
    host
      .querySelector('.gantt')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(onLinksChange).not.toHaveBeenCalled()
  })

  it('selecting a task clears any selected dependency', () => {
    const chart = createGantt(host, base)
    chart.selectLink('a->b')
    expect(host.querySelector('.gantt-link-group')!.getAttribute('data-selected')).toBe('true')
    chart.select('a')
    expect(host.querySelector('.gantt-link-group')!.getAttribute('data-selected')).toBe('false')
  })
})

describe('reordering and reparenting', () => {
  const outline = () => ({
    tasks: [
      task('phase1', 0),
      task('a', 8, { parentId: 'phase1', schedulingMode: 'manual' }),
      task('b', 8, { parentId: 'phase1' }),
      task('phase2', 0),
      task('c', 8, { parentId: 'phase2' }),
    ],
    links: [link('a', 'b'), link('b', 'c')],
    calendar,
    reorderable: true as const,
  })

  const ids = (tasks: readonly Task[]): string[] => tasks.map((entry) => entry.id)
  const parentOf = (tasks: readonly Task[], id: string): string | undefined =>
    tasks.find((entry) => entry.id === id)?.parentId

  it('reorders within a parent without touching dependencies', () => {
    const onReorder = vi.fn()
    const chart = createGantt(host, { ...outline(), onReorder })

    chart.moveTask('b', { before: 'a' })

    const change = onReorder.mock.calls[0]![0]
    expect(ids(change.tasks)).toEqual(['phase1', 'b', 'a', 'phase2', 'c'])
    expect(parentOf(change.tasks, 'b')).toBe('phase1')
    // Order is presentation. Nothing about the logic changed, so nothing was cut.
    expect(change.removedLinks).toEqual([])
    expect(change.links).toHaveLength(2)
  })

  it('moves a task into another parent', () => {
    const onReorder = vi.fn()
    const chart = createGantt(host, { ...outline(), onReorder })

    chart.moveTask('b', { intoParent: 'phase2' })

    const change = onReorder.mock.calls[0]![0]
    expect(parentOf(change.tasks, 'b')).toBe('phase2')
    expect(change.fromParentId).toBe('phase1')
    expect(change.toParentId).toBe('phase2')
  })

  it('drops the dependencies a reparent invalidates', () => {
    const onReorder = vi.fn()
    const chart = createGantt(host, { ...outline(), onReorder })

    chart.moveTask('b', { intoParent: 'phase2' })

    // Both of b's links crossed out of its subtree, so both go.
    const change = onReorder.mock.calls[0]![0]
    expect(change.removedLinks.map((entry: Link) => entry.id).sort()).toEqual(['a->b', 'b->c'])
    expect(change.links).toEqual([])
  })

  it('keeps dependencies when asked to', () => {
    const onReorder = vi.fn()
    const chart = createGantt(host, {
      ...outline(),
      breakLinksOnReparent: false,
      onReorder,
    })
    chart.moveTask('b', { intoParent: 'phase2' })
    expect(onReorder.mock.calls[0]![0].removedLinks).toEqual([])
    expect(onReorder.mock.calls[0]![0].links).toHaveLength(2)
  })

  it('carries a whole subtree, and keeps the links inside it', () => {
    const onReorder = vi.fn()
    const chart = createGantt(host, {
      tasks: [
        task('root', 0),
        task('branch', 0, { parentId: 'root' }),
        task('leaf1', 8, { parentId: 'branch', schedulingMode: 'manual' }),
        task('leaf2', 8, { parentId: 'branch' }),
        task('elsewhere', 0),
        task('other', 8, { parentId: 'elsewhere', schedulingMode: 'manual' }),
      ],
      // One link inside the subtree, one crossing out of it.
      links: [link('leaf1', 'leaf2'), link('other', 'leaf1')],
      calendar,
      reorderable: true,
      onReorder,
    })

    chart.moveTask('branch', { intoParent: 'elsewhere' })

    const change = onReorder.mock.calls[0]![0]
    expect(parentOf(change.tasks, 'branch')).toBe('elsewhere')
    // The children came along and kept their own parent.
    expect(parentOf(change.tasks, 'leaf1')).toBe('branch')
    expect(parentOf(change.tasks, 'leaf2')).toBe('branch')
    // The internal link survived; only the crossing one was cut.
    expect(change.removedLinks.map((entry: Link) => entry.id)).toEqual(['other->leaf1'])
    expect(change.links.map((entry: Link) => entry.id)).toEqual(['leaf1->leaf2'])
  })

  it('refuses to move a task inside itself', () => {
    const onReorder = vi.fn()
    const chart = createGantt(host, { ...outline(), onReorder })
    chart.moveTask('phase1', { intoParent: 'phase1' })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('refuses to move a parent into its own child', () => {
    const onReorder = vi.fn()
    const chart = createGantt(host, { ...outline(), onReorder })
    chart.moveTask('phase1', { intoParent: 'a' })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('moves a task out to the top level', () => {
    const onReorder = vi.fn()
    const chart = createGantt(host, { ...outline(), onReorder })
    chart.moveTask('b', { intoParent: null })
    expect(parentOf(onReorder.mock.calls[0]![0].tasks, 'b')).toBeUndefined()
  })

  it('reports the schedule the move implies', () => {
    const onReorder = vi.fn()
    const chart = createGantt(host, { ...outline(), onReorder })
    chart.moveTask('b', { intoParent: 'phase2' })
    // Cutting a->b frees b to start at the project start rather than after a.
    expect(onReorder.mock.calls[0]![0].schedule).toBeDefined()
    expect(Array.isArray(onReorder.mock.calls[0]![0].schedule.changes)).toBe(true)
  })

  it('drags a row onto a phase to reparent it', () => {
    // jsdom has no layout, so rows report zero-height boxes. Give them real ones.
    const onReorder = vi.fn()
    createGantt(host, { ...outline(), onReorder })

    const lines = [...host.querySelectorAll<HTMLElement>('.gantt-grid .gantt-row')]
    lines.forEach((line, index) => {
      line.getBoundingClientRect = () =>
        ({ top: index * 30, bottom: index * 30 + 30, height: 30, left: 0, right: 200, width: 200, x: 0, y: index * 30, toJSON: () => ({}) }) as DOMRect
    })

    const source = lines.find((line) => line.dataset['taskId'] === 'b')!
    const phase2Index = lines.findIndex((line) => line.dataset['taskId'] === 'phase2')

    const at = (type: string, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: y, button: 0 })

    source.dispatchEvent(at('pointerdown', 2 * 30 + 15))
    window.dispatchEvent(at('pointermove', phase2Index * 30 + 15)) // middle third: nest
    expect(host.querySelectorAll('.gantt-row[data-drop-into="true"]')).toHaveLength(1)
    window.dispatchEvent(at('pointerup', phase2Index * 30 + 15))

    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder.mock.calls[0]![0].toParentId).toBe('phase2')
    expect(host.querySelector<HTMLElement>('.gantt-drop-line')!.hidden).toBe(true)
  })

  it('signals that rows are draggable', () => {
    // Without a grip and a grab cursor, a draggable row is indistinguishable from a static one.
    createGantt(host, outline())
    expect(host.querySelector('.gantt')!.getAttribute('data-reorderable')).toBe('true')
    expect(host.querySelectorAll('.gantt-grip').length).toBeGreaterThan(0)
  })

  it('shows no grip when reordering is off', () => {
    createGantt(host, { ...outline(), reorderable: false })
    expect(host.querySelector('.gantt')!.getAttribute('data-reorderable')).toBe('false')
    expect(host.querySelectorAll('.gantt-grip')).toHaveLength(0)
  })

  it('suppresses the native text selection once a drag starts', () => {
    // A real mouse drag over a row otherwise selects the text, which swamps the gesture.
    createGantt(host, outline())
    const lines = [...host.querySelectorAll<HTMLElement>('.gantt-grid .gantt-row')]
    lines.forEach((line, index) => {
      line.getBoundingClientRect = () =>
        ({ top: index * 30, bottom: index * 30 + 30, height: 30, left: 0, right: 200, width: 200, x: 0, y: index * 30, toJSON: () => ({}) }) as DOMRect
    })

    const at = (type: string, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: y, button: 0 })

    lines[1]!.dispatchEvent(at('pointerdown', 45))
    const move = at('pointermove', 120)
    window.dispatchEvent(move)
    expect(move.defaultPrevented).toBe(true)
    window.dispatchEvent(at('pointerup', 120))
  })

  it('treats a click without movement as selection, not a move', () => {
    const onReorder = vi.fn()
    createGantt(host, { ...outline(), onReorder })
    const line = host.querySelector<HTMLElement>('.gantt-grid .gantt-row')!
    const at = (type: string): PointerEvent =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 10, button: 0 })
    line.dispatchEvent(at('pointerdown'))
    window.dispatchEvent(at('pointerup'))
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('does not drag rows when reordering is off', () => {
    const onReorder = vi.fn()
    createGantt(host, { ...outline(), reorderable: false, onReorder })
    const line = host.querySelector<HTMLElement>('.gantt-grid .gantt-row')!
    const at = (type: string, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: y, button: 0 })
    line.dispatchEvent(at('pointerdown', 10))
    window.dispatchEvent(at('pointermove', 200))
    window.dispatchEvent(at('pointerup', 200))
    expect(onReorder).not.toHaveBeenCalled()
  })
})
