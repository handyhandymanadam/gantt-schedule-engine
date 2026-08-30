# Design

Why this project exists, what it does and does not attempt, and the reasoning behind the model.
This is the reference for anyone extending the engine; the decisions below are settled, and most
carry the reasoning that produced them so they can be revisited on their merits rather than
re-argued from scratch.

## Why this exists

Auto-scheduling, critical path, and resource handling are the standard paywall across the Gantt
ecosystem. The gap is consistent enough to be worth documenting.

**DHTMLX Gantt.** From v10 the free tier is the MIT-licensed Community Edition (v9.x and earlier
were GPL v2). Per the vendor's own [edition comparison](https://docs.dhtmlx.com/gantt/guides/editions-comparison/),
these are PRO-only:

- **Auto scheduling.** Moving a task does not cascade to dependents at all in Community. The PRO
  implementation is genuinely sophisticated: forward and backward planning strategies, eight
  constraint types, lag and lead time, circular-dependency detection, and hooks for custom logic.
- **Critical path calculation**, a separate PRO feature usually paired with auto-scheduling.
- **Resource management**, including resource load views and per-resource working calendars.
- A long tail besides: per-task working hours, task splitting, grouping, undo/redo, baselines and
  deadlines, unscheduled tasks, WBS codes, and lazy loading for large projects.

**SVAR Gantt**, from the same team and a newer product line, has a genuinely MIT-licensed core
covering visualization, drag and drop, hierarchy, progress, configurable time scales, and
virtualization. PRO gates the same pillars: work-time calendars, critical path, slack, baselines,
resource planning, grouping, auto-scheduling, summary automation, rollups, split tasks, and
export. One useful detail is that SVAR PRO's auto-scheduling is *simpler* than DHTMLX PRO's —
forward planning and Finish-to-Start only, with no backward planning and no constraint framework.
That is a realistic bar to match.

**Frappe Gantt** is MIT with no paid tier, and offers one thing the others withhold: a
`move_dependencies` option that shifts dependent successors by the same delta when a task moves.
Simple, real, and free. Nothing for critical path or resource handling.

**OpenProject** (GPLv3) is the most encouraging prior art. It ships real, free, production
automatic scheduling: with automatic mode on, a successor starts immediately after its predecessor
finishes, and the predecessor cannot move without the successor following. That validates
predecessor-cascade scheduling as proven functionality rather than a theoretical exercise. Its
*documented behaviour* is a legitimate reference; its source is not, and was not consulted.

**GanttProject** (GPL) confirms critical path is implementable in the open. More instructive is
what it lacks: its community has requested resource leveling for years without it landing. Even a
mature, decade-plus dedicated scheduling tool has not solved automatic leveling well. Scoping
leveling out of this project is realism, not corner-cutting.

**Everything else** on GitHub's `gantt-chart` topic — angular-gantt, gantt-elastic, jQuery.Gantt,
vue-ganttastic, svelte-gantt, gantt-task-react, wl-gantt, xpyjs/gantt, and the various React
wrappers — is either abandoned or, per its own documentation, offers nothing beyond bars, drag,
and dependency lines.

The pattern is industry-wide rather than any one vendor's quirk. There are already several free
Gantt *renderers*; the renderer was never the scarce part. The engine is.

### Licensing hygiene

This is original work, informed by publicly documented behaviour and standard CPM textbook
algorithms. No GPL-licensed source was consulted, and none should be. Keeping that true is what
keeps the MIT licence on this repository clean.

## Scope

### The three pillars

1. **Critical path, at full fidelity.** Standard CPM: forward pass for early start and finish,
   backward pass for late start and finish, slack as late start minus early start, and the
   critical path as the chain of zero-slack tasks. This is public-domain operations-research
   mathematics roughly seventy years old, so there is no reason for this implementation to be
   worse than a commercial one. Build it to textbook correctness.

2. **Auto-scheduling.** v1 is forward planning with Finish-to-Start dependencies only: a
   successor's start recalculates to its predecessor's finish plus lag whenever the predecessor's
   dates change. This matches OpenProject's proven shipping behaviour and SVAR PRO's scope.

3. **Resource conflicts, flagged rather than levelled.** Detect overlapping assignments and
   capacity shortfalls and surface them through the API. Do not attempt resource-constrained
   optimization. This is a deliberate limit, for the reason given in the GanttProject note above:
   a heuristic that silently rearranges crew assignments is worse than an honest flag.

### Four further capabilities, all load-bearing

4. **Working calendars.** Both commercial libraries paywall work-time calendars, and no real
   schedule is correct without one. All arithmetic runs in working units and converts to
   wall-clock only through the `Calendar` port. The continuous 24/7 default reproduces naive
   behaviour exactly, so calendar-aware code is provably a superset of it. **This has to be
   designed in from the start** — retrofitting means revisiting every date computation.

