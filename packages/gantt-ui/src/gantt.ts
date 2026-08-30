import {
  autoSchedule,
  calculateCriticalPath,
  continuousCalendar,
  parentIds,
  placeFinish,
  placeStart,
  type AutoScheduleResult,
  type Calendar,
  type Link,
  type ParentRollup,
  type Task,
} from 'gantt-schedule-engine'

/**
 * A Gantt chart over the scheduling engine.
 *
 * Vanilla DOM with no framework and no dependencies, styled entirely through custom properties so
 * a consuming application themes it by redefining tokens rather than fighting selectors.
 *
 * The renderer computes nothing itself. Dates, the critical path, and phase extents all come from
 * the engine, and dragging a bar produces an engine *proposal* rather than a mutation: the chart
 * shows the ripple and hands it to `onChange`, and the application decides whether it happens.
 * That is the same contract the engine keeps, carried up to the UI.
 */

export type Zoom = 'day' | 'week' | 'month'

export interface GanttOptions {
  tasks: readonly Task[]
  links?: readonly Link[]
  calendar?: Calendar
  /** Draws the data-date marker, and is passed to the engine when a drag reschedules. */
  statusDate?: Date
  zoom?: Zoom
  /** Highlight the zero-slack chain. On by default: it is the reason to have a Gantt at all. */
  showCriticalPath?: boolean
  /** Display name per task id. Falls back to the id. */
  labelOf?: (task: Task) => string
  /**
   * Called after a drag with the engine's proposed changes. Nothing has been applied - to accept,
   * persist `result.tasks` and pass them back in through `update`.
   */
  onChange?: (result: AutoScheduleResult) => void
  onSelect?: (taskId: string | null) => void
}

export interface GanttInstance {
  update(options: Partial<GanttOptions>): void
  setZoom(zoom: Zoom): void
  toggle(taskId: string): void
  select(taskId: string | null): void
  destroy(): void
  /** Exposed for tests and for applications that want the computed schedule. */
  readonly element: HTMLElement
}

const MS_PER_DAY = 86_400_000

const PIXELS_PER_DAY: Record<Zoom, number> = { day: 90, week: 26, month: 7 }

interface Row {
  task: Task
  depth: number
  hasChildren: boolean
  isParent: boolean
}

interface Extent {
  start: Date
  finish: Date
}

