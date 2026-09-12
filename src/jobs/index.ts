// Scheduler. One cron tick per minute; each job decides from Berlin time and
// its own last run whether it is due. Jobs run sequentially under a KV lock so
// there is exactly one writer to the manifest at any time.
import type { AppEnv } from "../env";
import { berlinTime, minutesSince, nowIso } from "../lib/time";
import { acquireLock, getState, putState, releaseLock } from "../store";
import { refreshEvents } from "./events";
import { gcFiles } from "./gc";
import { refreshNews } from "./news";
import { refreshSchedules } from "./schedules";
import { refreshSubstitutions } from "./substitutions";
import type { JobResult } from "./types";
import { refreshWeather } from "./weather";

export type JobName = "substitutions" | "schedules" | "news" | "events" | "weather" | "gc";
export const JOB_NAMES: JobName[] = ["substitutions", "weather", "news", "events", "schedules", "gc"];

const RUNNERS: Record<JobName, (env: AppEnv) => Promise<JobResult>> = {
  substitutions: refreshSubstitutions,
  schedules: refreshSchedules,
  news: refreshNews,
  events: refreshEvents,
  weather: refreshWeather,
  gc: gcFiles,
};

/** Minutes between runs, given the Berlin wall clock. */
export function intervalMinutes(job: JobName, t = berlinTime()): number {
  switch (job) {
    case "substitutions":
      if (!t.isWeekend && t.hour >= 6 && t.hour < 16) return 1; // school day: live
      if (!t.isWeekend && t.hour >= 16 && t.hour < 22) return 5; // afternoon edits
      if (t.hour >= 5 && t.hour < 22) return 10;
      return 30;
    case "weather":
      return 10;
    case "news":
      return 15;
    case "events":
      return 60;
    case "schedules":
      return 60;
    case "gc":
      return 24 * 60;
  }
}

interface RunState {
  lastRunAt?: Partial<Record<JobName, string>>;
  lastResult?: Partial<Record<JobName, JobResult & { at: string; ms: number }>>;
}

export async function runDueJobs(env: AppEnv, opts: { force?: JobName[] | "all" } = {}): Promise<{ ran: JobResult[]; skipped: JobName[]; locked?: boolean }> {
  const token = await acquireLock(env, "cron", 120);
  if (!token) return { ran: [], skipped: JOB_NAMES, locked: true };
  try {
    const run = (await getState<RunState>(env, "runs")) ?? {};
    run.lastRunAt ??= {};
    run.lastResult ??= {};
    const t = berlinTime();
    const ran: JobResult[] = [];
    const skipped: JobName[] = [];

    for (const job of JOB_NAMES) {
      const forced = opts.force === "all" || (Array.isArray(opts.force) && opts.force.includes(job));
      const due = forced || minutesSince(run.lastRunAt[job]) >= intervalMinutes(job, t) - 0.25;
      if (!due) {
        skipped.push(job);
        continue;
      }
      const started = Date.now();
      let result: JobResult;
      try {
        result = await RUNNERS[job](env);
      } catch (e) {
        result = { job, changed: false, error: e instanceof Error ? `${e.message}` : String(e), notes: [] };
      }
      run.lastRunAt[job] = nowIso();
      run.lastResult[job] = { ...result, at: run.lastRunAt[job]!, ms: Date.now() - started };
      ran.push(result);
      console.log(JSON.stringify({ job, changed: result.changed, ms: Date.now() - started, error: result.error, notes: result.notes.slice(0, 8) }));
    }
    await putState(env, "runs", run);
    return { ran, skipped };
  } finally {
    await releaseLock(env, "cron", token);
  }
}

export async function getRunState(env: AppEnv): Promise<RunState> {
  return (await getState<RunState>(env, "runs")) ?? {};
}
