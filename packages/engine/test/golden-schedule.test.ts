import { describe, expect, it } from 'vitest'
import { WorkingWeekCalendar } from '../src/working-week.js'
import { offsetForZone } from '../src/timezone.js'
import { calculateCriticalPath } from '../src/critical-path.js'
import { autoSchedule } from '../src/auto-schedule.js'
import { findResourceConflicts } from '../src/resources.js'
import { calculateProgressVariance, captureBaseline } from '../src/variance.js'
import { validate } from '../src/validate.js'
import type { Assignment, Link, Resource, Task } from '../src/types.js'

/**
 * A realistic schedule, computed end to end and snapshotted.
 *
 * The worked examples elsewhere prove individual rules; the property tests explore the space.
 * This exists for the third failure mode: a refactor that quietly changes results everywhere at
 * once while every targeted assertion still passes. If this snapshot moves, something changed
 * that nobody described.
 */

/** Mon-Fri, 07:00-15:30 with a half-hour break, in a zone that observes daylight saving. */
const calendar = new WorkingWeekCalendar({
  week: Object.fromEntries(
    [1, 2, 3, 4, 5].map((day) => [
      day,
      [
        { start: '07:00', end: '11:30' },
        { start: '12:00', end: '15:30' },
      ],
    ]),
  ),
  holidays: ['2026-04-03', '2026-04-06', '2026-05-25'],
  utcOffsetMinutes: offsetForZone('America/New_York'),
})

const START = new Date('2026-03-02T12:00:00Z') // Monday 07:00 EST

interface Spec {
  id: string
  phase: string
  hours: number
  crew: number
  trade: string
  after?: string[]
}

