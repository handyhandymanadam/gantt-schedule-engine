import {
  autoSchedule,
  calculateCriticalPath,
  continuousCalendar,
  parentIds,
  placeFinish,
  placeStart,
  topologicalSort,
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

  /**
   * Set to allow dependencies to be drawn between bars and removed with Delete. Off by default,
   * so a read-only chart stays read-only.
   */
  editableLinks?: boolean

  /**
   * Called when a dependency is added or removed, with the proposed link set and the schedule
   * that would follow. As with `onChange`, nothing has been applied.
   */
  onLinksChange?: (change: LinkChange) => void

  /** Called when a drawn dependency was refused, so the reason can be surfaced. */
  onLinkRejected?: (rejection: LinkRejection) => void

  /** Set to allow rows to be dragged into a new order, or into a different parent. */
  reorderable?: boolean

  /**
   * Drop a task's dependencies when it moves to a different parent. Defaults to `true`.
   *
   * A task dragged into another phase is usually being repurposed, and its old links become both
   * meaningless and visually chaotic - arrows striping across the chart to wherever it used to
   * live. Only links crossing the moved subtree's boundary are cut; links wholly inside it
   * travel with it.
   *
   * Reordering within the same parent never cuts anything: order is presentation, and silently
   * destroying logic because someone tidied the outline would be its own kind of bug.
   */
  breakLinksOnReparent?: boolean

  /** Called when a row has been dragged somewhere new. Nothing has been applied. */
  onReorder?: (change: ReorderChange) => void
}

export interface ReorderChange {
  /** The full proposed task list: new order, and the moved task's new parent. */
  tasks: Task[]
  moved: Task
  fromParentId?: string
  toParentId?: string
  /** The proposed link set, after any that the move invalidated were dropped. */
  links: Link[]
  /** Dependencies the move removed, so the change can be described and undone. */
  removedLinks: Link[]
  /**
   * What the move does to the dates.
   *
   * Reordering alone changes nothing - order is presentation, dependencies are logic. Changing
   * a task's parent does change dates, because phase extents are derived from their children and
   * a phase may itself be linked.
   */
  schedule: AutoScheduleResult
}

export interface LinkChange {
  /** The full proposed link set, ready to persist. */
  links: Link[]
  added?: Link
  removed?: Link
  /** What the change does to the dates. */
  schedule: AutoScheduleResult
}

export interface LinkRejection {
  reason: 'self' | 'duplicate' | 'cycle'
  source: string
  target: string
}

export interface GanttInstance {
  update(options: Partial<GanttOptions>): void
  setZoom(zoom: Zoom): void
  toggle(taskId: string): void
  select(taskId: string | null): void
  /** Select a dependency, so Delete removes it. */
  selectLink(linkId: string | null): void
  /** Remove a dependency by id, as the Delete key does. */
  removeLink(linkId: string): void
  /** Move a task before another, or to the end of a parent. Mirrors a row drag. */
  moveTask(taskId: string, options: { before?: string; intoParent?: string | null }): void
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
  let selectedLink: string | null = null

  const root = document.createElement('div')
  root.className = 'gantt'
  root.tabIndex = 0

  const grid = element('div', 'gantt-grid')
  const gridHeader = element('div', 'gantt-grid-header')
  gridHeader.textContent = 'Task'
  const gridBody = element('div', 'gantt-grid-body')
  // Rows live in an inner layer that is translated rather than scrolled. Scrolling it would
  // clamp at its own content height, which is shorter than the timeline's scroll range - the
  // timeline's scroller also contains its sticky header and a horizontal scrollbar - so the two
  // panes would drift apart by that difference at the bottom of a long schedule.
  const gridRows = element('div', 'gantt-grid-rows')
  const dropLine = element('div', 'gantt-drop-line')
  dropLine.hidden = true
  gridRows.append(dropLine)
  gridBody.append(gridRows)
  grid.append(gridHeader, gridBody)

  const timeline = element('div', 'gantt-timeline')
  const timelineHeader = element('div', 'gantt-timeline-header')
  const body = element('div', 'gantt-body')
  timeline.append(timelineHeader, body)

  const menu = element('div', 'gantt-menu')
  menu.setAttribute('role', 'menu')
  menu.hidden = true

  root.append(grid, timeline, menu)
  container.append(root)

