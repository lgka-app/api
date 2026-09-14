# LGKA+ API

Cloudflare Worker behind **https://api.lgka.app** that mirrors, parses and
hash-syncs everything the LGKA+ apps show for the Lessing-Gymnasium Karlsruhe:
substitution plans, timetables, news, calendar and weather.

The phones used to fetch and parse all of this themselves — 15 to 25 requests
to the school's Joomla host per app launch, PDF text extraction on device, and
three codebases (Flutter, Swift, Kotlin) re-implementing the same scrapers.
Now one Worker does it once, and every client asks a single question:
*"here are the hashes I have — what changed?"*

```
GET /v1/sync?substitutions=9c0f…&news=a41b…&weather=&schedules=77e2…&events=1f9a…
→ { substitutions: {status:"fresh"}, news: {status:"fresh"},
    weather: {status:"updated", hash:"…", data:{…}}, … }
```

## What it serves

| Resource | Source | Refresh | Contents |
|---|---|---|---|
| `substitutions` | `v_schueler_heute.pdf`, `v_schueler_morgen.pdf` (Basic Auth) | every minute on school days 06–16h, else 5–30 min | fully structured Untis plan per day (entries with class/period/subject/room/teacher/note, announcements, absences, blocked rooms), v1 metadata (`weekday`, `date`, `lastUpdated`), per-page text, mirrored PDF |
| `schedules` | `/unterricht/stundenplan` page + PDFs | hourly, download only on change | links with `halbjahr`/`gradeLevel`, availability, class → page index, per-page text, mirrored PDFs |
| `news` | `/neues` list + article pages | 15 min (article bodies at most every 6 h) | field-compatible with the app's `NewsEvent`: cleaned HTML + text, embedded/standalone links, images, downloads, tags, `publishedAt` |
| `events` | JEvents week list, 3 weeks | hourly | `{date, time, title}` deduplicated and sorted |
| `weather` | **school rooftop station** (`/wetter/lg_wetter_heute.csv`), Open-Meteo forecast + fallback | 10 min | `source: "school" \| "open-meteo"`, current conditions, 72 h hourly, 3-day daily, station block with health + today's readings |
| `kollegium` | public staff page `/ansprechpartner/kollegium` | once a day (retry after 3 h on failure) | staff index: Untis code → name, title, subjects, role. Sync opt-in, see below |

