// Failure alerts: e-mail to the owner when something on our side breaks — the
// school website is down, a parser throws, a whole cron run crashes or an API
// request ends in an unhandled 500.
//
// Incidents live in R2 (data/state/alerts.json), so a lasting problem sends one
// alert, a reminder every few hours and one "resolved" mail, never a mail per
// cron tick. Sent through Cloudflare Email Service (binding EMAIL) from
// ALERT_FROM to ALERT_TO. Alerting never throws into the caller.
import type { AppEnv } from "./env";
import type { JobResult } from "./jobs/types";
import { getState, putState } from "./store";

export const ALERT_STATE = "alerts";
/** A job must fail this many runs in a row before it alerts, so a one-off network blip stays quiet. */
export const FAILURES_BEFORE_ALERT = 2;
/** While an incident stays open, remind this often. */
export const REMIND_EVERY_MS = 6 * 60 * 60_000;
/** Instant alerts (crashed cron run, unhandled 500) go out at most this often per kind. */
export const INSTANT_THROTTLE_MS = 60 * 60_000;
/** Instant incidents that have not recurred for this long are closed silently. */
const INSTANT_EXPIRES_MS = 24 * 60 * 60_000;

const DASHBOARD_LOGS = "https://dash.cloudflare.com/084ebcf3b162b9ef5ede07edf8afd14b/workers/services/view/lgka-api/production/observability/logs";

export interface Incident {
  key: string;
  title: string;
  since: string;
  lastSeenAt: string;
  failures: number;
  lastError: string;
  lastNotes: string[];
  alertedAt?: string;
}

export interface AlertState {
  open: Record<string, Incident>;
}

export interface Failure {
  key: string;
  title: string;
  error: string;
  notes: string[];
}

type MailKind = "alert" | "reminder" | "resolved" | "test";

export const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

const HINTS: Record<string, string> = {
  "job:substitutions": "Check that the substitution plan PDFs (v_schueler_heute/morgen) open on the school website with the app login. The HTTP status is in the error.",
  "job:schedules": "Check the Stundenplan page on the school website. A changed page or new PDF names can break link discovery or the class index.",
  "job:news": "Check the news page on the school website. A changed page layout breaks the news parser.",
  "job:events": "Check the Termine / calendar pages on the school website.",
  "job:weather": "Open-Meteo is unreachable and there is no previous forecast to keep.",
  "job:gc": "Cleaning up unreferenced PDFs in R2 failed. Nothing user-facing, but storage grows.",
  "cron:crash": "The whole cron run threw before finishing, so nothing was refreshed. Check the Worker logs.",
  "http:500": "An API request hit an unhandled error. The apps may show errors until this is fixed.",
};

/** Failures in one cron run. Substitutions report per-day fetch errors only in their notes. */
export function failuresFrom(results: JobResult[]): Failure[] {
  const failures: Failure[] = [];
  for (const r of results) {
    const dayErrors = r.job === "substitutions" ? r.notes.filter((n) => n.includes(": error ")) : [];
    const error = r.error ?? (dayErrors.length > 0 ? dayErrors.join("; ") : undefined);
    if (error) failures.push({ key: `job:${r.job}`, title: `${r.job} job failing`, error, notes: r.notes });
  }
  return failures;
}

async function loadState(env: AppEnv): Promise<AlertState> {
  const state = await getState<AlertState>(env, ALERT_STATE);
  return { open: state?.open ?? {} };
}