const SPECS: Spec[] = [
  { id: 'mobilize', phase: 'sitework', hours: 8, crew: 2, trade: 'labourer' },
  { id: 'clear-site', phase: 'sitework', hours: 24, crew: 3, trade: 'operator', after: ['mobilize'] },
  { id: 'rough-grade', phase: 'sitework', hours: 16, crew: 2, trade: 'operator', after: ['clear-site'] },
  { id: 'utilities-trench', phase: 'sitework', hours: 24, crew: 3, trade: 'operator', after: ['rough-grade'] },
  { id: 'excavate', phase: 'foundation', hours: 32, crew: 3, trade: 'operator' },
  { id: 'footings-form', phase: 'foundation', hours: 40, crew: 4, trade: 'carpenter', after: ['excavate'] },
  { id: 'footings-rebar', phase: 'foundation', hours: 24, crew: 3, trade: 'ironworker', after: ['footings-form'] },
  { id: 'footings-pour', phase: 'foundation', hours: 12, crew: 4, trade: 'labourer', after: ['footings-rebar'] },
  { id: 'footings-cure', phase: 'foundation', hours: 56, crew: 1, trade: 'labourer', after: ['footings-pour'] },
  { id: 'walls-form', phase: 'foundation', hours: 48, crew: 4, trade: 'carpenter', after: ['footings-cure'] },
  { id: 'walls-pour', phase: 'foundation', hours: 16, crew: 4, trade: 'labourer', after: ['walls-form'] },
  { id: 'walls-strip', phase: 'foundation', hours: 16, crew: 3, trade: 'carpenter', after: ['walls-pour'] },
  { id: 'waterproof', phase: 'foundation', hours: 16, crew: 2, trade: 'labourer', after: ['walls-strip'] },
  { id: 'backfill', phase: 'foundation', hours: 16, crew: 2, trade: 'operator', after: ['waterproof'] },
  { id: 'slab-prep', phase: 'foundation', hours: 24, crew: 3, trade: 'labourer', after: ['backfill'] },
  { id: 'slab-pour', phase: 'foundation', hours: 16, crew: 5, trade: 'labourer', after: ['slab-prep'] },
  { id: 'deck-first', phase: 'framing', hours: 64, crew: 4, trade: 'carpenter' },
  { id: 'walls-first', phase: 'framing', hours: 80, crew: 4, trade: 'carpenter', after: ['deck-first'] },
  { id: 'deck-second', phase: 'framing', hours: 56, crew: 4, trade: 'carpenter', after: ['walls-first'] },
  { id: 'walls-second', phase: 'framing', hours: 72, crew: 4, trade: 'carpenter', after: ['deck-second'] },
  { id: 'roof-trusses', phase: 'framing', hours: 40, crew: 5, trade: 'carpenter', after: ['walls-second'] },
  { id: 'roof-sheath', phase: 'framing', hours: 32, crew: 4, trade: 'carpenter', after: ['roof-trusses'] },
  { id: 'window-install', phase: 'framing', hours: 32, crew: 3, trade: 'carpenter', after: ['roof-sheath'] },
  { id: 'roof-dry-in', phase: 'envelope', hours: 24, crew: 3, trade: 'roofer' },
  { id: 'roof-finish', phase: 'envelope', hours: 48, crew: 3, trade: 'roofer', after: ['roof-dry-in'] },
  { id: 'siding', phase: 'envelope', hours: 64, crew: 3, trade: 'carpenter', after: ['roof-dry-in'] },
  { id: 'exterior-trim', phase: 'envelope', hours: 40, crew: 2, trade: 'carpenter', after: ['siding'] },
  { id: 'plumbing-rough', phase: 'mep', hours: 56, crew: 3, trade: 'plumber' },
  { id: 'electrical-rough', phase: 'mep', hours: 64, crew: 3, trade: 'electrician', after: ['plumbing-rough'] },
  { id: 'hvac-rough', phase: 'mep', hours: 48, crew: 3, trade: 'hvac', after: ['plumbing-rough'] },
  { id: 'mep-inspection', phase: 'mep', hours: 0, crew: 1, trade: 'labourer', after: ['electrical-rough', 'hvac-rough'] },
  { id: 'insulation', phase: 'interior', hours: 32, crew: 3, trade: 'labourer' },
  { id: 'drywall-hang', phase: 'interior', hours: 72, crew: 4, trade: 'drywaller', after: ['insulation'] },
  { id: 'drywall-tape', phase: 'interior', hours: 56, crew: 3, trade: 'drywaller', after: ['drywall-hang'] },
  { id: 'drywall-dry', phase: 'interior', hours: 24, crew: 1, trade: 'labourer', after: ['drywall-tape'] },
  { id: 'prime', phase: 'interior', hours: 32, crew: 3, trade: 'painter', after: ['drywall-dry'] },
  { id: 'interior-trim', phase: 'interior', hours: 64, crew: 3, trade: 'carpenter', after: ['prime'] },
  { id: 'cabinets', phase: 'interior', hours: 48, crew: 2, trade: 'carpenter', after: ['interior-trim'] },
  { id: 'countertops', phase: 'interior', hours: 16, crew: 2, trade: 'carpenter', after: ['cabinets'] },
  { id: 'flooring', phase: 'interior', hours: 56, crew: 3, trade: 'flooring', after: ['interior-trim'] },
  { id: 'paint-finish', phase: 'interior', hours: 48, crew: 3, trade: 'painter', after: ['flooring'] },
  { id: 'plumbing-trim', phase: 'finishes', hours: 24, crew: 2, trade: 'plumber' },
  { id: 'electrical-trim', phase: 'finishes', hours: 32, crew: 2, trade: 'electrician', after: ['plumbing-trim'] },
  { id: 'hvac-trim', phase: 'finishes', hours: 16, crew: 2, trade: 'hvac', after: ['plumbing-trim'] },
  { id: 'appliances', phase: 'finishes', hours: 8, crew: 2, trade: 'labourer', after: ['electrical-trim'] },
  { id: 'final-clean', phase: 'finishes', hours: 16, crew: 3, trade: 'labourer', after: ['appliances', 'hvac-trim'] },
  { id: 'punch-list', phase: 'finishes', hours: 24, crew: 2, trade: 'carpenter', after: ['final-clean'] },
  { id: 'final-inspection', phase: 'finishes', hours: 0, crew: 1, trade: 'labourer', after: ['punch-list'] },
  { id: 'landscaping', phase: 'sitework', hours: 40, crew: 3, trade: 'labourer', after: ['utilities-trench'] },
  { id: 'driveway', phase: 'sitework', hours: 32, crew: 3, trade: 'operator', after: ['landscaping'] },
]