  // The grid scrolls only as a consequence of the timeline scrolling; it has no scrollbar of
  // its own, so the two can never drift apart.
  const syncScroll = (): void => {
    gridRows.style.transform = `translateY(${-timeline.scrollTop}px)`
  }
  timeline.addEventListener('scroll', syncScroll)

  interface MenuItem {
    label: string
    onSelect: () => void
  }

  /**
   * A small context menu, positioned inside the chart.
   *
   * Deletion is reachable three ways on purpose: this menu, the button on a selected arrow, and
   * the Delete key. Scheduling is mouse work, and a mouse user should never have to discover a
   * keyboard shortcut to undo something they drew with the mouse.
   */
  function openMenu(clientX: number, clientY: number, items: readonly MenuItem[]): void {
    menu.replaceChildren()
    for (const item of items) {
      const button = element('button', 'gantt-menu-item')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = item.label
      button.addEventListener('click', () => {
        closeMenu()
        item.onSelect()
      })
      menu.append(button)
    }

    const box = root.getBoundingClientRect()
    menu.hidden = false
    // Clamp so a menu opened near the right or bottom edge stays inside the chart.
    const left = Math.min(clientX - box.left, Math.max(0, box.width - menu.offsetWidth - 4))
    const top = Math.min(clientY - box.top, Math.max(0, box.height - menu.offsetHeight - 4))
    menu.style.left = `${Math.max(0, left)}px`
    menu.style.top = `${Math.max(0, top)}px`
    root.focus({ preventScroll: true })
  }

  function closeMenu(): void {
    menu.hidden = true
    menu.replaceChildren()
  }