/** Updates incidents after a cron run and sends alert, reminder and resolved mails. */
export async function evaluateRun(env: AppEnv, results: JobResult[], now = Date.now()): Promise<void> {
  const state = await loadState(env);
  const iso = new Date(now).toISOString();
  const failures = failuresFrom(results);
  const failing = new Set(failures.map((f) => f.key));
  let dirty = false;

  for (const f of failures) {
    const incident: Incident = state.open[f.key] ?? { key: f.key, title: f.title, since: iso, lastSeenAt: iso, failures: 0, lastError: f.error, lastNotes: [] };
    incident.failures += 1;
    incident.lastError = f.error;
    incident.lastNotes = f.notes.slice(0, 12);
    incident.lastSeenAt = iso;
    const firstAlert = !incident.alertedAt && incident.failures >= FAILURES_BEFORE_ALERT;
    const reminder = !!incident.alertedAt && now - Date.parse(incident.alertedAt) >= REMIND_EVERY_MS;
    if ((firstAlert || reminder) && (await sendMail(env, firstAlert ? "alert" : "reminder", incident, now))) incident.alertedAt = iso;
    state.open[f.key] = incident;
    dirty = true;
  }

  const ran = new Set(results.map((r) => `job:${r.job}`));
  for (const [key, incident] of Object.entries(state.open)) {
    const jobRecovered = key.startsWith("job:") && ran.has(key) && !failing.has(key);
    const crashOver = key === "cron:crash"; // this run finished, so the crash is over
    const expired = key.startsWith("http:") && now - Date.parse(incident.lastSeenAt) >= INSTANT_EXPIRES_MS;
    if (!jobRecovered && !crashOver && !expired) continue;
    if (incident.alertedAt && !expired) await sendMail(env, "resolved", incident, now);
    delete state.open[key];
    dirty = true;
  }

  if (dirty) await putState(env, ALERT_STATE, state);
}

/** Alerts right away (throttled per key), for failures outside the per-job flow. */
export async function alertNow(env: AppEnv, key: string, title: string, error: string, now = Date.now()): Promise<void> {
  try {
    const state = await loadState(env);
    const iso = new Date(now).toISOString();
    const incident: Incident = state.open[key] ?? { key, title, since: iso, lastSeenAt: iso, failures: 0, lastError: error, lastNotes: [] };
    incident.failures += 1;
    incident.lastError = error;
    incident.lastSeenAt = iso;
    const due = !incident.alertedAt || now - Date.parse(incident.alertedAt) >= INSTANT_THROTTLE_MS;
    if (due && (await sendMail(env, incident.alertedAt ? "reminder" : "alert", incident, now))) incident.alertedAt = iso;
    state.open[key] = incident;
    await putState(env, ALERT_STATE, state);
  } catch (e) {
    console.log(JSON.stringify({ alerts: "alertNow failed", key, error: errorText(e) }));
  }
}

/** Sends one clearly marked test alert. */
export async function sendTestAlert(env: AppEnv, now = Date.now()): Promise<{ sent: boolean; to: string; messageId?: string; error?: string }> {
  const iso = new Date(now - 17 * 60_000).toISOString();
  const incident: Incident = {
    key: "job:substitutions",
    title: "substitutions job failing",
    since: iso,
    lastSeenAt: new Date(now).toISOString(),
    failures: 3,
    lastError: "today: error HTTP 503; tomorrow: error HTTP 503",
    lastNotes: ["today: error HTTP 503", "tomorrow: error HTTP 503"],
  };
  const result = await deliver(env, "test", incident, now);
  return { to: env.ALERT_TO, ...result };
}

async function sendMail(env: AppEnv, kind: MailKind, incident: Incident, now: number): Promise<boolean> {
  return (await deliver(env, kind, incident, now)).sent;
}

async function deliver(env: AppEnv, kind: MailKind, incident: Incident, now: number): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  const mail = renderMail(kind, incident, now);
  const urgent = kind !== "resolved";
  try {
    const res = await env.EMAIL.send({
      to: env.ALERT_TO,
      from: { email: env.ALERT_FROM, name: "LGKA+ API" },
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: {
        "Auto-Submitted": "auto-generated",
        ...(urgent ? { Importance: "high", Priority: "urgent", "X-Priority": "1 (Highest)" } : {}),
        "X-LGKA-Alert": `${kind}; ${incident.key}`,
      },
    });
    console.log(JSON.stringify({ alerts: "sent", kind, key: incident.key, messageId: res.messageId }));
    return { sent: true, messageId: res.messageId };
  } catch (e) {
    const code = (e as { code?: string }).code;
    console.log(JSON.stringify({ alerts: "send failed", kind, key: incident.key, code, error: errorText(e) }));
    return { sent: false, error: code ? `${code}: ${errorText(e)}` : errorText(e) };
  }
}