export function createGantt(container: HTMLElement, options: GanttOptions): GanttInstance {
  let opts: GanttOptions = { showCriticalPath: true, zoom: 'week', ...options }
  const collapsed = new Set<string>()
  let selected: string | null = null

  const root = document.createElement('div')
  root.className = 'gantt'

  const grid = element('div', 'gantt-grid')
  const gridHeader = element('div', 'gantt-grid-header')
  gridHeader.textContent = 'Task'
  const gridBody = element('div', 'gantt-grid-body')
  grid.append(gridHeader, gridBody)

  const timeline = element('div', 'gantt-timeline')
  const timelineHeader = element('div', 'gantt-timeline-header')
  const body = element('div', 'gantt-body')
  timeline.append(timelineHeader, body)

  root.append(grid, timeline)
  container.append(root)

  // The grid scrolls only as a consequence of the timeline scrolling; it has no scrollbar of
  // its own, so the two can never drift apart.
  const syncScroll = (): void => {
    gridBody.scrollTop = timeline.scrollTop
  }
  timeline.addEventListener('scroll', syncScroll)

  let disposeDrag: (() => void) | null = null

  function render(): void {
    const tasks = opts.tasks
    const links = opts.links ?? []
    const calendar = opts.calendar ?? continuousCalendar

    const parents = parentIds(tasks)
    const rows = buildRows(tasks, parents, collapsed)

    // Everything positional comes from the engine, not from the renderer.
    const cpm = safeCriticalPath({ tasks, links, calendar })
    const extents = new Map<string, Extent>()
    for (const entry of cpm?.tasks ?? []) {
      extents.set(entry.taskId, { start: entry.earlyStart, finish: entry.earlyFinish })
    }
    for (const parent of cpm?.parents ?? []) {
      extents.set(parent.taskId, { start: parent.start, finish: parent.finish })
    }
    // Without a computable schedule (a cyclic graph, say) fall back to stored dates so the chart
    // still draws something the user can look at and fix.
    for (const task of tasks) {
      if (extents.has(task.id)) continue
      const start = placeStart(task.start, task.duration, calendar)
      extents.set(task.id, { start, finish: placeFinish(start, task.duration, calendar) })
    }

    const critical = new Set(cpm?.criticalPath ?? [])
    const range = timeRange([...extents.values()])
    const pxPerDay = PIXELS_PER_DAY[opts.zoom ?? 'week']
    const width = Math.max(240, ((range.to - range.from) / MS_PER_DAY) * pxPerDay)
    const rowHeight = readRowHeight(root)

    renderGrid(rows)
    renderHeader(range, pxPerDay, width, opts.zoom ?? 'week')
    renderBody({
      rows,
      extents,
      critical,
      links,
      calendar,
      range,
      pxPerDay,
      width,
      rowHeight,
      parentRollups: cpm?.parents ?? [],
    })
  }

  function renderGrid(rows: readonly Row[]): void {
    gridBody.replaceChildren()
    for (const row of rows) {
      const line = element('div', 'gantt-row')
      line.dataset['taskId'] = row.task.id
      line.dataset['parent'] = String(row.isParent)
      line.dataset['selected'] = String(selected === row.task.id)
      line.style.paddingLeft = `${8 + row.depth * 14}px`

      if (row.hasChildren) {
        const toggle = element('button', 'gantt-toggle')
        toggle.type = 'button'
        toggle.textContent = collapsed.has(row.task.id) ? '▸' : '▾'
        toggle.setAttribute('aria-expanded', String(!collapsed.has(row.task.id)))
        toggle.addEventListener('click', (event) => {
          event.stopPropagation()
          instance.toggle(row.task.id)
        })
        line.append(toggle)
      } else {
        line.append(element('span', 'gantt-toggle-spacer'))
      }

      const name = element('span', 'gantt-row-name')
      name.textContent = labelFor(row.task)
      line.append(name)

      if (!row.isParent) {
        const meta = element('span', 'gantt-row-meta')
        meta.textContent = row.task.duration === 0 ? '◆' : `${trim(row.task.duration)}h`
        line.append(meta)
      }

      line.addEventListener('click', () => instance.select(row.task.id))
      gridBody.append(line)
    }
  }

  function renderHeader(
    range: { from: number; to: number },
    pxPerDay: number,
    width: number,
    zoom: Zoom,
  ): void {
    timelineHeader.replaceChildren()
    timelineHeader.style.width = `${width}px`

    const major = element('div', 'gantt-tier gantt-tier-major')
    const minor = element('div', 'gantt-tier')

    for (const tick of majorTicks(range, zoom)) {
      major.append(tickElement(tick, range, pxPerDay))
    }
    for (const tick of minorTicks(range, zoom)) {
      minor.append(tickElement(tick, range, pxPerDay))
    }

    timelineHeader.append(major, minor)
  }

  function renderBody(input: {
    rows: readonly Row[]
    extents: Map<string, Extent>
    critical: Set<string>
    links: readonly Link[]
    calendar: Calendar
    range: { from: number; to: number }
    pxPerDay: number
    width: number
    rowHeight: number
    parentRollups: readonly ParentRollup[]
  }): void {
    const { rows, extents, critical, links, calendar, range, pxPerDay, width, rowHeight } = input

    body.replaceChildren()
    body.style.width = `${width}px`
    body.style.height = `${rows.length * rowHeight}px`

    const xOf = (date: Date): number => ((date.getTime() - range.from) / MS_PER_DAY) * pxPerDay

    // Non-working days, shaded so a bar spanning a weekend visibly does so.
    for (let day = range.from; day < range.to; day += MS_PER_DAY) {
      const dayEnd = new Date(day + MS_PER_DAY)
      if (calendar.workingHoursBetween(new Date(day), dayEnd) > 0) continue
      const band = element('div', 'gantt-nonworking-band')
      band.style.left = `${((day - range.from) / MS_PER_DAY) * pxPerDay}px`
      band.style.width = `${pxPerDay}px`
      body.append(band)
    }

    for (const tick of minorTicks(range, opts.zoom ?? 'week')) {
      const line = element('div', 'gantt-gridline')
      line.style.left = `${((tick.at - range.from) / MS_PER_DAY) * pxPerDay}px`
      body.append(line)
    }

    for (let index = 1; index < rows.length; index++) {
      const line = element('div', 'gantt-rowline')
      line.style.top = `${index * rowHeight}px`
      body.append(line)
    }

    const rowIndex = new Map(rows.map((row, index) => [row.task.id, index]))

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'gantt-links')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(rows.length * rowHeight))
    body.append(svg)

    for (const row of rows) {
      const extent = extents.get(row.task.id)
      if (extent === undefined) continue
      const index = rowIndex.get(row.task.id)!
      body.append(
        barElement({
          row,
          extent,
          index,
          rowHeight,
          xOf,
          isCritical: (opts.showCriticalPath ?? true) && critical.has(row.task.id),
        }),
      )
    }

    // Arrows are drawn only between rows that are both visible; a link into a collapsed phase
    // has nothing to point at.
    for (const link of links) {
      const from = rowIndex.get(link.source)
      const to = rowIndex.get(link.target)
      if (from === undefined || to === undefined) continue
      const source = extents.get(link.source)
      const target = extents.get(link.target)
      if (source === undefined || target === undefined) continue
      svg.append(...arrow(xOf(source.finish), from, xOf(target.start), to, rowHeight))
    }

    if (opts.statusDate !== undefined) {
      const marker = element('div', 'gantt-status-line')
      marker.style.left = `${xOf(opts.statusDate)}px`
      marker.title = 'Data date'
      body.append(marker)
    }
  }

  function barElement(input: {
    row: Row
    extent: Extent
    index: number
    rowHeight: number
    xOf: (date: Date) => number
    isCritical: boolean
  }): HTMLElement {
    const { row, extent, index, rowHeight, xOf, isCritical } = input
    const bar = element('div', 'gantt-bar')

    const kind = row.isParent ? 'summary' : row.task.duration === 0 ? 'milestone' : 'task'
    bar.dataset['kind'] = kind
    bar.dataset['taskId'] = row.task.id
    bar.dataset['critical'] = String(isCritical)
    bar.dataset['selected'] = String(selected === row.task.id)

    const left = xOf(extent.start)
    const barHeight = readBarHeight(root)
    const top = index * rowHeight + (rowHeight - (kind === 'summary' ? 8 : barHeight)) / 2

    if (kind === 'milestone') {
      bar.style.left = `${left - barHeight / 2}px`
      bar.style.top = `${top}px`
    } else {
      bar.style.left = `${left}px`
      bar.style.width = `${Math.max(2, xOf(extent.finish) - left)}px`
      bar.style.top = `${top}px`
    }

    const percent = row.task.percentComplete ?? 0
    if (kind === 'task' && percent > 0) {
      const progress = element('div', 'gantt-bar-progress')
      progress.style.width = `${Math.min(100, percent)}%`
      bar.append(progress)
    }

    const label = element('span', 'gantt-bar-label')
    label.textContent = labelFor(row.task)
    bar.append(label)

    bar.title = `${labelFor(row.task)}\n${formatDate(extent.start)} to ${formatDate(extent.finish)}`

    if (kind !== 'summary') attachDrag(bar, row.task)
    return bar
  }

  /**
   * Dragging edits the task's start and asks the engine what that implies. Nothing is applied:
   * the proposal goes to `onChange`, so the application can show "this moves six downstream
   * tasks" and let a human decide, exactly as the engine intends.
   */
  function attachDrag(bar: HTMLElement, task: Task): void {
    bar.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      instance.select(task.id)

      const pxPerDay = PIXELS_PER_DAY[opts.zoom ?? 'week']
      const originX = event.clientX
      const originLeft = parseFloat(bar.style.left || '0')
      bar.dataset['dragging'] = 'true'

      // Capture keeps a fast drag attached to the bar, but it is a nicety: it throws for a
      // synthetic pointer, and losing the drag entirely because of that would be far worse than
      // losing the capture. Movement is tracked on the window regardless.
      try {
        bar.setPointerCapture(event.pointerId)
      } catch {
        /* not capturable; window listeners below still track the drag */
      }

      const onMove = (move: PointerEvent): void => {
        bar.style.left = `${originLeft + (move.clientX - originX)}px`
      }

      const onUp = (up: PointerEvent): void => {
        cleanup()
        const deltaDays = (up.clientX - originX) / pxPerDay
        if (Math.abs(deltaDays) < 0.01) {
          render()
          return
        }

        const moved: Task = {
          ...task,
          start: new Date(task.start.getTime() + deltaDays * MS_PER_DAY),
          // A dragged task is being placed by hand, so it becomes an anchor.
          schedulingMode: 'manual',
        }
        const next = opts.tasks.map((candidate) => (candidate.id === task.id ? moved : candidate))

        const result = autoSchedule({
          tasks: next,
          links: opts.links ?? [],
          calendar: opts.calendar ?? continuousCalendar,
          ...(opts.statusDate === undefined ? {} : { statusDate: opts.statusDate }),
        })
        opts.onChange?.(result)
        render()
      }

      const cleanup = (): void => {
        delete bar.dataset['dragging']
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', cleanup)
        disposeDrag = null
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', cleanup)
      disposeDrag = cleanup
    })
  }

  function labelFor(task: Task): string {
    return opts.labelOf?.(task) ?? task.id
  }

  const instance: GanttInstance = {
    element: root,
    update(next) {
      opts = { ...opts, ...next }
      render()
    },
    setZoom(zoom) {
      opts = { ...opts, zoom }
      render()
    },
    toggle(taskId) {
      if (collapsed.has(taskId)) collapsed.delete(taskId)
      else collapsed.add(taskId)
      render()
    },
    select(taskId) {
      selected = taskId
      opts.onSelect?.(taskId)
      render()
    },
    destroy() {
      disposeDrag?.()
      timeline.removeEventListener('scroll', syncScroll)
      root.remove()
    },
  }

  render()
  return instance
}

