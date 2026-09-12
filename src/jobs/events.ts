import type { AppEnv } from "../env";
import { addDays, berlinTime, nowIso } from "../lib/time";
import { mergeEvents, parseWeekHtml, type SchoolEvent } from "../parsers/events";
import { fetchResource, schoolUrl, utf8 } from "../sources/http";
import { getState, putResource, putState } from "../store";
import type { JobResult } from "./types";

export const EVENTS_WEEK_BASE = "/cm3/index.php/termine/week.listevents";
export const WEEKS_TO_FETCH = 3;

export interface EventsData {
  events: SchoolEvent[];
  horizonWeeks: number;
}

interface State {
  lastCheckedAt?: string;
  lastError?: string | null;
}

export function weekUrl(env: AppEnv, date: string): string {
  const [y, m, d] = date.split("-");
  return schoolUrl(env, `${EVENTS_WEEK_BASE}/${y}/${m}/${d}/-?catids=`);
}

export async function refreshEvents(env: AppEnv): Promise<JobResult> {
  const state = (await getState<State>(env, "events")) ?? {};
  const today = berlinTime().date;
  try {
    const pages = await Promise.all(
      Array.from({ length: WEEKS_TO_FETCH }, (_, w) => fetchResource(env, weekUrl(env, addDays(today, w * 7)))),
    );
    const weeks: SchoolEvent[][] = [];
    let failures = 0;
    for (const p of pages) {
      if (p.status !== 200 || !p.bytes) {
        failures++;
        continue;
      }
      weeks.push(parseWeekHtml(utf8(p.bytes), today));
    }
    if (weeks.length === 0) throw new Error("all week pages failed");
    const events = mergeEvents(weeks);
    state.lastCheckedAt = nowIso();
    state.lastError = failures ? `${failures} of ${WEEKS_TO_FETCH} week pages failed` : null;
    await putState(env, "events", state);
    // A partial fetch must not shrink the published list.
    if (failures > 0) return { job: "events", changed: false, error: state.lastError ?? undefined, notes: [`kept previous (${events.length} parsed)`] };
    const put = await putResource(env, "events", { events, horizonWeeks: WEEKS_TO_FETCH } satisfies EventsData);
    return { job: "events", changed: put.changed, hash: put.hash, notes: [`${events.length} upcoming events`] };
  } catch (e) {
    state.lastError = String(e instanceof Error ? e.message : e);
    state.lastCheckedAt = nowIso();
    await putState(env, "events", state);
    return { job: "events", changed: false, error: state.lastError, notes: [] };
  }
}
