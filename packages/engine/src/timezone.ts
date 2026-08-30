/**
 * Resolving wall-clock time to instants.
 *
 * A working week is expressed in local wall-clock terms - "08:00 to 16:00, Monday to Friday" -
 * but a schedule is made of instants. Something has to map between them, and a single fixed
 * offset is only correct until the next daylight-saving transition. A schedule six months out
 * is exactly the case where that breaks.
 *
 * So the offset is resolved *per instant*. Pass a plain number for a zone that genuinely has no
 * DST, or one of the resolvers here for one that does.
 */

/** Minutes east of UTC at a given instant. Positive is east: UTC+2 is `120`. */
export type UtcOffsetResolver = (at: Date) => number

/**
 * Offset resolver for an IANA zone such as `'America/New_York'` or `'Europe/London'`.
 *
 * Correct across daylight-saving transitions, because the offset is looked up for each instant
 * rather than sampled once. Built on `Intl`, so there is no dependency to install.
 *
 * Throws immediately if the zone name is not recognised, rather than silently resolving to UTC.
 */
export function offsetForZone(timeZone: string): UtcOffsetResolver {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  return (at: Date): number => {
    const parts = format.formatToParts(at)
    const field = (type: Intl.DateTimeFormatPartTypes): number => {
      const part = parts.find((candidate) => candidate.type === type)
      if (part === undefined) throw new RangeError(`Time zone "${timeZone}" produced no ${type}`)
      return Number(part.value)
    }

    // Reinterpret the zone's wall-clock reading as though it were UTC; the gap between that and
    // the true instant is the offset.
    const asIfUtc = Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      field('hour'),
      field('minute'),
      field('second'),
    )
    return Math.round((asIfUtc - at.getTime()) / 60_000)
  }
}

/**
 * Offset resolver for whichever zone the host is running in - the browser's own setting, or the
 * server's.
 *
 * Correct across daylight-saving transitions, because `getTimezoneOffset` is evaluated for each
 * instant. This is usually what an application wants when the schedule belongs to whoever is
 * looking at it. Prefer {@link offsetForZone} when the schedule belongs to a *place* - a job site
 * keeps its own working hours regardless of where the viewer happens to be.
 */
export const hostOffset: UtcOffsetResolver = (at: Date): number => -at.getTimezoneOffset()

/**
 * The host's offset at one instant, as a plain number.
 *
 * Note the sign. `Date.prototype.getTimezoneOffset` returns minutes to *add to local time to
 * reach UTC*, so UTC+2 reports `-120`; this returns `120`, matching the "minutes east of UTC"
 * convention used throughout. Passing `getTimezoneOffset()` straight through is an easy mistake
 * that puts every shift on the wrong side of UTC.
 *
 * Requires the instant explicitly, because "the current offset" is only meaningful at a moment -
 * which is the whole reason a fixed number is the wrong tool for a schedule crossing a DST
 * boundary. Prefer {@link hostOffset} unless the zone genuinely has no transitions.
 */
export function localUtcOffsetMinutes(at: Date): number {
  return -at.getTimezoneOffset()
}