// ---- Layout helpers ----

/** Depth-first over the parent tree, so children follow their parent and collapse hides a subtree. */
function buildRows(
  tasks: readonly Task[],
  parents: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
): Row[] {
  const childrenOf = new Map<string, Task[]>()
  const roots: Task[] = []
  const byId = new Map(tasks.map((task) => [task.id, task]))

  for (const task of tasks) {
    if (task.parentId !== undefined && byId.has(task.parentId)) {
      const siblings = childrenOf.get(task.parentId)
      if (siblings === undefined) childrenOf.set(task.parentId, [task])
      else siblings.push(task)
    } else {
      roots.push(task)
    }
  }

  const rows: Row[] = []
  const walk = (task: Task, depth: number): void => {
    const children = childrenOf.get(task.id) ?? []
    rows.push({
      task,
      depth,
      hasChildren: children.length > 0,
      isParent: parents.has(task.id),
    })
    if (collapsed.has(task.id)) return
    for (const child of children) walk(child, depth + 1)
  }
  for (const task of roots) walk(task, 0)
  return rows
}

function timeRange(extents: readonly Extent[]): { from: number; to: number } {
  if (extents.length === 0) {
    const now = Date.UTC(2026, 0, 1)
    return { from: now, to: now + 30 * MS_PER_DAY }
  }
  const starts = extents.map((extent) => extent.start.getTime())
  const finishes = extents.map((extent) => extent.finish.getTime())
  const from = floorToDay(Math.min(...starts)) - MS_PER_DAY
  const to = floorToDay(Math.max(...finishes)) + 2 * MS_PER_DAY
  return { from, to }
}

