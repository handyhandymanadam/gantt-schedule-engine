// A house build, shared with the engine's golden regression fixture.
export const SPECS = [
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

export const PHASES = ['sitework', 'foundation', 'framing', 'envelope', 'mep', 'interior', 'finishes']

const START = new Date('2026-03-02T12:00:00Z') // Monday 07:00 local

const TITLE = (id) =>
  id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())

export function buildSchedule() {
  const labels = new Map()

  const phases = PHASES.map((id) => {
    labels.set(id, TITLE(id))
    return {
      id,
      basis: 'duration',
      resourceCount: 1,
      duration: 0,
      start: START,
      schedulingMode: 'auto',
    }
  })

  const tasks = SPECS.map((spec) => {
    labels.set(spec.id, TITLE(spec.id))
    return {
      id: spec.id,
      basis: 'effort',
      effort: spec.hours * spec.crew,
      resourceCount: spec.crew,
      duration: spec.hours,
      resourceType: spec.trade,
      parentId: spec.phase,
      start: START,
      schedulingMode: spec.id === 'mobilize' ? 'manual' : 'auto',
      percentComplete: spec.phase === 'sitework' ? 100 : spec.phase === 'foundation' ? 45 : 0,
    }
  })

  const links = []
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

  const phaseChain = [
    ['sitework', 'foundation'],
    ['foundation', 'framing'],
    ['framing', 'envelope'],
    ['framing', 'mep'],
    ['mep', 'interior'],
    ['interior', 'finishes'],
  ]
  for (const [source, target] of phaseChain) {
    links.push({ id: `${source}->${target}`, source, target, type: 'FS', lag: 0 })
  }

  return { tasks: [...phases, ...tasks], links, labels }
}
