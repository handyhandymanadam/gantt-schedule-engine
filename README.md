# gantt-schedule-engine

A headless project-scheduling engine, MIT licensed.

Critical path, cascading auto-scheduling, working calendars, resource-conflict flagging, and
earned value — the capabilities every comparable library puts behind a paid tier.

> **Status: v1 engine feature-complete, pre-release.** All of the scope below is implemented and
> tested, but the engine has not yet been validated against real production schedules and the API
> may still change. Not published to npm. Read it, clone it, but do not depend on it yet.

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
| `packages/gantt-ui` | A reference Gantt renderer consuming the engine. Neutral default styling. Not started. |

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

## Development

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc across the workspace
```

Testing runs in three layers: textbook CPM worked examples with published answers, property-based
tests over the invariants via fast-check, and golden snapshots of a realistic schedule. The math
is the product, so correctness is verified against known-good sources rather than against
whatever the implementation happens to produce.

## Licence

MIT. This is original work, informed by publicly documented behaviour and standard CPM textbook
algorithms. No GPL-licensed source was consulted.