const floorToDay = (ms: number): number => Math.floor(ms / MS_PER_DAY) * MS_PER_DAY

interface Tick {
  at: number
  label: string
  width: number
}

function minorTicks(range: { from: number; to: number }, zoom: Zoom): Tick[] {
  const ticks: Tick[] = []
  if (zoom === 'day') {
    for (let at = range.from; at < range.to; at += MS_PER_DAY) {
      const date = new Date(at)
      ticks.push({ at, label: String(date.getUTCDate()), width: MS_PER_DAY })
    }
    return ticks
  }
  if (zoom === 'week') {
    for (let at = startOfWeek(range.from); at < range.to; at += 7 * MS_PER_DAY) {
      ticks.push({ at, label: shortDate(new Date(at)), width: 7 * MS_PER_DAY })
    }
    return ticks
  }
  for (let at = startOfMonth(range.from); at < range.to; at = addMonths(at, 1)) {
    ticks.push({ at, label: monthName(new Date(at)), width: addMonths(at, 1) - at })
  }
  return ticks
}

function majorTicks(range: { from: number; to: number }, zoom: Zoom): Tick[] {
  if (zoom === 'month') {
    const ticks: Tick[] = []
    for (let at = startOfYear(range.from); at < range.to; at = addMonths(at, 12)) {
      ticks.push({ at, label: String(new Date(at).getUTCFullYear()), width: addMonths(at, 12) - at })
    }
    return ticks
  }
  const ticks: Tick[] = []
  for (let at = startOfMonth(range.from); at < range.to; at = addMonths(at, 1)) {
    const date = new Date(at)
    ticks.push({
      at,
      label: `${monthName(date)} ${date.getUTCFullYear()}`,
      width: addMonths(at, 1) - at,
    })
  }
  return ticks
}

