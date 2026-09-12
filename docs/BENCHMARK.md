# Benchmark: school server vs. api.lgka.app

Generated 2026-09-12T15:47:26.072Z by `tool/benchmark.mjs` (5 runs per scenario, median wall time, warm connections, one client in Germany).
"School" reproduces the request pattern of the shipping Flutter app; on a phone add PDF text extraction and HTML parsing on top of those numbers — the API returns parsed JSON.

| Scenario | School: requests | School: bytes | School: median (min–max) | API: requests | API: bytes | API: median (min–max) | Speed-up |
|---|---|---|---|---|---|---|---|
| **Substitution plans**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions (parsed JSON)</sub> | 2 | 175 KB | 96 ms (79 ms–213 ms) | 1 | 16 KB | 91 ms (56 ms–156 ms) | **1.1×** |
| **Substitution plans + PDFs**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions?embed=pdf (JSON with both PDFs inline)</sub> | 2 | 175 KB | 101 ms (92 ms–176 ms) | 1 | 249 KB | 69 ms (64 ms–161 ms) | **1.5×** |
| **News**<br><sub>list page + every article page → /v1/news</sub> | 21 | 539 KB | 6.16 s (5.05 s–7.84 s) | 1 | 98 KB | 78 ms (69 ms–209 ms) | **79.2×** |
| **Timetables**<br><sub>page + HEAD + download per PDF → /v1/schedules (index + page text)</sub> | 7 | 474 KB | 3.10 s (2.65 s–3.14 s) | 1 | 16 KB | 55 ms (54 ms–238 ms) | **56.3×** |
| **Calendar**<br><sub>3 JEvents week pages → /v1/events</sub> | 3 | 85 KB | 2.67 s (2.32 s–3.17 s) | 1 | 1 KB | 77 ms (68 ms–165 ms) | **34.6×** |
| **Weather**<br><sub>Open-Meteo direct → /v1/weather</sub> | 1 | 5 KB | 24 ms (21 ms–86 ms) | 1 | 10 KB | 74 ms (67 ms–88 ms) | **0.3×** |
| **App cold start (all of the above in parallel)**<br><sub>everything above at once → /v1/sync without hashes</sub> | 34 | 1277 KB | 7.19 s (5.28 s–10.22 s) | 1 | 141 KB | 58 ms (55 ms–676 ms) | **123.0×** |
| **App cold start incl. substitution PDFs**<br><sub>everything above at once → /v1/sync?embed=pdf without hashes</sub> | 34 | 1277 KB | 7.19 s (5.28 s–10.22 s) | 1 | 982 KB | 121 ms (112 ms–265 ms) | **59.3×** |
| **App launch, nothing changed**<br><sub>everything above at once → /v1/sync with current hashes</sub> | 34 | 1277 KB | 7.19 s (5.28 s–10.22 s) | 1 | 1 KB | 53 ms (48 ms–69 ms) | **135.1×** |

Bytes are transfer sizes as seen by the client (the API responses are compressed by Cloudflare; the school's PDFs are not).

## Reading the numbers

* The school's Joomla pages (news, timetable page, calendar) cost 0.7–1 s **each**, and news needs one request per article. That is where a cold start's seconds go; the API answers all of it from one edge read.
* The two substitution PDFs are static files on Apache and already fast. With `embed=pdf` the API inlines both PDFs (base64) into the JSON, so plan + files is still one request; that payload is only transferred when a plan's hash changed.
* Weather: Open-Meteo alone is a single fast API; the Worker adds the school station check and source selection for a few extra milliseconds. Both are well under 100 ms.
* "Nothing changed" is the everyday case: 34 requests and 1.3 MB against the school become one request of about 1 KB.
* Not measured here: PDF text extraction and HTML parsing on the phone, and the school server under load from many phones at 07:30 — both only widen the gap.
