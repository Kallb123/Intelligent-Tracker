/**
 * Wall-clock times in the household's zone <-> instants, for the web editor's date and time inputs and for reminder text.
 * A browser input has no zone, but a timed task is stored as an instant, and it must mean the
 * same wall time for everyone in the household whatever zone their device is set to.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsOf(instantMs: number, timeZone: string): Record<string, number> {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      // 'h23' avoids midnight rendering as "24" in some engines.
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return Object.fromEntries(f.formatToParts(instantMs).map((p) => [p.type, Number(p.value)]));
}

/** How far the zone's wall clock is ahead of UTC at this instant, in milliseconds. */
function offsetMs(instantMs: number, timeZone: string): number {
  const p = partsOf(instantMs, timeZone);
  const wall = Date.UTC(
    p['year'] as number,
    (p['month'] as number) - 1,
    p['day'] as number,
    p['hour'] as number,
    p['minute'] as number,
    p['second'] as number,
  );
  return wall - Math.floor(instantMs / 1000) * 1000;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

/**
 * The instant at which the clocks in `timeZone` read `date` (`YYYY-MM-DD`) `time` (`HH:MM`), or
 * undefined for input that is not a real date and time. A time skipped by a clock change (01:30
 * on the spring-forward night) lands an hour later; an ambiguous one (01:30 when the clocks go
 * back) takes the later of its two occurrences.
 */
export function wallToInstant(date: string, time: string, timeZone: string): Date | undefined {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t) return undefined;
  const [year, month, day, hour, minute] = [d[1], d[2], d[3], t[1], t[2]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Date.UTC rolls impossible values over (30 February, 25:00), which a round trip exposes.
  if (
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() !== month - 1 ||
    wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute
  ) {
    return undefined;
  }
  // The offset depends on the instant, which is what we are looking for: guess, then correct.
  const guess = wall.getTime() - offsetMs(wall.getTime(), timeZone);
  return new Date(wall.getTime() - offsetMs(guess, timeZone));
}

/** The wall date (`YYYY-MM-DD`) and time (`HH:MM`) in `timeZone` at an instant. */
export function instantToWall(
  instant: Date | string,
  timeZone: string,
): { date: string; time: string } {
  const p = partsOf(new Date(instant).getTime(), timeZone);
  const pad = (n: number | undefined, width = 2): string => String(n).padStart(width, '0');
  return {
    date: `${pad(p['year'], 4)}-${pad(p['month'])}-${pad(p['day'])}`,
    time: `${pad(p['hour'])}:${pad(p['minute'])}`,
  };
}
