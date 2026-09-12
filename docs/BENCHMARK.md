# Benchmark: school server vs. api.lgka.app

Generated 2026-09-12T15:59:42.113Z by `tool/benchmark.mjs` (5 runs per scenario, median wall time, warm connections, one client in Germany).
"School" reproduces the request pattern of the shipping Flutter app; on a phone add PDF text extraction and HTML parsing on top of those numbers — the API returns parsed JSON.

| Scenario | School: requests | School: bytes | School: median (min–max) | API: requests | API: bytes | API: median (min–max) | Speed-up |
|---|---|---|---|---|---|---|---|
| **Substitution plans**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions (parsed JSON)</sub> | 2 | 175 KB | 106 ms (71 ms–162 ms) | 1 | 2.8 KB | 64 ms (51 ms–131 ms) | **1.7×** |
| **Substitution plans + PDFs**<br><sub>2 PDFs (Basic Auth) → /v1/substitutions?embed=pdf (JSON with both PDFs inline)</sub> | 2 | 175 KB | 96 ms (85 ms–157 ms) | 1 | 171 KB | 69 ms (64 ms–100 ms) | **1.4×** |
| **News**<br><sub>list page + every article page → /v1/news</sub> | 21 | 126 KB | 5.07 s (4.83 s–5.93 s) | 1 | 18 KB | 76 ms (60 ms–257 ms) | **66.5×** |
| **Timetables**<br><sub>page + HEAD + download per PDF → /v1/schedules (index + page text)</sub> | 7 | 460 KB | 2.40 s (2.36 s–2.53 s) | 1 | 5.3 KB | 69 ms (45 ms–182 ms) | **34.7×** |
| **Calendar**<br><sub>3 JEvents week pages → /v1/events</sub> | 3 | 18 KB | 2.26 s (2.19 s–2.66 s) | 1 | 0.4 KB | 50 ms (44 ms–116 ms) | **45.0×** |
| **Weather**<br><sub>Open-Meteo direct → /v1/weather</sub> | 1 | 1.5 KB | 20 ms (19 ms–82 ms) | 1 | 1.6 KB | 47 ms (45 ms–98 ms) | **0.4×** |
| **App cold start (all of the above in parallel)**<br><sub>everything above at once → /v1/sync without hashes</sub> | 34 | 780 KB | 6.28 s (4.84 s–8.55 s) | 1 | 28 KB | 60 ms (56 ms–202 ms) | **105.0×** |
| **App cold start incl. all PDFs (2 plans + 3 timetables)**<br><sub>everything above at once → /v1/sync?embed=pdf without hashes</sub> | 34 | 780 KB | 6.28 s (4.84 s–8.55 s) | 1 | 567 KB | 137 ms (131 ms–225 ms) | **46.0×** |
| **App launch, nothing changed**<br><sub>everything above at once → /v1/sync with current hashes</sub> | 34 | 780 KB | 6.28 s (4.84 s–8.55 s) | 1 | 0.2 KB | 55 ms (51 ms–93 ms) | **114.2×** |

Bytes are what actually crosses the wire (after Content-Encoding). The API's JSON is zstd/brotli-compressed by Cloudflare; the school's PDFs are served uncompressed (they are Flate-compressed internally, so gzip would only save ~5 %).

## Reading the numbers

* The school's Joomla pages (news, timetable page, calendar) cost 0.7–1 s **each**, and news needs one request per article. That is where a cold start's seconds go; the API answers all of it from one edge read.
* The two substitution PDFs are static files on Apache and already fast. With `embed=pdf` the API inlines both PDFs (base64) into the JSON; Cloudflare's compression takes the base64 back to roughly the raw PDF size, so plan + files is one request of about the same bytes — and it is only transferred when a plan's hash changed.
* Weather: Open-Meteo alone is a single fast API; the Worker adds the school station check and source selection for a few extra milliseconds. Both are well under 100 ms.
* "Nothing changed" is the everyday case: 34 requests and 1.3 MB against the school become one request of about 1 KB.
* Not measured here: PDF text extraction and HTML parsing on the phone, and the school server under load from many phones at 07:30 — both only widen the gap.