// ---- rendering ---------------------------------------------------------------

const berlin = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const when = (iso: string) => `${berlin.format(new Date(iso))} (Berlin)`;

export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} days ${h % 24} h`;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

export function renderMail(kind: MailKind, incident: Incident, now: number): { subject: string; text: string; html: string } {
  const openFor = duration(now - Date.parse(incident.since));
  const label = { alert: "ALERT", reminder: `STILL FAILING (${openFor})`, resolved: "RESOLVED", test: "TEST" }[kind];
  const subject = `[LGKA+ API] ${label}: ${incident.title}`;
  const lead = {
    alert: "Something on the LGKA+ backend is failing. The apps keep serving the last good data until it recovers.",
    reminder: "This problem is still not fixed.",
    resolved: "This problem is fixed. The last run succeeded.",
    test: "This is a test of the failure alert e-mail. Nothing is broken; the details below are an example.",
  }[kind];
  const rows: [string, string][] = [
    ["What", incident.title],
    ["Error", incident.lastError],
    ["Since", `${when(incident.since)}, ${openFor}`],
    ["Failed runs in a row", String(incident.failures)],
    ["Last seen", when(incident.lastSeenAt)],
  ];
  const hint = kind === "resolved" ? null : HINTS[incident.key] ?? null;
  const links: [string, string][] = [
    ["Worker logs", DASHBOARD_LOGS],
    ["Status (admin token)", "https://api.lgka.app/admin/status"],
  ];

  const text = [
    lead,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(hint ? ["", `What to check: ${hint}`] : []),
    ...(incident.lastNotes.length > 0 ? ["", "Last run notes:", ...incident.lastNotes.map((n) => `  - ${n}`)] : []),
    "",
    ...links.map(([k, v]) => `${k}: ${v}`),
    "",
    "Sent automatically by lgka-api (api.lgka.app).",
  ].join("\n");

  const accent = { alert: "#d92d20", reminder: "#d92d20", resolved: "#079455", test: "#2e6fd9" }[kind];
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d2433">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e3e6eb">
<tr><td style="background:${accent};color:#ffffff;padding:16px 24px;font-size:13px;font-weight:600;letter-spacing:.06em">LGKA+ API · ${escape(label)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 8px;font-size:20px">${escape(incident.title)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#3d4657">${escape(lead)}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;border-collapse:collapse">
${rows.map(([k, v]) => `<tr><td style="padding:8px 12px 8px 0;color:#667085;white-space:nowrap;vertical-align:top;border-top:1px solid #eef0f3">${escape(k)}</td><td style="padding:8px 0;border-top:1px solid #eef0f3;${k === "Error" ? "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#b42318" : ""}">${escape(v)}</td></tr>`).join("\n")}
</table>
${hint ? `<p style="margin:20px 0 0;padding:12px 14px;background:#fff8e6;border-radius:8px;font-size:14px;line-height:1.5"><strong>What to check:</strong> ${escape(hint)}</p>` : ""}
${incident.lastNotes.length > 0 ? `<p style="margin:20px 0 6px;font-size:13px;color:#667085">Last run notes</p><pre style="margin:0;padding:12px;background:#f4f5f7;border-radius:8px;font-size:12px;line-height:1.5;white-space:pre-wrap">${escape(incident.lastNotes.join("\n"))}</pre>` : ""}
<p style="margin:20px 0 0;font-size:14px">${links.map(([k, v]) => `<a href="${escape(v)}" style="color:#2e6fd9">${escape(k)}</a>`).join(" · ")}</p>
</td></tr>
<tr><td style="padding:14px 24px;background:#fafbfc;color:#98a2b3;font-size:12px">Sent automatically by lgka-api (api.lgka.app).</td></tr>
</table></body></html>`;

  return { subject, text, html };
}