const PHASE_ORDER = ['sitework', 'foundation', 'framing', 'envelope', 'mep', 'interior', 'finishes']

function buildSchedule(): { tasks: Task[]; links: Link[] } {
  const phases: Task[] = PHASE_ORDER.map((id) => ({
    id,
    basis: 'duration',
    resourceCount: 1,
    duration: 0,
    start: START,
    schedulingMode: 'auto',
  }))

  const tasks: Task[] = SPECS.map((spec) => ({
    id: spec.id,
    basis: 'effort',
    effort: spec.hours * spec.crew,
    resourceCount: spec.crew,
    duration: spec.hours,
    resourceType: spec.trade,
    parentId: spec.phase,
    start: START,
    schedulingMode: spec.after === undefined && spec.id === 'mobilize' ? 'manual' : 'auto',
  }))

  const links: Link[] = []
  for (const spec of SPECS) {
    for (const predecessor of spec.after ?? []) {
      links.push({
        id: `${predecessor}->${spec.id}`,
        source: predecessor,
        target: spec.id,
        type: 'FS',
        lag: 0,
      })
    }
  }

  // Phase-level dependencies, carried by boundary nodes.
  links.push(
    { id: 'sitework->foundation', source: 'sitework', target: 'foundation', type: 'FS', lag: 0 },
    { id: 'foundation->framing', source: 'foundation', target: 'framing', type: 'FS', lag: 0 },
    { id: 'framing->envelope', source: 'framing', target: 'envelope', type: 'FS', lag: 0 },
    { id: 'framing->mep', source: 'framing', target: 'mep', type: 'FS', lag: 0 },
    { id: 'mep->interior', source: 'mep', target: 'interior', type: 'FS', lag: 0 },
    { id: 'interior->finishes', source: 'interior', target: 'finishes', type: 'FS', lag: 0 },
  )

  return { tasks: [...phases, ...tasks], links }
}

const CREW: Resource[] = [
  ...times(6, (index) => ({ id: `carp${index}`, type: 'carpenter' })),
  ...times(5, (index) => ({ id: `lab${index}`, type: 'labourer' })),
  ...times(3, (index) => ({ id: `op${index}`, type: 'operator' })),
  ...times(2, (index) => ({ id: `iron${index}`, type: 'ironworker' })),
  ...times(3, (index) => ({ id: `plumb${index}`, type: 'plumber' })),
  ...times(3, (index) => ({ id: `elec${index}`, type: 'electrician' })),
  ...times(2, (index) => ({ id: `hvac${index}`, type: 'hvac' })),
  ...times(3, (index) => ({ id: `roof${index}`, type: 'roofer' })),
  ...times(4, (index) => ({ id: `dry${index}`, type: 'drywaller' })),
  ...times(3, (index) => ({ id: `paint${index}`, type: 'painter' })),
  ...times(3, (index) => ({ id: `floor${index}`, type: 'flooring' })),
]

function times<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index))
}

const iso = (date: Date): string => date.toISOString().slice(0, 16).replace('T', ' ')

