import { describe, expect, it } from 'vitest'
import { hostOffset, localUtcOffsetMinutes, offsetForZone } from '../src/timezone.js'
import { WorkingWeekCalendar } from '../src/working-week.js'

const at = (iso: string): Date => new Date(iso)
const iso = (date: Date): string => date.toISOString().slice(0, 16).replace('T', ' ')

describe('offsetForZone', () => {
  it('resolves a fixed-offset zone', () => {
    const utc = offsetForZone('UTC')
    expect(utc(at('2026-01-15T12:00:00Z'))).toBe(0)
  })

  it('resolves a zone west of UTC as negative', () => {
    const newYork = offsetForZone('America/New_York')
    expect(newYork(at('2026-01-15T12:00:00Z'))).toBe(-300) // EST, UTC-5
  })

  it('resolves a zone east of UTC as positive', () => {
    const oslo = offsetForZone('Europe/Oslo')
    expect(oslo(at('2026-01-15T12:00:00Z'))).toBe(60) // CET, UTC+1
  })

  it('follows a daylight-saving transition', () => {
    const newYork = offsetForZone('America/New_York')
    // US daylight saving begins on 8 March 2026.
    expect(newYork(at('2026-03-07T12:00:00Z'))).toBe(-300) // EST
    expect(newYork(at('2026-03-09T12:00:00Z'))).toBe(-240) // EDT
    expect(newYork(at('2026-07-15T12:00:00Z'))).toBe(-240)
    expect(newYork(at('2026-12-15T12:00:00Z'))).toBe(-300)
  })

  it('handles a zone with a half-hour offset', () => {
    const kolkata = offsetForZone('Asia/Kolkata')
    expect(kolkata(at('2026-01-15T12:00:00Z'))).toBe(330) // UTC+5:30
  })

  it('handles the southern hemisphere, where the transitions run the other way', () => {
    const sydney = offsetForZone('Australia/Sydney')
    expect(sydney(at('2026-01-15T12:00:00Z'))).toBe(660) // AEDT in January
    expect(sydney(at('2026-07-15T12:00:00Z'))).toBe(600) // AEST in July
  })

  it('rejects an unknown zone rather than silently falling back to UTC', () => {
    expect(() => offsetForZone('Mars/Olympus_Mons')).toThrow()
  })
})

describe('hostOffset and localUtcOffsetMinutes', () => {
  it('agree with each other', () => {
    const instant = at('2026-06-15T12:00:00Z')
    expect(hostOffset(instant)).toBe(localUtcOffsetMinutes(instant))
  })

  it('invert the sign of getTimezoneOffset', () => {
    const instant = at('2026-06-15T12:00:00Z')
    expect(localUtcOffsetMinutes(instant)).toBe(-instant.getTimezoneOffset())
  })
})

describe('WorkingWeekCalendar with a zone resolver', () => {
  const newYorkWeek = new WorkingWeekCalendar({
    utcOffsetMinutes: offsetForZone('America/New_York'),
  })

  it('places the working day correctly in winter', () => {
    // 2026-01-05 is a Monday. 08:00 EST is 13:00 UTC.
    expect(newYorkWeek.isWorkingTime(at('2026-01-05T13:00:00Z'))).toBe(true)
    expect(newYorkWeek.isWorkingTime(at('2026-01-05T12:59:00Z'))).toBe(false)
  })

  it('places the working day correctly in summer, an hour earlier in UTC', () => {
    // 2026-07-06 is a Monday. 08:00 EDT is 12:00 UTC.
    expect(newYorkWeek.isWorkingTime(at('2026-07-06T12:00:00Z'))).toBe(true)
    expect(newYorkWeek.isWorkingTime(at('2026-07-06T11:59:00Z'))).toBe(false)
  })

  it('keeps shifts anchored to local time across a transition', () => {
    // Friday 6 March is EST; the following Monday 9 March is EDT. Both start at 08:00 local,
    // which is 13:00 UTC and 12:00 UTC respectively. A fixed offset gets one of them wrong.
    const beforeFriday = at('2026-03-06T13:00:00Z')
    const afterMonday = at('2026-03-09T12:00:00Z')
    expect(newYorkWeek.isWorkingTime(beforeFriday)).toBe(true)
    expect(newYorkWeek.isWorkingTime(afterMonday)).toBe(true)
    expect(newYorkWeek.isWorkingTime(at('2026-03-09T13:00:00Z'))).toBe(true) // 09:00 EDT
  })

  it('still measures eight-hour days on either side of a transition', () => {
    expect(
      newYorkWeek.workingHoursBetween(at('2026-03-06T13:00:00Z'), at('2026-03-06T21:00:00Z')),
    ).toBe(8)
    expect(
      newYorkWeek.workingHoursBetween(at('2026-03-09T12:00:00Z'), at('2026-03-09T20:00:00Z')),
    ).toBe(8)
  })

  it('advances a task across a transition without losing or gaining an hour', () => {
    // Sixteen working hours from Friday morning: eight Friday, eight Monday. Local 16:00 on the
    // Monday is 20:00 UTC because the clocks moved over the weekend.
    const finish = newYorkWeek.addWorkingTime(at('2026-03-06T13:00:00Z'), 16)
    expect(iso(finish)).toBe('2026-03-09 20:00')
  })

  it('demonstrates what a fixed offset gets wrong', () => {
    // The same calendar with a winter offset frozen in place: correct in March, an hour out in
    // July, so a summer shift boundary is misjudged.
    const frozen = new WorkingWeekCalendar({ utcOffsetMinutes: -300 })
    const summerMorning = at('2026-07-06T12:00:00Z') // 08:00 EDT, a working instant

    expect(newYorkWeek.isWorkingTime(summerMorning)).toBe(true)
    expect(frozen.isWorkingTime(summerMorning)).toBe(false) // reads it as 07:00, before the shift
  })

  it('rejects an offset that is neither a number nor a function', () => {
    expect(
      () => new WorkingWeekCalendar({ utcOffsetMinutes: '-05:00' as unknown as number }),
    ).toThrow(TypeError)
  })
})
