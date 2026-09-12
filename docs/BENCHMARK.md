# Benchmark: school server vs. api.lgka.app

Generated 2026-09-12T18:56:39.531Z by `tool/benchmark.mjs` (5 runs per scenario, median wall time, warm connections, one client in Germany).
"School" reproduces the request pattern of the shipping Flutter app; on a phone add PDF text extraction and HTML parsing on top of those numbers — the API returns parsed JSON.

| Scenario | School: requests | School: bytes | School: median (min–max) | API: requests | API: bytes | API: median (min–max) | Speed-up |
|---|---|---|---|---|---|---|---|
| **Substitution plans**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions (parsed JSON)</sub> | 2 | 175 KB | 106 ms (102 ms–747 ms) | 1 | 2.8 KB | 74 ms (56 ms–229 ms) | **1.4×** |
| **Substitution plans + PDFs**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions?embed=pdf (JSON with both PDFs inline)</sub> | 2 | 175 KB | 105 ms (89 ms–136 ms) | 1 | 170 KB | 80 ms (72 ms–175 ms) | **1.3×** |
| **News**<br><sub>list page + every article page → /v1/news</sub> | 21 | 133 KB | 6.01 s (5.82 s–7.44 s) | 1 | 18 KB | 79 ms (70 ms–181 ms) | **76.6×** |
| **Timetables**<br><sub>page + HEAD + download per PDF → /v1/schedules (index + page text)</sub> | 7 | 460 KB | 2.59 s (2.44 s–3.39 s) | 1 | 5.3 KB | 84 ms (65 ms–217 ms) | **30.8×** |
| **Calendar**<br><sub>3 JEvents week pages → /v1/events</sub> | 3 | 19 KB | 2.43 s (2.23 s–2.76 s) | 1 | 0.4 KB | 69 ms (62 ms–398 ms) | **35.0×** |
| **Weather**<br><sub>Open-Meteo direct → /v1/weather</sub> | 1 | 1.4 KB | 32 ms (26 ms–245 ms) | 1 | 1.6 KB | 90 ms (56 ms–112 ms) | **0.4×** |
| **App cold start (all of the above in parallel)**<br><sub>everything above at once → /v1/sync without hashes</sub> | 34 | 789 KB | 7.21 s (6.87 s–8.52 s) | 1 | 27 KB | 108 ms (61 ms–238 ms) | **66.9×** |
| **App cold start incl. all PDFs (2 plans + 3 timetables)**<br><sub>everything above at once → /v1/sync?embed=pdf without hashes</sub> | 34 | 789 KB | 7.21 s (6.87 s–8.52 s) | 1 | 569 KB | 102 ms (98 ms–307 ms) | **70.5×** |
| **App launch, nothing changed**<br><sub>everything above at once → /v1/sync with current hashes</sub> | 34 | 789 KB | 7.21 s (6.87 s–8.52 s) | 1 | 0.2 KB | 74 ms (57 ms–105 ms) | **96.9×** |

Bytes are what actually crosses the wire (after Content-Encoding). The API's JSON is zstd/brotli-compressed by Cloudflare; the school's PDFs are served uncompressed (they are Flate-compressed internally, so gzip would only save ~5 %).

## Reading the numbers

* The school's Joomla pages (news, timetable page, calendar) cost 0.7–1 s **each**, and news needs one request per article. That is where a cold start's seconds go; the API answers all of it from one edge read.
* The two substitution PDFs are static files on Apache and already fast. With `embed=pdf` the API inlines both PDFs (base64) into the JSON; Cloudflare's compression takes the base64 back to roughly the raw PDF size, so plan + files is one request of about the same bytes — and it is only transferred when a plan's hash changed.
* Weather: Open-Meteo alone is a single fast API; the Worker adds the school station check and source selection for a few extra milliseconds. Both are well under 100 ms.
* "Nothing changed" is the everyday case: 34 requests and 1.3 MB against the school become one request of about 1 KB.
* Not measured here: PDF text extraction and HTML parsing on the phone, and the school server under load from many phones at 07:30 — both only widen the gap.
