# Benchmark: school server vs. api.lgka.app

Generated 2026-09-12T15:34:59.998Z by `tool/benchmark.mjs` (5 runs per scenario, median wall time, warm connections, one client in Germany).
"School" reproduces the request pattern of the shipping Flutter app; on a phone add PDF text extraction and HTML parsing on top of those numbers — the API returns parsed JSON.

| Scenario | School: requests | School: bytes | School: median (min–max) | API: requests | API: bytes | API: median (min–max) | Speed-up |
|---|---|---|---|---|---|---|---|
| **Substitution plans**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions (parsed JSON)</sub> | 2 | 175 KB | 102 ms (78 ms–181 ms) | 1 | 16 KB | 58 ms (47 ms–78 ms) | **1.8×** |
| **Substitution plans + PDFs**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions + 2 mirrored PDFs</sub> | 2 | 175 KB | 102 ms (84 ms–145 ms) | 3 | 191 KB | 108 ms (103 ms–153 ms) | **0.9×** |
| **News**<br><sub>list page + every article page → /v1/news</sub> | 21 | 552 KB | 7.27 s (5.89 s–10.48 s) | 1 | 98 KB | 56 ms (52 ms–149 ms) | **130.2×** |
| **Timetables**<br><sub>page + HEAD + download per PDF → /v1/schedules (index + page text)</sub> | 7 | 474 KB | 2.42 s (2.33 s–2.46 s) | 1 | 16 KB | 65 ms (57 ms–192 ms) | **37.1×** |
| **Calendar**<br><sub>3 JEvents week pages → /v1/events</sub> | 3 | 87 KB | 2.26 s (2.18 s–2.80 s) | 1 | 1 KB | 62 ms (53 ms–146 ms) | **36.7×** |
| **Weather**<br><sub>Open-Meteo direct → /v1/weather</sub> | 1 | 5 KB | 26 ms (25 ms–105 ms) | 1 | 10 KB | 54 ms (50 ms–88 ms) | **0.5×** |
| **App cold start (all of the above in parallel)**<br><sub>everything above at once → /v1/sync without hashes</sub> | 34 | 1277 KB | 7.09 s (5.18 s–9.13 s) | 1 | 141 KB | 75 ms (69 ms–320 ms) | **95.0×** |
| **App launch, nothing changed**<br><sub>everything above at once → /v1/sync with current hashes</sub> | 34 | 1277 KB | 7.09 s (5.18 s–9.13 s) | 1 | 1 KB | 70 ms (60 ms–99 ms) | **100.9×** |

Bytes are transfer sizes as seen by the client (the API responses are compressed by Cloudflare; the school's PDFs are not).

## Reading the numbers

* The school's Joomla pages (news, timetable page, calendar) cost 0.7–1 s **each**, and news needs one request per article. That is where a cold start's seconds go; the API answers all of it from one edge read.
* The two substitution PDFs are static files on Apache and already fast. "Substitution plans + PDFs" is the worst case for the API — JSON first, then two PDF downloads — and only happens when a plan's hash changed; the apps show the parsed JSON immediately and can fetch the PDF lazily.
* Weather: Open-Meteo alone is a single fast API; the Worker adds the school station check and source selection for a few extra milliseconds. Both are well under 100 ms.
* "Nothing changed" is the everyday case: 34 requests and 1.3 MB against the school become one request of about 1 KB.
* Not measured here: PDF text extraction and HTML parsing on the phone, and the school server under load from many phones at 07:30 — both only widen the gap.