describe('golden schedule', () => {
  const { tasks, links } = buildSchedule()

  it('is a valid schedule to begin with', () => {
    const problems = validate({ tasks, links, resources: CREW })
    expect(problems.errors).toEqual([])
  })

  it('has fifty leaf tasks across seven phases', () => {
    expect(SPECS).toHaveLength(50)
    expect(PHASE_ORDER).toHaveLength(7)
  })

  const scheduled = autoSchedule({ tasks, links, calendar })
  const cpm = calculateCriticalPath({ tasks: scheduled.tasks, links, calendar })

  it('produces a stable schedule', () => {
    expect({
      projectStart: iso(cpm.projectStart),
      projectFinish: iso(cpm.projectFinish),
      projectDurationHours: cpm.projectDuration,
      workingDays: Number(
        calendar.countWorkingDays(cpm.projectStart, cpm.projectFinish).toFixed(2),
      ),
      criticalPath: cpm.criticalPath,
      criticalCount: cpm.criticalPath.length,
    }).toMatchSnapshot()
  })

  it('produces stable phase rollups', () => {
    expect(
      cpm.parents.map((parent) => ({
        phase: parent.taskId,
        start: iso(parent.start),
        finish: iso(parent.finish),
        durationHours: parent.duration,
        effort: parent.effort,
        leafCount: parent.leafCount,
      })),
    ).toMatchSnapshot()
  })

  it('produces stable task dates', () => {
    expect(
      cpm.tasks.map((entry) => ({
        id: entry.taskId,
        start: iso(entry.earlyStart),
        finish: iso(entry.earlyFinish),
        totalSlack: Number(entry.totalSlack.toFixed(4)),
        critical: entry.isCritical,
      })),
    ).toMatchSnapshot()
  })

  it('produces stable capacity findings', () => {
    const placement = new Map(
      cpm.tasks.map((entry) => [entry.taskId, { start: entry.earlyStart, finish: entry.earlyFinish }]),
    )
    const conflicts = findResourceConflicts({
      tasks: scheduled.tasks,
      resources: CREW,
      calendar,
      placement,
    })
    expect(
      conflicts.capacityShortfalls.map((entry) => ({
        trade: entry.resourceType,
        from: iso(entry.from),
        to: iso(entry.to),
        demand: entry.demand,
        supply: entry.supply,
        elastic: entry.elasticTaskIds.length,
      })),
    ).toMatchSnapshot()
  })

  it('produces stable earned value once work is under way', () => {
    const baseline = captureBaseline({ tasks: scheduled.tasks, capturedAt: START, calendar })

    // Report progress on the first two phases, with the crew running slightly behind.
    const underway = scheduled.tasks.map((task) => {
      const spec = SPECS.find((entry) => entry.id === task.id)
      if (spec === undefined || (spec.phase !== 'sitework' && spec.phase !== 'foundation')) {
        return task
      }
      const committed = spec.hours * spec.crew
      return { ...task, percentComplete: 60, actualHours: Math.round(committed * 0.7) }
    })

    const variance = calculateProgressVariance({ tasks: underway, calendar, baseline })
    expect({
      overall: round(variance.overall),
      byTrade: variance.byResourceType
        .slice()
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(round),
    }).toMatchSnapshot()
  })

  it('is idempotent over the whole schedule', () => {
    const again = autoSchedule({ tasks: scheduled.tasks, links, calendar })
    expect(again.changes).toEqual([])
  })

  it('never schedules work outside the calendar', () => {
    for (const entry of cpm.tasks) {
      const task = scheduled.tasks.find((candidate) => candidate.id === entry.taskId)!
      if (task.duration === 0) continue
      expect(calendar.isWorkingTime(entry.earlyStart)).toBe(true)
    }
  })
})

function round(group: {
  key: string
  taskCount: number
  baselineEffort: number
  earned: number
  actualHours: number
  forecastEffort: number
  effortVariance: number
  performanceFactor?: number
  percentComplete: number
}): Record<string, number | string | undefined> {
  return {
    key: group.key,
    taskCount: group.taskCount,
    baselineEffort: group.baselineEffort,
    earned: Number(group.earned.toFixed(2)),
    actualHours: group.actualHours,
    forecastEffort: Number(group.forecastEffort.toFixed(2)),
    effortVariance: Number(group.effortVariance.toFixed(2)),
    performanceFactor:
      group.performanceFactor === undefined ? undefined : Number(group.performanceFactor.toFixed(4)),
    percentComplete: Number(group.percentComplete.toFixed(2)),
  }
}