function tickElement(tick: Tick, range: { from: number; to: number }, pxPerDay: number): HTMLElement {
  const node = element('div', 'gantt-tick')
  node.style.left = `${((tick.at - range.from) / MS_PER_DAY) * pxPerDay}px`
  node.style.width = `${(tick.width / MS_PER_DAY) * pxPerDay}px`
  node.textContent = tick.label
  return node
}

/** An elbow from a predecessor's finish to a successor's start, with an arrowhead. */
function arrow(
  fromX: number,
  fromRow: number,
  toX: number,
  toRow: number,
  rowHeight: number,
): SVGElement[] {
  const y1 = fromRow * rowHeight + rowHeight / 2
  const y2 = toRow * rowHeight + rowHeight / 2
  const gap = 10

  const points =
    toX >= fromX + gap
      ? `M ${fromX} ${y1} H ${toX - gap / 2} V ${y2} H ${toX - 4}`
      : `M ${fromX} ${y1} H ${fromX + gap / 2} V ${(y1 + y2) / 2} H ${toX - gap} V ${y2} H ${toX - 4}`

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('class', 'gantt-link-path')
  path.setAttribute('d', points)

  const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
  head.setAttribute('class', 'gantt-link-head')
  head.setAttribute('points', `${toX},${y2} ${toX - 5},${y2 - 3.5} ${toX - 5},${y2 + 3.5}`)

  return [path, head]
}

// ---- Small utilities ----

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function safeCriticalPath(
  input: Parameters<typeof calculateCriticalPath>[0],
): ReturnType<typeof calculateCriticalPath> | null {
  try {
    return calculateCriticalPath(input)
  } catch {
    // A cyclic graph has no schedule. The chart still draws from stored dates so the user can
    // see and fix the problem rather than facing an empty panel.
    return null
  }
}

function readRowHeight(root: HTMLElement): number {
  return readPixels(root, '--gantt-row-height', 30)
}

function readBarHeight(root: HTMLElement): number {
  return readPixels(root, '--gantt-bar-height', 16)
}

function readPixels(root: HTMLElement, token: string, fallback: number): number {
  const raw = getComputedStyle(root).getPropertyValue(token).trim()
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const trim = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const monthName = (date: Date): string => MONTHS[date.getUTCMonth()]!
const shortDate = (date: Date): string => `${date.getUTCDate()} ${monthName(date)}`
const formatDate = (date: Date): string =>
  `${shortDate(date)} ${String(date.getUTCHours()).padStart(2, '0')}:${String(
    date.getUTCMinutes(),
  ).padStart(2, '0')}`

const startOfWeek = (ms: number): number => {
  const date = new Date(floorToDay(ms))
  return date.getTime() - ((date.getUTCDay() + 6) % 7) * MS_PER_DAY
}
const startOfMonth = (ms: number): number => {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}
const startOfYear = (ms: number): number => Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)
const addMonths = (ms: number, count: number): number => {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1)
}
