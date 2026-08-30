# gantt-schedule-engine

A headless project-scheduling engine, MIT licensed.

Critical path, cascading auto-scheduling, working calendars, resource-conflict flagging, and
earned value — the capabilities every comparable library puts behind a paid tier.

> **Status: 0.x.** All of the scope below is implemented and covered by tests, but nothing here
> has yet been proven against real production schedules, so the API may still change between
> minor versions.
>
> `gantt-schedule-engine` is published to npm. `gantt-schedule-ui` is not yet published — it
> works, but it is still being refined; build it from this repository if you want it now.

## Why this exists

Auto-scheduling, critical path, and resource handling are the standard paywall across the Gantt
ecosystem. DHTMLX gates all three behind PRO. SVAR, from the same team, gates the same three plus
work-time calendars, baselines, and slack. Frappe Gantt is fully free but offers only a simple
"move dependents by the same delta" behaviour. Of the wider GitHub `gantt-chart` ecosystem, none
offer auto-scheduling, critical path, or resource leveling for free. Among GPL projects,
OpenProject ships real automatic scheduling and GanttProject ships critical path, but neither is
a library you can drop into an application, and their licences rule them out for most consumers.

The renderer was never the scarce part — there are already several free ones. The scheduling
engine is. So this is the engine, headless and framework-agnostic, with a renderer as a separate
package.

## Design

Full rationale, the research behind the scope, and the reasoning for each decision
is in [docs/DESIGN.md](docs/DESIGN.md).

**Pure functions over plain data.** No DOM, no framework, no fetching, no event bus, no
persistence. The consuming application assembles arrays of plain objects, calls a function, and
decides what to do with the result.

**Working hours are the cardinal unit.** Person-hours are an authoring surface, days are a display
surface derived from the scheduled span. All arithmetic runs in working time and converts to
wall-clock only through the `Calendar` port, so a real weekday/holiday calendar drops in without
touching the scheduling code.

**Scheduling proposes, it never mutates.** `autoSchedule` returns the set of changes it would
make, so an application can show "this moves six downstream tasks" and let a human decide. Every
scheduling *policy* decision stays in the application.

**Effort and duration are related by a declared invariant.** Each task names which quantity its
author typed — `basis: 'effort'` holds work constant so adding people shortens the task, while
`basis: 'duration'` holds the window constant so adding people consumes more work. Both kinds
coexist on one schedule: framing is effort-driven, concrete curing is not.

## Packages

| Package | Purpose |
|---|---|
| `packages/engine` | The scheduling engine. Framework-agnostic, no dependencies. |
| `packages/gantt-ui` | Gantt renderer consuming the engine (not yet published). Vanilla DOM, neutral default styling, themed by CSS custom properties. |

## Scope

**In v1:** critical path (full CPM: forward pass, backward pass, slack, zero-slack chain),
forward Finish-to-Start auto-scheduling, working calendars, cycle detection, validation, data-date
handling for live schedules, parent rollup, resource-conflict and capacity flagging, earned value
and baselines.

**Deliberately out:** true resource leveling. Conflicts are *flagged*, with an indication of which
tasks can absorb them, rather than automatically resolved. Even mature dedicated scheduling tools
have not solved automatic leveling well, and a heuristic that silently rearranges someone's crew
assignments is worse than an honest flag.

**Deferred:** time-cost tradeoff analysis (crashing), SS/FF/SF link types, backward planning, the
full constraint framework (ASAP/ALAP/SNET/SNLT/FNET/FNLT/MSO/MFO), split tasks, multi-skilled
resources, WBS codes, undo/redo, export.

## Performance

Measured on a chained, phase-structured schedule with a working-week calendar, holidays and
progress reported on a seventh of the tasks:

| | 500 tasks | 2,000 tasks | 10,000 tasks |
|---|---|---|---|
| `validate` | 0.9 ms | 1.7 ms | 9 ms |
| `calculateCriticalPath` | 4 ms | 13 ms | 74 ms |
| `autoSchedule` | 3 ms | 8 ms | 40 ms |
| `findResourceConflicts` | 0.6 ms | 1.3 ms | 6 ms |
| `calculateProgressVariance` | 0.6 ms | 1.5 ms | 6 ms |

Three things carry that. A calendar range is whole-week arithmetic plus corrections for the few
dates that depart from the pattern, so measuring a span costs the same whether it covers a week or
twenty years. Each day's resolved shifts are cached, because scheduling asks about the same days
repeatedly. And conflict detection is a sweep line rather than a scan at every boundary.

Every function is synchronous and pure over plain data, so running it in a worker is
straightforward - but rarely worth it. Copying 10,000 tasks to a worker and back costs about
26 ms against 40 ms of computation, so the gain is keeping the main thread free rather than
finishing sooner.

## Development

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc across the workspace
pnpm build         # both packages
```

For the chart demo, build and serve the repository root, then open
`/packages/gantt-ui/demo/index.html`.

Testing runs in three layers: textbook CPM worked examples with published answers, property-based
tests over the invariants via fast-check, and golden snapshots of a realistic schedule. The math
is the product, so correctness is verified against known-good sources rather than against
whatever the implementation happens to produce.

## Licence

MIT. This is original work, informed by publicly documented behaviour and standard CPM textbook
algorithms. No GPL-licensed source was consulted.