  const onDocumentPointerDown = (event: Event): void => {
    if (menu.hidden) return
    if (event.target instanceof Node && menu.contains(event.target)) return
    closeMenu()
  }
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  timeline.addEventListener('scroll', closeMenu)

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      closeMenu()
      return
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    if (selectedLink === null || opts.editableLinks !== true) return
    event.preventDefault()
    instance.removeLink(selectedLink)
  }
  root.addEventListener('keydown', onKeyDown)

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

    root.dataset['reorderable'] = String(opts.reorderable === true)

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
    gridRows.replaceChildren(dropLine)
    for (const row of rows) {
      const line = element('div', 'gantt-row')
      line.dataset['taskId'] = row.task.id
      line.dataset['parent'] = String(row.isParent)
      line.dataset['selected'] = String(selected === row.task.id)
      line.style.paddingLeft = `${8 + row.depth * 14}px`

      if (opts.reorderable === true) {
        const grip = element('span', 'gantt-grip')
        grip.setAttribute('aria-hidden', 'true')
        grip.textContent = '\u283f'
        grip.title = 'Drag to reorder, or onto a phase to move it there'
        line.append(grip)
      }

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
      if (opts.reorderable === true) attachRowDrag(line, row.task.id)
      gridRows.append(line)
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

      const group = svgNode('g')
      group.setAttribute('class', 'gantt-link-group')
      group.dataset['linkId'] = link.id
      group.dataset['selected'] = String(selectedLink === link.id)

      const drawn = arrow(xOf(source.finish), from, xOf(target.start), to, rowHeight)
      group.append(...drawn.nodes)

      if (opts.editableLinks === true) {
        const hit = group.querySelector('.gantt-link-hit')
        hit?.addEventListener('click', (event) => {
          event.stopPropagation()
          instance.selectLink(link.id)
        })
        hit?.addEventListener('contextmenu', (event) => {
          const mouse = event as MouseEvent
          mouse.preventDefault()
          mouse.stopPropagation()
          instance.selectLink(link.id)
          openMenu(mouse.clientX, mouse.clientY, [
            {
              label: `Remove dependency: ${labelFor(byIdOf(link.source))} \u2192 ${labelFor(byIdOf(link.target))}`,
              onSelect: () => instance.removeLink(link.id),
            },
          ])
        })

        // A visible control, because "click the thin line, then press Delete" is knowledge
        // nobody has until they are told. The keyboard shortcut still works for anyone who does.
        //
        // Built for every link and revealed by CSS on the selected one, rather than created when
        // selection changes: selection deliberately does not re-render, since rebuilding the DOM
        // mid-gesture is what used to break dragging.
        const remove = removeControl(drawn.mid, link.id)
        remove.addEventListener('click', (event) => {
          event.stopPropagation()
          instance.removeLink(link.id)
        })
        group.append(remove)
      }
      svg.append(group)
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

    if (kind !== 'summary') {
      attachDrag(bar, row.task, extent)
      if (opts.editableLinks === true) {
        // Dragging from the finish makes this task the predecessor; from the start, the
        // successor. Both produce the same Finish-to-Start link, just built from either end,
        // which is how people actually reach for it.
        bar.append(
          linkHandle(row.task.id, 'start'),
          linkHandle(row.task.id, 'end'),
        )
      }
    }
    return bar
  }

  /**
   * Dragging edits the task's start and asks the engine what that implies. Nothing is applied:
   * the proposal goes to `onChange`, so the application can show "this moves six downstream
   * tasks" and let a human decide, exactly as the engine intends.
   */
  function attachDrag(bar: HTMLElement, task: Task, extent: Extent): void {
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
          // Offset from where the task is *drawn*, not from its stored start. For anything
          // auto-scheduled those differ: the engine placed the bar, and the stored date is
          // whatever it happened to be authored with. Using the stored one teleports the task
          // to a position that has nothing to do with where the user grabbed it.
          start: new Date(extent.start.getTime() + deltaDays * MS_PER_DAY),
          // Placing a task by hand makes it an anchor.
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

  function linkHandle(taskId: string, side: 'start' | 'end'): HTMLElement {
    const handle = element('span', `gantt-handle gantt-handle-${side}`)
    handle.dataset['side'] = side

    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return
      // Stop the bar's own move-drag: this gesture is about dependencies, not dates.
      event.stopPropagation()
      event.preventDefault()
      beginLinkDrag(taskId, side, event)
    })

    return handle
  }

  function beginLinkDrag(taskId: string, side: 'start' | 'end', event: PointerEvent): void {
    root.dataset['linking'] = 'true'

    const svg = body.querySelector('.gantt-links')
    const rubber = svgNode('path')
    rubber.setAttribute('class', 'gantt-rubber')
    svg?.append(rubber)

    const origin = pointIn(body, event)
    let hovered: HTMLElement | null = null

    const onMove = (move: PointerEvent): void => {
      const to = pointIn(body, move)
      rubber.setAttribute('d', `M ${origin.x} ${origin.y} L ${to.x} ${to.y}`)

      const over = barUnder(move)
      if (over !== hovered) {
        if (hovered !== null) delete hovered.dataset['linkTarget']
        hovered = over !== null && over.dataset['taskId'] !== taskId ? over : null
        if (hovered !== null) hovered.dataset['linkTarget'] = 'true'
      }
    }

    const onUp = (up: PointerEvent): void => {
      cleanup()
      const over = barUnder(up)
      const other = over?.dataset['taskId']
      if (other === undefined) return
      // Dragging from the finish handle makes this task the predecessor, and vice versa.
      if (side === 'end') proposeLink(taskId, other)
      else proposeLink(other, taskId)
    }

    const cleanup = (): void => {
      delete root.dataset['linking']
      if (hovered !== null) delete hovered.dataset['linkTarget']
      rubber.remove()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', cleanup)
      disposeDrag = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', cleanup)
    disposeDrag = cleanup
  }

  /**
   * Build the proposed link, refuse it if it cannot stand, and otherwise report it along with
   * the schedule it implies. Nothing is applied here either.
   */
  function proposeLink(source: string, target: string): void {
    const links = opts.links ?? []

    if (source === target) {
      opts.onLinkRejected?.({ reason: 'self', source, target })
      return
    }
    if (links.some((link) => link.source === source && link.target === target)) {
      opts.onLinkRejected?.({ reason: 'duplicate', source, target })
      return
    }

    const added: Link = { id: `${source}->${target}`, source, target, type: 'FS', lag: 0 }
    const next = [...links, added]

    // A cycle has no schedule at all, so it is refused at the point of drawing rather than
    // accepted and then thrown by the engine.
    const ids = opts.tasks.map((task) => task.id)
    const { cycles } = topologicalSort(
      ids,
      next.map((link) => ({ from: link.source, to: link.target })),
    )
    if (cycles.length > 0) {
      opts.onLinkRejected?.({ reason: 'cycle', source, target })
      return
    }

    emitLinks(next, { added })
  }

  function emitLinks(links: Link[], detail: { added?: Link; removed?: Link }): void {
    const schedule = autoSchedule({
      tasks: opts.tasks,
      links,
      calendar: opts.calendar ?? continuousCalendar,
      ...(opts.statusDate === undefined ? {} : { statusDate: opts.statusDate }),
    })
    opts.onLinksChange?.({ links, schedule, ...detail })
  }

  /**
   * Dragging a row to a new place in the outline.
   *
   * Two operations at once, because to a user they are one gesture: reordering among siblings,
   * and moving into a different parent. Order is presentation - it changes no dates - while
   * reparenting does, since a phase's extent is derived from its children.
   */
  function attachRowDrag(line: HTMLElement, taskId: string): void {
    line.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return
      // Let the collapse toggle do its own job.
      if ((event.target as HTMLElement).closest('.gantt-toggle') !== null) return

      const originY = event.clientY
      let started = false
      let target: DropTarget | null = null

      const onMove = (move: PointerEvent): void => {
        // A few pixels of slop, so a click to select is not read as a drag.
        if (!started && Math.abs(move.clientY - originY) < 4) return
        // Only once the gesture is definitely a drag: preventing default on pointerdown would
        // also swallow the click that selects a row.
        move.preventDefault()
        if (!started) window.getSelection()?.removeAllRanges()
        started = true
        line.dataset['dragging'] = 'true'

        target = dropTargetAt(move.clientY, taskId)
        showDropLine(target)
      }

      const onUp = (): void => {
        const chosen = started ? target : null
        cleanup()
        if (chosen === null) return
        applyMove(taskId, chosen)
      }

      const cleanup = (): void => {
        delete line.dataset['dragging']
        dropLine.hidden = true
        clearDropHighlight()
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

  interface DropTarget {
    /** Insert before this task, or append to the end of `parentId` when undefined. */
    before?: string
    /** The parent the task will belong to. `null` means top level. */
    parentId: string | null
    /** `into` drops onto a parent row itself; `between` drops in the gap between two rows. */
    mode: 'into' | 'between'
  }

  /**
   * Where a drop at this height would land.
   *
   * Hovering the middle of a phase row nests into it. Anywhere else falls to the nearest gap
   * between rows, taking the parent of the row above - so dropping just under a task inside a
   * phase keeps you in that phase, which is what the gesture looks like it should do.
   */
  function dropTargetAt(clientY: number, movingId: string): DropTarget | null {
    const lines = [...gridRows.querySelectorAll<HTMLElement>('.gantt-row')]
    if (lines.length === 0) return null

    const forbidden = subtreeOf(movingId)

    for (const line of lines) {
      const id = line.dataset['taskId']
      if (id === undefined) continue
      const box = line.getBoundingClientRect()
      if (clientY < box.top || clientY > box.bottom) continue

      const third = box.height / 3
      const isParent = line.dataset['parent'] === 'true'

      // Nesting into a phase, but never into the subtree being moved.
      if (isParent && clientY > box.top + third && clientY < box.bottom - third) {
        if (forbidden.has(id)) return null
        return { parentId: id, mode: 'into' }
      }

      if (clientY < box.top + box.height / 2) {
        return { ...gapBefore(id, lines, forbidden), mode: 'between' }
      }
      const next = lines[lines.indexOf(line) + 1]?.dataset['taskId']
      return next === undefined
        ? { parentId: parentOf(id) ?? null, mode: 'between' }
        : { ...gapBefore(next, lines, forbidden), mode: 'between' }
    }

    // Below the last row: append at the level of whatever ends the list.
    const last = lines[lines.length - 1]?.dataset['taskId']
    return { parentId: last === undefined ? null : (parentOf(last) ?? null), mode: 'between' }
  }

  /** The gap immediately above `beforeId`, and which parent it belongs to. */
  function gapBefore(
    beforeId: string,
    lines: readonly HTMLElement[],
    forbidden: ReadonlySet<string>,
  ): { before?: string; parentId: string | null } {
    const index = lines.findIndex((line) => line.dataset['taskId'] === beforeId)
    const above = index > 0 ? lines[index - 1]?.dataset['taskId'] : undefined

    // The parent of the row above, so dropping under a task inside a phase stays in that phase.
    // Directly under an expanded phase header means becoming its first child.
    let parentId: string | null = null
    if (above !== undefined && !forbidden.has(above)) {
      const aboveIsOpenParent =
        lines[index - 1]?.dataset['parent'] === 'true' && !collapsed.has(above)
      parentId = aboveIsOpenParent ? above : (parentOf(above) ?? null)
    }
    return { before: beforeId, parentId }
  }

  function parentOf(taskId: string): string | undefined {
    return opts.tasks.find((task) => task.id === taskId)?.parentId
  }

  /** A task and everything beneath it: never a legal destination for itself. */
  function subtreeOf(taskId: string): Set<string> {
    const found = new Set([taskId])
    let grew = true
    while (grew) {
      grew = false
      for (const task of opts.tasks) {
        if (task.parentId !== undefined && found.has(task.parentId) && !found.has(task.id)) {
          found.add(task.id)
          grew = true
        }
      }
    }
    return found
  }

  function showDropLine(target: DropTarget | null): void {
    clearDropHighlight()
    if (target === null) {
      dropLine.hidden = true
      return
    }

    if (target.mode === 'into') {
      dropLine.hidden = true
      const host = gridRows.querySelector<HTMLElement>(
        `.gantt-row[data-task-id="${CSS.escape(target.parentId ?? '')}"]`,
      )
      if (host !== null) host.dataset['dropInto'] = 'true'
      return
    }

    const anchor =
      target.before === undefined
        ? null
        : gridRows.querySelector<HTMLElement>(
            `.gantt-row[data-task-id="${CSS.escape(target.before)}"]`,
          )
    const y = anchor === null ? gridRows.scrollHeight : anchor.offsetTop

    dropLine.hidden = false
    dropLine.style.top = `${y}px`
    dropLine.style.marginLeft = `${target.parentId === null ? 0 : 14}px`
  }

  function clearDropHighlight(): void {
    for (const node of gridRows.querySelectorAll<HTMLElement>('[data-drop-into]')) {
      delete node.dataset['dropInto']
    }
  }

  function applyMove(taskId: string, target: DropTarget): void {
    const moved = opts.tasks.find((task) => task.id === taskId)
    if (moved === undefined) return
    if (target.before === taskId) return

    const subtree = subtreeOf(taskId)
    if (target.parentId !== null && subtree.has(target.parentId)) return

    const reparented: Task = { ...moved }
    if (target.parentId === null) delete reparented.parentId
    else reparented.parentId = target.parentId

    // The subtree travels with its root; children keep their own parents.
    const block = opts.tasks.filter((task) => subtree.has(task.id))
    const block2 = block.map((task) => (task.id === taskId ? reparented : task))
    const rest = opts.tasks.filter((task) => !subtree.has(task.id))

    const insertAt =
      target.before === undefined
        ? rest.length
        : (() => {
            const index = rest.findIndex((task) => task.id === target.before)
            return index === -1 ? rest.length : index
          })()

    const next = [...rest.slice(0, insertAt), ...block2, ...rest.slice(insertAt)]

    const links = opts.links ?? []
    const changedParent = (moved.parentId ?? null) !== target.parentId

    // Cut only the edges that cross the moved subtree's boundary. Links wholly inside it are
    // still coherent, because the whole subtree travelled together.
    const removedLinks =
      changedParent && opts.breakLinksOnReparent !== false
        ? links.filter(
            (link) => subtree.has(link.source) !== subtree.has(link.target),
          )
        : []

    const remainingLinks =
      removedLinks.length === 0
        ? links
        : links.filter((link) => !removedLinks.includes(link))

    const schedule = autoSchedule({
      tasks: next,
      links: remainingLinks,
      calendar: opts.calendar ?? continuousCalendar,
      ...(opts.statusDate === undefined ? {} : { statusDate: opts.statusDate }),
    })

    opts.onReorder?.({
      tasks: schedule.tasks,
      moved: reparented,
      ...(moved.parentId === undefined ? {} : { fromParentId: moved.parentId }),
      ...(target.parentId === null ? {} : { toParentId: target.parentId }),
      links: [...remainingLinks],
      removedLinks,
      schedule,
    })
  }

  function byIdOf(taskId: string): Task {
    return (
      opts.tasks.find((task) => task.id === taskId) ?? {
        id: taskId,
        basis: 'duration',
        resourceCount: 1,
        duration: 0,
        start: new Date(0),
        schedulingMode: 'auto',
      }
    )
  }

  function labelFor(task: Task): string {
    return opts.labelOf?.(task) ?? task.id
  }

  /**
   * Selection is a highlight, so it is applied in place.
   *
   * Re-rendering for it would be wasteful on every click, and actively broken during a drag:
   * `render` replaces every bar, so selecting from inside `pointerdown` detaches the node the
   * pointer is holding. The drag then moves an orphan and the chart appears frozen.
   */
  function applySelection(): void {
    for (const node of root.querySelectorAll<HTMLElement>('.gantt-row, .gantt-bar')) {
      node.dataset['selected'] = String(node.dataset['taskId'] === selected)
    }
    for (const node of root.querySelectorAll<SVGGElement>('.gantt-link-group')) {
      node.dataset['selected'] = String(node.dataset['linkId'] === selectedLink)
    }
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
      selectedLink = null
      applySelection()
      opts.onSelect?.(taskId)
    },
    selectLink(linkId) {
      selectedLink = linkId
      selected = null
      applySelection()
      // Focus the chart so Delete is scoped to it rather than hijacked from the whole page.
      if (linkId !== null) root.focus({ preventScroll: true })
    },
    moveTask(taskId, options) {
      const target: DropTarget =
        options.intoParent !== undefined
          ? { parentId: options.intoParent, mode: 'into' }
          : {
              parentId: options.before === undefined ? null : (parentOf(options.before) ?? null),
              mode: 'between',
              ...(options.before === undefined ? {} : { before: options.before }),
            }
      applyMove(taskId, target)
    },
    removeLink(linkId) {
      const links = opts.links ?? []
      const removed = links.find((link) => link.id === linkId)
      if (removed === undefined) return
      if (selectedLink === linkId) selectedLink = null
      emitLinks(
        links.filter((link) => link.id !== linkId),
        { removed },
      )
    },
    destroy() {
      disposeDrag?.()
      timeline.removeEventListener('scroll', syncScroll)
      timeline.removeEventListener('scroll', closeMenu)
      document.removeEventListener('pointerdown', onDocumentPointerDown, true)
      root.removeEventListener('keydown', onKeyDown)
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
interface Arrow {
  nodes: SVGElement[]
  /** Midpoint of the elbow, where a control can sit without covering either bar. */
  mid: { x: number; y: number }
}

function arrow(
  fromX: number,
  fromRow: number,
  toX: number,
  toRow: number,
  rowHeight: number,
): Arrow {
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

  // A 1.5px arrow is nearly impossible to hit, so a transparent wide stroke carries the events.
  const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  hit.setAttribute('class', 'gantt-link-hit')
  hit.setAttribute('d', points)

  // Computed from the elbow rather than measured from the path, so it works before layout.
  const mid =
    toX >= fromX + gap
      ? { x: toX - gap / 2, y: (y1 + y2) / 2 }
      : { x: (fromX + gap / 2 + toX - gap) / 2, y: (y1 + y2) / 2 }

  return { nodes: [hit, path, head], mid }
}

// ---- Small utilities ----

/** A round remove button sitting on a selected dependency. */
function removeControl(at: { x: number; y: number }, linkId: string): SVGGElement {
  const group = svgNode('g')
  group.setAttribute('class', 'gantt-link-remove')
  group.dataset['linkId'] = linkId
  group.setAttribute('role', 'button')
  group.setAttribute('aria-label', 'Remove dependency')

  const disc = svgNode('circle')
  disc.setAttribute('cx', String(at.x))
  disc.setAttribute('cy', String(at.y))
  disc.setAttribute('r', '8')

  const cross = svgNode('path')
  cross.setAttribute('class', 'gantt-link-remove-cross')
  const arm = 3.5
  cross.setAttribute(
    'd',
    `M ${at.x - arm} ${at.y - arm} L ${at.x + arm} ${at.y + arm} ` +
      `M ${at.x + arm} ${at.y - arm} L ${at.x - arm} ${at.y + arm}`,
  )

  group.append(disc, cross)
  return group
}

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag)
}

/** Pointer position in the chart body's own coordinates. */
function pointIn(host: HTMLElement, event: PointerEvent): { x: number; y: number } {
  const box = host.getBoundingClientRect()
  return { x: event.clientX - box.left, y: event.clientY - box.top }
}

/** The bar under the pointer, if any. Used to resolve a link drag's drop target. */
function barUnder(event: PointerEvent): HTMLElement | null {
  const hit = document.elementFromPoint(event.clientX, event.clientY)
  return hit === null ? null : (hit.closest<HTMLElement>('.gantt-bar') ?? null)
}

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
