# gantt-schedule-ui

A Gantt chart for [`gantt-schedule-engine`](../engine). Vanilla DOM, no framework, no
dependencies beyond the engine itself.

> **Status: pre-release**, alongside the engine.

```ts
import { createGantt } from 'gantt-schedule-ui'
import 'gantt-schedule-ui/theme.css'
import { WorkingWeekCalendar } from 'gantt-schedule-engine'

const chart = createGantt(document.getElementById('chart'), {
  tasks,
  links,
  calendar: new WorkingWeekCalendar(),
  statusDate: new Date(),
  labelOf: (task) => names.get(task.id),
  onChange: (proposal) => {
    // Nothing has been applied. Show the ripple, then persist proposal.tasks if accepted.
    console.log(`${proposal.changes.length} task(s) would move`)
  },
})
```

## Editing dependencies

Set `editableLinks` and hovering a bar reveals a connector handle at each end. Drag from the
finish handle onto another bar to make this task the predecessor, or from the start handle to
make it the successor.

Removing one can be done three ways, because scheduling is mouse work and a mouse user should
never have to find a keyboard shortcut to undo something they drew with the mouse:

- **Right-click the arrow** and choose Remove.
- **Click the arrow**, then click the button that appears on it.
- **Click the arrow**, then press Delete or Backspace.

```ts
createGantt(host, {
  tasks, links, calendar,
  editableLinks: true,
  onLinksChange: ({ links, added, removed, schedule }) => {
    // Again a proposal: `links` is the new set, `schedule` is what it does to the dates.
  },
  onLinkRejected: ({ reason }) => {
    // 'cycle' | 'duplicate' | 'self'
  },
})
```

A dependency that would close a cycle is refused at the point of drawing rather than accepted
and then thrown by the engine, since a cyclic graph has no schedule at all.

## Reordering and reparenting

Set `reorderable` and rows **in the left-hand task list** can be dragged (bars drag dates; rows
drag position). A grip appears on hover and the cursor turns to a grab handle. Dropping in the gap between two
rows reorders; dropping onto the middle of a phase row moves the task into that phase. A task
carries its whole subtree, and cannot be dropped inside itself.

```ts
createGantt(host, {
  tasks, links, calendar,
  reorderable: true,
  onReorder: ({ tasks, links, moved, toParentId, removedLinks, schedule }) => {
    // removedLinks says what the move invalidated, so it can be described and undone.
  },
})
```

**Reordering within a parent changes nothing but the order** - it is presentation, not logic, so
no dependency is touched. **Moving to a different parent drops the dependencies that cross the
moved subtree's boundary**, since a task dragged into another phase is usually being repurposed
and its old links become both meaningless and visually chaotic. Links wholly inside the moved
subtree travel with it. Set `breakLinksOnReparent: false` to keep everything.

## What it draws

Task bars with progress, phase summary bars, milestones as diamonds, dependency arrows, the
zero-slack critical chain, non-working days shaded from the calendar, and the data date.
Phases collapse and expand; the timeline zooms by day, week or month.

**The renderer computes nothing.** Every date, the critical path, and every phase extent come
from the engine. Dragging a bar produces an engine *proposal* rather than a mutation: the chart
hands `onChange` the full set of downstream changes and the application decides whether they
happen. That is the engine's contract, carried up to the UI.

## Zoom

Scale is continuous. `zoom` takes a preset, a literal pixels-per-day, or a fit mode:

```ts
chart.setZoom('week')       // day | week | month | quarter | year
chart.setZoom(18)           // pixels per day, clamped to a usable range
chart.zoomToFit()           // the whole schedule in the visible width
chart.zoomToCriticalPath()  // the critical chain, scrolled into view
chart.zoomBy(1.3, clientX)  // scale about a point, holding it still
chart.pixelsPerDay          // the scale in use, however it was arrived at
```

Ctrl or Cmd with the wheel zooms about the cursor; a plain wheel scrolls as usual.

Fit modes are resolved at render time against the current width and re-resolve on resize, so they
stay correct rather than freezing at whatever the container was when chosen. Header granularity
follows the resolved scale, not the setting, so a numeric zoom gets the right ticks. `onZoom`
reports the scale whenever it changes, including from a wheel gesture, so host controls can stay
in step.

## Sizing

The chart fills its container and scrolls inside it, so **give the container a height**:

```css
#chart { height: 460px; }
```

Without one the chart grows to the height of its task list, and anything past the container's
edge is clipped and unreachable.

## Theming

Every colour and metric is a CSS custom property, so themes are applied by redefining tokens
rather than by overriding rules:

```css
.my-app .gantt {
  --gantt-bar: #4a72b0;
  --gantt-bar-critical: #b4544a;
  --gantt-row-height: 34px;
}
```

The full token list is at the top of [`src/theme.css`](src/theme.css). The defaults are
deliberately neutral and belong to no particular design language.

## Demo

`demo/index.html` renders a fifty-task house build on a working week with holidays. Serve the
repository root and open it:

```bash
pnpm build && python3 -m http.server 8173
```

Then visit `/packages/gantt-ui/demo/index.html`.

## Licence

MIT.
