# Benchmark: school server vs. api.lgka.app

Generated 2026-09-12T15:57:30.948Z by `tool/benchmark.mjs` (5 runs per scenario, median wall time, warm connections, one client in Germany).
"School" reproduces the request pattern of the shipping Flutter app; on a phone add PDF text extraction and HTML parsing on top of those numbers — the API returns parsed JSON.

| Scenario | School: requests | School: bytes | School: median (min–max) | API: requests | API: bytes | API: median (min–max) | Speed-up |
|---|---|---|---|---|---|---|---|
| **Substitution plans**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions (parsed JSON)</sub> | 2 | 175 KB | 97 ms (82 ms–354 ms) | 1 | 2.8 KB | 52 ms (48 ms–140 ms) | **1.9×** |
| **Substitution plans + PDFs**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions?embed=pdf (JSON with both PDFs inline)</sub> | 2 | 175 KB | 102 ms (97 ms–142 ms) | 1 | 171 KB | 65 ms (62 ms–113 ms) | **1.6×** |
| **News**<br><sub>list page + every article page → /v1/news</sub> | 21 | 126 KB | 4.98 s (4.64 s–5.86 s) | 1 | 18 KB | 55 ms (53 ms–151 ms) | **90.7×** |
| **Timetables**<br><sub>page + HEAD + download per PDF → /v1/schedules (index + page text)</sub> | 7 | 460 KB | 2.41 s (2.30 s–2.51 s) | 1 | 5.3 KB | 49 ms (43 ms–112 ms) | **48.9×** |
| **Calendar**<br><sub>3 JEvents week pages → /v1/events</sub> | 3 | 18 KB | 2.23 s (2.18 s–2.34 s) | 1 | 0.4 KB | 85 ms (64 ms–221 ms) | **26.3×** |
| **Weather**<br><sub>Open-Meteo direct → /v1/weather</sub> | 1 | 1.5 KB | 26 ms (26 ms–139 ms) | 1 | 1.6 KB | 121 ms (55 ms–132 ms) | **0.2×** |
| **App cold start (all of the above in parallel)**<br><sub>everything above at once → /v1/sync without hashes</sub> | 34 | 428 KB | 7.09 s (5.52 s–10.20 s) | 1 | 27 KB | 329 ms (203 ms–1.14 s) | **21.6×** |
| **App cold start incl. all PDFs (2 plans + 3 timetables)**<br><sub>everything above at once → /v1/sync?embed=pdf without hashes</sub> | 34 | 428 KB | 7.09 s (5.52 s–10.20 s) | 1 | 568 KB | 110 ms (76 ms–223 ms) | **64.3×** |
| **App launch, nothing changed**<br><sub>everything above at once → /v1/sync with current hashes</sub> | 34 | 428 KB | 7.09 s (5.52 s–10.20 s) | 1 | 0.2 KB | 45 ms (39 ms–55 ms) | **157.6×** |

Bytes are what actually crosses the wire (after Content-Encoding). The API's JSON is zstd/brotli-compressed by Cloudflare; the school's PDFs are served uncompressed (they are Flate-compressed internally, so gzip would only save ~5 %).

## Reading the numbers

* The school's Joomla pages (news, timetable page, calendar) cost 0.7–1 s **each**, and news needs one request per article. That is where a cold start's seconds go; the API answers all of it from one edge read.
* The two substitution PDFs are static files on Apache and already fast. With `embed=pdf` the API inlines both PDFs (base64) into the JSON; Cloudflare's compression takes the base64 back to roughly the raw PDF size, so plan + files is one request of about the same bytes — and it is only transferred when a plan's hash changed.
* Weather: Open-Meteo alone is a single fast API; the Worker adds the school station check and source selection for a few extra milliseconds. Both are well under 100 ms.
* "Nothing changed" is the everyday case: 34 requests and 1.3 MB against the school become one request of about 1 KB.
* Not measured here: PDF text extraction and HTML parsing on the phone, and the school server under load from many phones at 07:30 — both only widen the gap.
