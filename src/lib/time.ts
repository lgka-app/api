/** Europe/Berlin wall-clock helpers (Workers run in UTC). */
export interface BerlinTime {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  minute: number;
  minutesSinceMidnight: number;
  /** Mon..Sun */
  weekday: string;
  isWeekend: boolean;
  /** YYYY-MM-DDTHH:MM (local, no offset) — Open-Meteo's format. */
  local: string;
}

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

export function berlinTime(d: Date = new Date()): BerlinTime {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value])) as Record<string, string>;
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  const date = `${p.year}-${p.month}-${p.day}`;
  return {
    date,
    hour,
    minute,
    minutesSinceMidnight: hour * 60 + minute,
    weekday: p.weekday!,
    isWeekend: p.weekday === "Sat" || p.weekday === "Sun",
    local: `${date}T${p.hour}:${p.minute}`,
  };
}

/** Adds whole days to a YYYY-MM-DD string. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const nowIso = (): string => new Date().toISOString();

export function minutesSince(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : (now - t) / 60_000;
}