5. **Data date and in-flight rescheduling.** A `statusDate` divides history from plan: work before
   it never moves, work after it can be rescheduled. In-progress tasks reschedule from the status
   date using *remaining* work at the current resource count. Without this the engine can only
   plan schedules that have not started. Also structural rather than additive — "never move
   completed work" threads through the cascade and is not a wrapper around it.

6. **Earned value.** Three independent inputs — baselined effort, actual hours from timesheets,
   and reported percent complete — yield the performance factor and a forecast. The three must
   stay independent: derive any one from another and the variance is identically zero by
   construction. Ships as a separate export, not entangled with CPM.

7. **Baselines.** Structural rather than cosmetic. Earned value must measure against the
   *baselined* estimate rather than the current one, or an approved change order silently rebases
   every variance figure and teams appear to gain efficiency for doing nothing. Freezing the
   estimate field is not the answer, because scope revisions are legitimate and routine;
   baselining is, because it makes re-baselining an explicit and auditable act.

## Data model

```ts
type Task = {
  id: string
  basis: 'duration' | 'effort'   // which quantity the author typed; that one is held constant
  effort?: number                // work units; required when basis === 'effort'
  resourceCount: number          // planned headcount, fractional allowed, must exceed zero
  duration: number               // working hours, canonical, the only quantity CPM reads
  resourceType?: string          // opaque grouping key for capacity matching
  start: Date
  schedulingMode: 'auto' | 'manual'
  parentId?: string
  actualStart?: Date
  actualFinish?: Date
  actualHours?: number           // burned, from timesheets, independent of percentComplete
  percentComplete?: number       // reported physical progress, independent of actualHours
}

type Link = {
  id: string
  source: string                 // predecessor
  target: string                 // successor
  type: 'FS'                     // v1; SS/FF/SF deferred
  lag: number                    // working hours; negative means lead
}

type Resource = { id: string; type?: string }
type Assignment = { taskId: string; resourceId: string }
```

### Relationships that hold throughout

- `duration = effort / resourceCount` when `basis === 'effort'`, and
  `effort = duration * resourceCount` when `basis === 'duration'`.
- **Working hours are cardinal.** Work units are an authoring surface. Days are a display surface
  derived from the *actual scheduled span*, never from dividing hours by a nominal day length —
  day length can vary between calendars, so division is only correct when every working day is
  identical.
- Earned work is `percentComplete * baselined effort`; the performance factor is earned over
  actual.
- `resourceCount` is *planned* capacity and drives the duration arithmetic. `Assignment` records
  *named* resources and drives conflict detection. They are deliberately independent: planning
  happens before staffing, and the gap between the two is itself useful information. Deriving
  count from assignments would give an unstaffed task an infinite duration, which is wrong — an
  unstaffed task has a perfectly good planned duration and simply nobody on it yet.

### API surface

Pure functions over plain data. Nothing is fetched, nothing is mutated.

```ts
validate({ tasks, links, resources, assignments })
calculateCriticalPath({ tasks, links, calendar })
autoSchedule({ tasks, links, calendar, statusDate, options })   // returns proposed changes
findResourceConflicts({ tasks, assignments, resources })
calculateProgressVariance({ tasks, baseline })
captureBaseline(tasks, capturedAt)
deriveDuration(effort, resourceCount, calendar, snap?)
```

## Decisions and their reasoning

**Effort basis is per task, not per project.** Both kinds coexist on one schedule. Framing is
effort-driven, so adding people shortens it. Concrete curing is not, so adding people changes
nothing. A global switch forces one of those to be modelled as a lie — and in a work-driven
project it would let you cure concrete faster by hiring labourers. A project-level default with a
per-task override gives the convenience without the falsehood.

**Derivation is never implicit inside scheduling.** The well-known failure mode in commercial
tools is three coupled variables — work, duration, and units — with a mode matrix deciding which
recomputes. Users cannot predict which of the other two will move. Declaring the authored quantity
per task reduces this to two fully predictable cases. A schedule that responds to a resource change
is doing its job; a schedule where you cannot predict *what* will respond is not.

**Resource count is constant within a task.** Real work ramps up and tapers, but a staffing curve
inside one task breaks the clean division and hides the structure you want visible. Model a genuine
ramp as two tasks: separate durations, separate dependencies, separate progress. That is better
information, not a workaround.

**Milestones are zero-duration tasks, with no separate flag.** A boolean beside a duration field
permits a contradictory state (`isMilestone` true with a duration of five) that then has to be
validated away. Zero duration makes the contradiction unrepresentable, and CPM handles
zero-duration nodes without special-casing.

**Finish instants normalise backward; start instants normalise forward.** A task finishing Friday
at 17:00 reports its finish as Friday 17:00, while a successor starting from that instant reports
the next working moment. Normalising both the same way makes milestones appear to drift into the
following week even though the arithmetic is right.

**Scheduling proposes; it never mutates.** `autoSchedule` returns the changes it would make, so an
application can show "this moves six downstream tasks" before anything happens. Returning a
mutated array forecloses that permanently. It also means forecasting can be aggressive without
being alarming, because nothing moves without a human seeing it first.

