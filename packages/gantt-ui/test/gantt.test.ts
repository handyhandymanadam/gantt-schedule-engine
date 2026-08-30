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
