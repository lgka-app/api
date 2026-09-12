// School calendar (JEvents week list) parser. Port of the app's EventsService.
//
// Each <li class="ev_td_li"> holds an optional "HH:MM Uhr" time and an
// <a class="ev_link_row" href=".../icalrepeat.detail/YYYY/MM/DD/..." title="Title">.

export interface SchoolEvent {
  /** YYYY-MM-DD (Berlin calendar date). */
  date: string;
  /** "HH:MM" or null for all-day events. */
  time: string | null;
  title: string;
}

const LI_RE = /<li\s+class=["']ev_td_li["'][^>]*>([\s\S]*?)<\/li>/gi;
const HREF_RE = /href="[^"]*?\/icalrepeat\.detail\/(\d{4})\/(\d{2})\/(\d{2})\//;
const TITLE_RE = /title="([^"]+)"/;
const TIME_RE = /(\d{1,2}:\d{2})\s*Uhr/;

/** @param today YYYY-MM-DD; events before it are dropped. */
export function parseWeekHtml(html: string, today: string): SchoolEvent[] {
  const events: SchoolEvent[] = [];
  for (const match of html.matchAll(LI_RE)) {
    const li = match[1]!;
    const href = HREF_RE.exec(li);
    if (!href) continue;
    const date = `${href[1]}-${href[2]}-${href[3]}`;
    if (date < today) continue;
    const title = TITLE_RE.exec(li);
    if (!title) continue;
    const text = decodeEntities(title[1]!.trim());
    if (text === "") continue;
    const time = TIME_RE.exec(li)?.[1] ?? null;
    events.push({ date, time: time ? time.padStart(5, "0") : null, title: text });
  }
  return events;
}

/** Merges several week pages: dedupe by (date, lowercased title), ascending by date. */
export function mergeEvents(weeks: SchoolEvent[][]): SchoolEvent[] {
  const seen = new Set<string>();
  const out: SchoolEvent[] = [];
  for (const week of weeks) {
    for (const e of week) {
      const key = `${e.date}|${e.title.toLowerCase().trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  // stable sort keeps the page order within a day, like the app
  return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.date.localeCompare(b.e.date) || a.i - b.i).map((x) => x.e);
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&auml;/g, "ä")
    .replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü")
    .replace(/&Auml;/g, "Ä")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&szlig;/g, "ß");
}