**Cycle detection is v1, not deferred.** The forward pass *is* a topological traversal, so Kahn's
algorithm yields cycle detection for free. Without it the engine either loops forever or silently
produces nonsense, because a cyclic graph has no schedule at all.

**CPM runs on leaves; parents are derived.** A parent's duration is the span of its children, its
work is their sum, and its progress is *work-weighted* — a straight average would let a four-hour
punch-list item count as much as a two-hundred-hour task. Parents are read-only; permitting a
summary task to carry its own competing dates is a persistent source of confusion elsewhere.

**Links on parent tasks are supported**, via zero-duration boundary nodes the engine materialises
for any linked parent. A parent-to-parent link then becomes an ordinary leaf-level link and CPM
runs unchanged. This works without special-casing because the forward pass takes the maximum over
predecessors, so a parent-start node acts as a lower bound rather than a forced equality, and
leaves with later predecessors of their own still start when their logic dictates.

The alternative — requiring explicit milestones at phase boundaries — was rejected for two
reasons. Not every domain has a natural milestone event at a phase transition; requiring one is
modelling ceremony with nothing behind it. More seriously, a milestone's correctness depends on
the author having linked *every* leaf in the phase to it, so adding a task later and forgetting to
wire it up makes the milestone fire early, silently and with no error. A parent's extent is
derived and cannot miss a task. On large schedules the derived construct is the safer one.

**Forecasting uses performance-adjusted remaining work, gated at 20% complete.** Below that
threshold the factor is too volatile to drive dates — one bad morning at 5% complete produces a
wildly pessimistic finish. Past it, the performance index is empirically the better predictor.
Both projections are always reported; only which one feeds the dates is configurable. This is safe
precisely because scheduling proposes rather than mutates.

**Conflicts are detected across projects; rescheduling is not.** The data model is flat, so
passing tasks spanning several projects to `findResourceConflicts` finds cross-project
double-booking with no extra machinery. Cascading a reschedule across projects is a different
matter: they have independent critical paths, and moving one project's dates as a side effect of
editing another is not something a user asked for.

**Conflict output is annotated with elasticity.** Work-driven tasks can absorb a conflict by
stretching; duration-driven ones cannot. Reporting which is which turns "you have a conflict" into
"you have a conflict, and these are the two tasks that can give" — still flagging, since the
engine names the levers rather than pulling them.

**Vocabulary is domain-neutral.** `resourceCount`, `resource.type`, and `effort` rather than
industry-specific terms. The capabilities are shaped by real scheduling problems, but the naming
should not make the package look irrelevant to anyone outside one trade. Applications relabel in
their own UI.

**The engine is given data and never fetches it.** No database, no API client, no event bus, no
subscriptions, and no runtime dependencies at all. The consuming application assembles the arrays
and translates its own domain events into recompute calls. The moment the engine knows how to load
a resource roster it is coupled to a schema and stops being reusable.

## Deferred

Additive later with no rework: time-cost tradeoff analysis (crashing — because `basis` is recorded
per task, the engine can already identify which critical-path tasks are work-driven and therefore
worth adding people to), SS/FF/SF link types, backward planning, the full constraint framework,
split tasks, multi-skilled resources (v1 models one type per resource and errs by under-counting
availability, which is the safer direction), WBS codes, undo/redo, and export.

## Build order

1. Scaffold: monorepo, TypeScript, licence, test runner.
2. Types, the `Calendar` port, the continuous default, and `validate()`.
3. `calculateCriticalPath`, tested against published worked examples — built *before* any real
   calendar exists, so the graph mathematics is verified independent of date arithmetic.
4. A real weekday and holiday calendar. The CPM tests must still pass under the continuous
   calendar afterwards, which is a free guarantee that calendar-aware code reproduces the naive
   results exactly. That is the check that catches off-by-one-working-day errors.
5. Effort and duration derivation helpers, with opt-in snapping.
6. `autoSchedule` — forward, FS-only, data-date aware, returning proposals. After the calendar,
   because cascading is where calendar arithmetic compounds.
7. Parent rollup and boundary-node expansion for parent links.
8. `findResourceConflicts` — type-aware capacity with elasticity annotation.
9. `calculateProgressVariance` and `captureBaseline`.
10. The reference Gantt renderer.

## Testing

Three layers, because the mathematics is the product:

- **Textbook fixtures** — worked CPM examples with published answers, so results are verified
  against a known-correct source rather than against whatever the implementation produces.
- **Property-based tests** over the invariants, since the input space is combinatorial in a way
  examples cannot cover: work over count equals duration, slack is never negative, every
  critical task has exactly zero slack, no task starts before its predecessors finish, nothing is
  rescheduled before the data date, a parent's span contains its children, and `autoSchedule` is
  idempotent. That last one matters most — a schedule that drifts on repeated runs is the classic
  failure of these engines and is nearly impossible to catch with hand-written examples.
- **Golden snapshots** of a realistic schedule, so refactors that silently change results are
  caught.
