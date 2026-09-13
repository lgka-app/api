import { describe, expect, it } from "vitest";
import {
  ALERT_STATE,
  alertNow,
  evaluateRun,
  failuresFrom,
  FAILURES_BEFORE_ALERT,
  INSTANT_THROTTLE_MS,
  REMIND_EVERY_MS,
  renderMail,
  sendTestAlert,
  type AlertState,
} from "../src/alerts";
import type { AppEnv } from "../src/env";
import type { JobResult } from "../src/jobs/types";
import { stateKey } from "../src/store";

type Sent = { to: string; subject: string; text: string; html: string; headers: Record<string, string> };

function fakeEnv(opts: { failSend?: boolean } = {}) {
  const objects = new Map<string, string>();
  const sent: Sent[] = [];
  const env = {
    ALERT_FROM: "api@lgka.app",
    ALERT_TO: "luka@lukaloehr.com",
    FILES: {
      async get(key: string) {
        const text = objects.get(key);
        return text === undefined ? null : { text: async () => text };
      },
      async put(key: string, value: string) {
        objects.set(key, value);
        return {};
      },
    },
    EMAIL: {
      async send(msg: Sent) {
        if (opts.failSend) throw Object.assign(new Error("rate limited"), { code: "E_RATE_LIMIT_EXCEEDED" });
        sent.push(msg);
        return { messageId: `m${sent.length}` };
      },
    },
  } as unknown as AppEnv;
  const state = () => JSON.parse(objects.get(stateKey(ALERT_STATE)) ?? '{"open":{}}') as AlertState;
  return { env, sent, state };
}

const ok = (job: string): JobResult => ({ job, changed: false, notes: [] });
const broken = (job: string, error = "news list HTTP 503"): JobResult => ({ job, changed: false, error, notes: ["kept previous"] });
const MIN = 60_000;

describe("failuresFrom", () => {
  it("treats job errors and substitution day errors as failures, but not a stale weather station", () => {
    const failures = failuresFrom([
      broken("news"),
      { job: "substitutions", changed: false, notes: ["today: error HTTP 503", "tomorrow: 304"] },
      { job: "weather", changed: true, notes: ["source=open-meteo", "station: unhealthy (file is 107953 min old)"] },
      ok("events"),
    ]);
    expect(failures.map((f) => [f.key, f.error])).toEqual([
      ["job:news", "news list HTTP 503"],
      ["job:substitutions", "today: error HTTP 503"],
    ]);
  });
});

describe("evaluateRun", () => {
  it("alerts on the second failing run, reminds after 6 h and sends one resolved mail", async () => {
    const { env, sent, state } = fakeEnv();
    const t0 = Date.parse("2026-09-14T06:00:00Z");

    await evaluateRun(env, [broken("news")], t0);
    expect(sent).toHaveLength(0); // one blip stays quiet
    expect(state().open["job:news"]?.failures).toBe(1);

    await evaluateRun(env, [broken("news")], t0 + 15 * MIN);
    expect(FAILURES_BEFORE_ALERT).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("[LGKA+ API] ALERT: news job failing");
    expect(sent[0]!.headers).toMatchObject({ Importance: "high", Priority: "urgent", "Auto-Submitted": "auto-generated" });
    expect(sent[0]!.text).toContain("Error: news list HTTP 503");
    expect(sent[0]!.to).toBe("luka@lukaloehr.com");

    await evaluateRun(env, [broken("news")], t0 + 30 * MIN);
    expect(sent).toHaveLength(1); // no mail per tick

    await evaluateRun(env, [broken("news")], t0 + 15 * MIN + REMIND_EVERY_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toMatch(/^\[LGKA\+ API\] STILL FAILING \(6 h 15 min\): news job failing$/);

    await evaluateRun(env, [ok("weather")], t0 + 7 * 60 * MIN); // news did not run: stays open
    expect(state().open["job:news"]).toBeDefined();

    await evaluateRun(env, [ok("news")], t0 + 8 * 60 * MIN);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.subject).toBe("[LGKA+ API] RESOLVED: news job failing");
    expect(sent[2]!.headers.Importance).toBeUndefined();
    expect(state().open["job:news"]).toBeUndefined();
  });

  it("closes a single blip silently", async () => {
    const { env, sent, state } = fakeEnv();
    await evaluateRun(env, [broken("events")], 0);
    await evaluateRun(env, [ok("events")], 60 * MIN);
    expect(sent).toHaveLength(0);
    expect(state().open).toEqual({});
  });

  it("retries the alert on the next run when sending fails", async () => {
    const failing = fakeEnv({ failSend: true });
    await evaluateRun(failing.env, [broken("news")], 0);
    await evaluateRun(failing.env, [broken("news")], MIN);
    expect(failing.state().open["job:news"]?.alertedAt).toBeUndefined();
  });
});

describe("alertNow", () => {
  it("alerts immediately, throttles per key and is closed by the next finished cron run", async () => {
    const { env, sent, state } = fakeEnv();
    await alertNow(env, "cron:crash", "Cron run crashed", "TypeError: boom", 0);
    await alertNow(env, "cron:crash", "Cron run crashed", "TypeError: boom", 10 * MIN);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("[LGKA+ API] ALERT: Cron run crashed");
    await alertNow(env, "cron:crash", "Cron run crashed", "TypeError: boom", INSTANT_THROTTLE_MS + MIN);
    expect(sent).toHaveLength(2);

    await evaluateRun(env, [ok("weather")], INSTANT_THROTTLE_MS + 2 * MIN);
    expect(sent.at(-1)!.subject).toBe("[LGKA+ API] RESOLVED: Cron run crashed");
    expect(state().open["cron:crash"]).toBeUndefined();
  });

  it("never throws when sending fails", async () => {
    const { env } = fakeEnv({ failSend: true });
    await expect(alertNow(env, "http:500", "Unhandled API error (HTTP 500)", "boom (GET /v1/sync)", 0)).resolves.toBeUndefined();
  });
});

describe("mail content", () => {
  it("renders subject, text and escaped html", () => {
    const mail = renderMail(
      "alert",
      { key: "job:schedules", title: "schedules job failing", since: "2026-09-14T06:00:00Z", lastSeenAt: "2026-09-14T07:00:00Z", failures: 2, lastError: "schedule page HTTP 500 <html>", lastNotes: ["J11: HTTP 500, keeping previous"] },
      Date.parse("2026-09-14T07:00:00Z"),
    );
    expect(mail.subject).toBe("[LGKA+ API] ALERT: schedules job failing");
    expect(mail.text).toContain("Since: Mo., 14.09.2026, 08:00 (Berlin), 1 h 0 min");
    expect(mail.text).toContain("What to check: Check the Stundenplan page");
    expect(mail.text).toContain("  - J11: HTTP 500, keeping previous");
    expect(mail.html).toContain("schedule page HTTP 500 &lt;html&gt;");
    expect(mail.html).not.toContain("<html>schedule");
  });

  it("sends a test mail marked as TEST", async () => {
    const { env, sent } = fakeEnv();
    const result = await sendTestAlert(env, Date.parse("2026-09-14T07:00:00Z"));
    expect(result).toMatchObject({ sent: true, to: "luka@lukaloehr.com", messageId: "m1" });
    expect(sent[0]!.subject).toBe("[LGKA+ API] TEST: substitutions job failing");
  });
});