All parsers are verified against the golden fixtures that used to live in the
[verification harness](https://github.com/lgka-app/verification); this repo is
now their home (`test/fixtures`, `test/goldens`, and the Rust comparator in
`tool/compare-report`). `npm test` runs the field-level checks; `npm run parity`
dumps the parsers' output in golden shape and renders `build/parity/report.html`
with a strict equality diff (exit 0 only on full parity). Native ports can be
gated the same way with `--kotlin DIR` / `--swift DIR`.

### Weather source selection

The station is used for current conditions only while it is **healthy**: the
CSV's `Last-Modified` is younger than 20 minutes and its row count matches the
minute of the day (it appends one row per minute since midnight). Otherwise
`source` flips to `open-meteo`; the station block still reports `healthy:false`
and the `reason`. Every refresh re-evaluates, so the station takes over again
by itself once it works. Forecast (`hourly`, `daily`) is always Open-Meteo.

## API

Every `/v1/*` route requires HTTP Basic Auth with the school's shared
*Vertretungsplan* credentials — the same ones users type at onboarding. There
is no account, token or identifier; the Worker only checks the pair (constant
time) against its secrets. `401` means the school rotated the password.

| Route | Purpose |
|---|---|
| `GET /healthz` | liveness + last-update timestamps (no auth, no content) |
| `GET /v1/auth/check` | `204` when credentials are valid (onboarding) |
| `GET /v1/sync?<resource>=<hash>…[&only=a,b]` | the launch call. Per resource: `fresh` (hash current, no data), `updated` (new `hash` + `data`), `unavailable`. `kollegium` is opt-in: only included when the query names it (`kollegium=<hash>`, empty for the first sync, or `only=`), so older app versions never download it |
| `GET /v1/manifest` | current hashes only |
| `GET /v1/{substitutions\|schedules\|news\|events\|weather\|kollegium}` | one resource; `ETag` = hash, honours `If-None-Match` → `304` |
| `…?embed=pdf` (on `/v1/sync`, `/v1/substitutions`, `/v1/schedules`) | inline the mirrored PDFs as `pdf.base64` so plan + all files is one request — this is what the apps use. `embed=substitutions.pdf` (comma-separated list) restricts it to named resources for clients that want less |
| `GET /v1/files/{sha256}.pdf` | mirrored PDF, content-addressed → `immutable`, `304` on `If-None-Match` |

Hashes are 64-bit prefixes of SHA-256 over canonical JSON. `news` hashes
exclude the volatile view counters so a counter tick is not "new news".

Admin (`Authorization: Bearer <ADMIN_TOKEN>`): `POST /admin/refresh?job=all|substitutions,…`
runs jobs now; `GET /admin/status` shows manifest, per-job state and last results.

### Response shapes (abridged)

```jsonc
// /v1/substitutions → data
{
  "today":    { "source": "v_schueler_heute.pdf",
                "pdf": { "url": "/v1/files/<sha256>.pdf", "sha256": "…", "bytes": 88393, "pageCount": 2 },
                "sourceLastModified": "Fri, 11 Sep 2026 06:56:10 GMT",
                "meta": { "weekday": "Montag", "date": "14.09.2026", "lastUpdated": "11.9.2026 8:56" },
                "plan": { "planDate": "14.09.2026", "weekday": "Montag", "isEmpty": false,
                          "announcements": ["…"], "absentTeachers": ["Xaw (1-3)"], "absentClasses": ["5a"], "blockedRooms": ["PHHS (3-4)"],
                          "entries": [{ "type": "Vertretung", "period": "3", "classes": ["6a"], "classesRaw": "6a",
                                        "substitute": "Xcs", "subject": "Mus", "room": "109",
                                        "originalSubject": "D", "originalTeacher": "Xaw", "originalRoom": "109", "note": null, "page": 0 }],
                          "footer": { "untisPeriod": 1, "date": "14.09.2026", "calendarWeek": 38, "schoolYearShort": "SJ 26/27" } },
                "pages": ["…page text…"] },
  "tomorrow": { … }
}

// /v1/weather → data
{ "source": "open-meteo", "sources": { "current": "open-meteo", "forecast": "open-meteo" },
  "current": { "temp": 24.0, "feelsLike": 23.1, "humidity": 39, "windSpeed": 8.6, "windDeg": 255, "windGust": 23.0,
               "pressure": 1024, "clouds": 16, "visibility": 42560, "uvi": 4.8, "weatherCode": 1, "isDay": true,
               "dt": "2026-09-12T13:00", "provider": "open-meteo" },
  "hourly": [ … 72 × { "dt", "temp", "humidity", "windSpeed", "windDeg", "pop", "weatherCode", "isDay" } ],
  "daily":  [ … 3 × { "dt", "sunrise", "sunset", "tempMax", "tempMin", "pop", "uvi", "windSpeed", "weatherCode" } ],
  "station": { "healthy": false, "reason": "file is 106536 min old", "updatedAt": "2026-06-30T15:29:17.000Z",
               "rows": 29, "latest": null, "today": [], "units": { "windSpeed": "m/s", … } },
  "attribution": ["Wetterdaten: Open-Meteo.com (CC BY 4.0)"] }

// /v1/kollegium → data
{ "updatedAt": "2026-09-14T19:05:00.000Z",          // when the list last changed
  "source": "https://lessing-gymnasium-karlsruhe.de/cm3/index.php/ansprechpartner/kollegium",
  "schoolYear": "2024/2025",                          // null when the page states none
  "staff": [ { "code": "Ro",                          // Untis code, unique
               "lastName": "Roth", "firstName": "Daniel",
               "title": "Dr.",                        // null when none
               "displayName": "Dr. Daniel Roth",
               "subjects": ["M", "Ph"],               // may be empty
               "role": "abteilungsleitung",
               "roleLabel": "Abteilungsleiter",       // page heading of `role`
               "roleLabels": ["Abteilungsleiter"] } ] }  // every heading the person is under
```

`role` is one of `schulleitung`, `stellvertretendeSchulleitung`,
`abteilungsleitung`, `lehrkraft`, `referendar`, `sonstige` (a heading the parser
does not know; decode unknown values as `sonstige`). A person listed under two
headings appears once with the higher role and both labels. The list is only
published with at least 30 people; a failed fetch or parse keeps the previous
one. No e-mail addresses are stored.

Timetable class index values are real 1-based PDF pages (the Flutter app
stored `pageIndex + 2` for a viewer quirk — adapt on the client).

## Efficiency & cost

Measured against the school server ([docs/BENCHMARK.md](docs/BENCHMARK.md), regenerate with `SCHOOL_AUTH=user:pass node tool/benchmark.mjs 5 --md docs/BENCHMARK.md`):
an app cold start drops from 34 requests / ~790 KB / ~7.2 s to 1 request / 27 KB / ~110 ms on the wire (with all five PDFs inlined: ~570 KB / ~100 ms), and a launch where nothing changed to 1 request of ~0.2 KB / ~75 ms. Send `Accept-Encoding` — Cloudflare compresses the JSON (news is 18 KB on the wire, 98 KB decoded).


* One `/v1/sync` per launch; `fresh` answers carry no payload.
* Resources are read from the EU R2 bucket and memoised per isolate for a few
  seconds; JSON is never put into an edge cache. PDFs are served from R2
  through the Cloudflare cache with immutable URLs.
* Upstream is polled with conditional requests; PDFs are re-parsed only when
  their bytes change. The school sees one poller instead of every phone.
* At 500 daily users × 8 launches this stays a few percent inside the Workers
  Paid included limits; egress is free.

## Privacy

* No request logging: Workers invocation logs are disabled
  (`observability.logs.invocation_logs=false`); only cron summaries are logged.
* No cookies, IDs, analytics or per-user state. Auth is a shared secret.
* Everything the Worker persists — parsed resources, the `embed=pdf`
  variants, job state, the cron lock and the mirrored PDFs — lives in one R2
  bucket created with **EU jurisdiction**. Workers KV is not used. The only
  other copy is the Cloudflare edge cache for the content-addressed PDFs,
  which stays in the data centre that served them.
  Superseded PDFs are garbage-collected after two days.
* The Worker validates the Basic Auth credentials itself (constant-time
  comparison against its secrets); no credential sits in firewall rules.
* The school credentials live only in Worker secrets, not in app binaries.

## Development

```bash
npm ci
npx wrangler types      # generates worker-configuration.d.ts
npm run typecheck
npm test                # golden parity for all parsers (offline)
tool/sync-goldens.sh    # refresh fixtures from ../lgka-verification

cp .dev.vars.example .dev.vars   # fill SCHOOL_USERNAME / SCHOOL_PASSWORD / ADMIN_TOKEN
npm run dev
```

Deploy: `npx wrangler deploy` (or push to `main`; CI deploys after tests).
Secrets: `SCHOOL_USERNAME`, `SCHOOL_PASSWORD`, optional
`SCHOOL_PASSWORD_PREVIOUS` (grace period after a rotation), `ADMIN_TOKEN`.

## Layout

```
src/index.ts          Hono app + scheduled() entry
src/routes/           v1 (sync, resources, files) and admin
src/jobs/             one refresh job per resource + scheduler + gc
src/parsers/          substitution (Untis PDF), schedule, news, events, weather, station, kollegium
src/lib/              pdf.js wrapper, hashing, Berlin time
src/store.ts          R2 (EU): data/ manifest, resources, state · files/ PDFs · locks/ cron lock
test/                 vitest; fixtures + goldens copied from the verification harness
```

Part of [lgka-app](https://github.com/lgka-app) · MIT
