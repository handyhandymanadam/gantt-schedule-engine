# gantt-schedule-engine

A headless project-scheduling engine. Critical path, cascading auto-scheduling, working calendars,
resource-conflict flagging, and earned value — the capabilities comparable libraries put behind a
paid tier.

**Zero runtime dependencies.** No DOM, no framework, no fetching.

> **Status: 0.x.** Everything below is implemented and covered by tests, but the engine has not
> yet been proven against real production schedules, so the API may still change between minor
> versions. Pin an exact version if that matters to you.

## Install

```bash
npm install gantt-schedule-engine
```

## What it does

```ts
import {
  validate,
  calculateCriticalPath,
  autoSchedule,
  findResourceConflicts,
  continuousCalendar,
} from 'gantt-schedule-engine'
```

Pure functions over plain data. You assemble arrays of plain objects, call a function, and decide
what to do with the result. The engine holds no state, fetches nothing, and mutates nothing.

- **`calculateCriticalPath`** — full CPM. Forward pass, backward pass, slack, and the zero-slack
  chain.
- **`autoSchedule`** — cascading reschedule along Finish-to-Start dependencies. Returns the changes
  it *would* make rather than applying them, so your application can show "this moves six
  downstream tasks" and let a human decide.
- **`findResourceConflicts`** — overlapping assignments and capacity shortfalls, flagged rather
  than automatically resolved, and annotated with which tasks can absorb the conflict.
- **`calculateProgressVariance`** — earned value: performance factor, forecast at completion, and
  variance against a frozen baseline, aggregated per resource type.
- **`captureBaseline`** — freeze the plan so variance measures against what was committed rather
  than against a since-revised estimate.
- **`validate`** — one authoritative rule set, including dependency-cycle detection. Mirror it in
  your client rather than hand-writing a second copy that drifts.
- **`WorkingWeekCalendar`** — working days, split shifts, holidays and one-off exceptions, with
  time zones resolved per instant so schedules stay correct across daylight-saving transitions.
  A continuous 24/7 calendar ships as the default.

## The model in brief

Tasks carry a `basis` naming which quantity their author typed. With `basis: 'effort'`, work is
held constant, so adding people shortens the task. With `basis: 'duration'`, the window is held
constant, so adding people consumes more work. Both kinds coexist on one schedule — some work is
resource-driven and some is fixed by physics or by a third party — and a project-wide switch would
force one of them to be modelled dishonestly.

Working hours are the cardinal unit throughout. Work units are an authoring surface, and days are a
display surface derived from the actual scheduled span rather than from dividing by a nominal day
length, since day length varies between calendars.

Zero-duration tasks are milestones. There is no separate flag, so a task cannot claim to be a
milestone and carry a duration at the same time.

## Documentation

Full design rationale, the research behind the scope, and the reasoning for each decision are in
[docs/DESIGN.md](https://github.com/handyhandymanadam/gantt-schedule-engine/blob/main/docs/DESIGN.md).

## Licence

MIT.
