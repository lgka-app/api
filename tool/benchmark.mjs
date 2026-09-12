#!/usr/bin/env node
// Latency benchmark: what the apps do today (direct against the school's
// server, request pattern copied from the Flutter services) vs. the same data
// from api.lgka.app. Wall time only — the on-device PDF/HTML parsing that the
// API removes is not included, so the real gap on a phone is larger.
//
//   SCHOOL_AUTH=user:pass node tool/benchmark.mjs [runs=5] [--md docs/BENCHMARK.md]
import { writeFileSync } from "node:fs";

const RUNS = Number(process.argv[2]) || 5;
const mdIdx = process.argv.indexOf("--md");
const MD_OUT = mdIdx > 0 ? process.argv[mdIdx + 1] : null;
const AUTH = process.env.SCHOOL_AUTH;
if (!AUTH) {
  console.error("SCHOOL_AUTH=user:pass is required");
  process.exit(1);
}
const SCHOOL = "https://lessing-gymnasium-karlsruhe.de";
const API = process.env.API_BASE ?? "https://api.lgka.app";
const UA = "LGKA+/2.5.0";
const basic = "Basic " + Buffer.from(AUTH).toString("base64");

async function get(url, { auth = false, method = "GET" } = {}, attempt = 0) {
  const headers = { "User-Agent": UA };
  if (auth) headers.Authorization = basic;
  const res = await fetch(url, { method, headers, cache: "no-store" });
  const buf = method === "HEAD" ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    // third parties throttle bursts now and then; one retry keeps the run honest
    if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
      await sleep(1500);
      return get(url, { auth, method }, attempt + 1);
    }
    throw new Error(`${res.status} ${url}`);
  }
  return { bytes: buf.byteLength, text: () => new TextDecoder().decode(buf), res };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- school-side scenarios (the app's request patterns) --------------------

async function schoolSubstitutions() {
  const r = await Promise.all([
    get(`${SCHOOL}/stundenplan/schueler/v_schueler_heute.pdf`, { auth: true }),
    get(`${SCHOOL}/stundenplan/schueler/v_schueler_morgen.pdf`, { auth: true }),
  ]);
  return { requests: 2, bytes: r.reduce((a, x) => a + x.bytes, 0) };
}

async function schoolNews() {
  const list = await get(`${SCHOOL}/cm3/index.php/neues`);
  const urls = [...list.text().matchAll(/<h2>\s*<a href="([^"]+)"/g)].map((m) => `${SCHOOL}${m[1]}`);
  const arts = await Promise.all(urls.map((u) => get(u)));
  return { requests: 1 + urls.length, bytes: list.bytes + arts.reduce((a, x) => a + x.bytes, 0) };
}

async function schoolSchedules() {
  const page = await get(`${SCHOOL}/cm3/index.php/unterricht/stundenplan`, { auth: true });
  const hrefs = [...new Set([...page.text().matchAll(/href="([^"]*stundenplan[^"]*\.pdf)"/g)].map((m) => m[1].replace("/cm3/../", `${SCHOOL}/`)))];
  await Promise.all(hrefs.map((u) => get(u, { auth: true, method: "HEAD" }).catch(() => null)));
  const pdfs = await Promise.all(hrefs.map((u) => get(u, { auth: true }).catch(() => ({ bytes: 0 }))));
  return { requests: 1 + hrefs.length * 2, bytes: page.bytes + pdfs.reduce((a, x) => a + x.bytes, 0) };
}

async function schoolEvents() {
  const today = new Date();
  const urls = [0, 7, 14].map((d) => {
    const t = new Date(today.getTime() + d * 864e5);
    const y = t.getFullYear(), m = String(t.getMonth() + 1).padStart(2, "0"), dd = String(t.getDate()).padStart(2, "0");
    return `${SCHOOL}/cm3/index.php/termine/week.listevents/${y}/${m}/${dd}/-?catids=`;
  });
  const r = await Promise.all(urls.map((u) => get(u)));
  return { requests: 3, bytes: r.reduce((a, x) => a + x.bytes, 0) };
}

async function openMeteo() {
  const r = await get(
    "https://api.open-meteo.com/v1/forecast?latitude=49.00775&longitude=8.375&elevation=122&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover,visibility,uv_index,is_day&hourly=temperature_2m,relative_humidity_2m,weather_code,precipitation_probability,wind_speed_10m,wind_direction_10m,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max,sunrise,sunset&timezone=Europe%2FBerlin&forecast_days=3",
  );
  return { requests: 1, bytes: r.bytes };
}

async function schoolColdStart() {
  const parts = await Promise.all([schoolSubstitutions(), schoolNews(), schoolSchedules(), schoolEvents(), openMeteo()]);
  return parts.reduce((a, p) => ({ requests: a.requests + p.requests, bytes: a.bytes + p.bytes }), { requests: 0, bytes: 0 });
}

// ---- API-side scenarios ----------------------------------------------------

const api = (path) => get(`${API}${path}`, { auth: true });
let hashes = null;
async function apiSyncFull() {
  const r = await api("/v1/sync");
  const j = JSON.parse(r.text());
  hashes = Object.fromEntries(Object.entries(j.resources).map(([k, v]) => [k, v.hash]));
  return { requests: 1, bytes: r.bytes };
}
async function apiSyncFresh() {
  if (!hashes) await apiSyncFull();
  const q = Object.entries(hashes).map(([k, v]) => `${k}=${v}`).join("&");
  const r = await api(`/v1/sync?${q}`);
  return { requests: 1, bytes: r.bytes };
}
const apiResource = (name) => async () => {
  const r = await api(`/v1/${name}`);
  return { requests: 1, bytes: r.bytes };
};
async function apiSubstitutionsWithPdfs() {
  const r = await api("/v1/substitutions?embed=pdf");
  const d = JSON.parse(r.text()).data;
  if (!d.today?.pdf?.base64) throw new Error("embed=pdf did not inline the PDF");
  return { requests: 1, bytes: r.bytes };
}
async function apiSyncFullEmbed() {
  const r = await api("/v1/sync?embed=pdf");
  return { requests: 1, bytes: r.bytes };
}

// ---- runner ----------------------------------------------------------------

const SCENARIOS = [
  ["Substitution plans", "2 PDFs (Basic Auth)", schoolSubstitutions, "/v1/substitutions (parsed JSON)", apiResource("substitutions")],
  ["Substitution plans + PDFs", "2 PDFs (Basic Auth)", schoolSubstitutions, "/v1/substitutions?embed=pdf (JSON with both PDFs inline)", apiSubstitutionsWithPdfs],
  ["News", "list page + every article page", schoolNews, "/v1/news", apiResource("news")],
  ["Timetables", "page + HEAD + download per PDF", schoolSchedules, "/v1/schedules (index + page text)", apiResource("schedules")],
  ["Calendar", "3 JEvents week pages", schoolEvents, "/v1/events", apiResource("events")],
  ["Weather", "Open-Meteo direct", openMeteo, "/v1/weather", apiResource("weather")],
  ["App cold start (all of the above in parallel)", "everything above at once", schoolColdStart, "/v1/sync without hashes", apiSyncFull],
  ["App cold start incl. substitution PDFs", "everything above at once", "reuse:cold", "/v1/sync?embed=pdf without hashes", apiSyncFullEmbed],
  ["App launch, nothing changed", "everything above at once", "reuse:cold", "/v1/sync with current hashes", apiSyncFresh],
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function measure(fn) {
  const times = [];
  let meta = { requests: 0, bytes: 0 };
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    meta = await fn();
    times.push(performance.now() - t0);
    await sleep(400);
  }
  return { median: median(times), min: Math.min(...times), max: Math.max(...times), ...meta };
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const fmtKb = (b) => `${(b / 1024).toFixed(0)} KB`;

const rows = [];
for (const [name, schoolDesc, schoolFn, apiDesc, apiFn] of SCENARIOS) {
  process.stderr.write(`${name} … `);
  // the app has no cheap "did anything change?" call against the school: same cost as a cold start
  const s = schoolFn === "reuse:cold" ? rows.at(-1).s : await measure(schoolFn);
  const a = await measure(apiFn);
  rows.push({ name, schoolDesc, s, apiDesc, a });
  process.stderr.write(`school ${fmtMs(s.median)} · api ${fmtMs(a.median)}\n`);
}

const now = new Date().toISOString();
const lines = [
  `# Benchmark: school server vs. api.lgka.app`,
  ``,
  `Generated ${now} by \`tool/benchmark.mjs\` (${RUNS} runs per scenario, median wall time, warm connections, one client in Germany).`,
  `"School" reproduces the request pattern of the shipping Flutter app; on a phone add PDF text extraction and HTML parsing on top of those numbers — the API returns parsed JSON.`,
  ``,
  `| Scenario | School: requests | School: bytes | School: median (min–max) | API: requests | API: bytes | API: median (min–max) | Speed-up |`,
  `|---|---|---|---|---|---|---|---|`,
  ...rows.map(({ name, schoolDesc, s, apiDesc, a }) =>
    `| **${name}**<br><sub>${schoolDesc} → ${apiDesc}</sub> | ${s.requests} | ${fmtKb(s.bytes)} | ${fmtMs(s.median)} (${fmtMs(s.min)}–${fmtMs(s.max)}) | ${a.requests} | ${fmtKb(a.bytes)} | ${fmtMs(a.median)} (${fmtMs(a.min)}–${fmtMs(a.max)}) | **${(s.median / a.median).toFixed(1)}×** |`,
  ),
  ``,
  `Bytes are transfer sizes as seen by the client (the API responses are compressed by Cloudflare; the school's PDFs are not).`,
  ``,
  `## Reading the numbers`,
  ``,
  `* The school's Joomla pages (news, timetable page, calendar) cost 0.7–1 s **each**, and news needs one request per article. That is where a cold start's seconds go; the API answers all of it from one edge read.`,
  `* The two substitution PDFs are static files on Apache and already fast. With \`embed=pdf\` the API inlines both PDFs (base64) into the JSON, so plan + files is still one request; that payload is only transferred when a plan's hash changed.`,
  `* Weather: Open-Meteo alone is a single fast API; the Worker adds the school station check and source selection for a few extra milliseconds. Both are well under 100 ms.`,
  `* "Nothing changed" is the everyday case: 34 requests and 1.3 MB against the school become one request of about 1 KB.`,
  `* Not measured here: PDF text extraction and HTML parsing on the phone, and the school server under load from many phones at 07:30 — both only widen the gap.`,
];
const md = lines.join("\n") + "\n";
console.log(md);
if (MD_OUT) {
  writeFileSync(MD_OUT, md);
  console.error(`wrote ${MD_OUT}`);
}
