// Writes the API parsers' output over every fixture in the exact shape the
// Dart goldens use, so tool/compare-report (Rust) can diff them and render
// report.html — the same parity gate the native apps used to run.
//
//   npm run parity     (= this file + cargo run)
//
// Where the API deliberately improves on the app's v1/v2 contract, the dump
// projects back to the golden contract (page-1 entries only, "Blockierte
// Räume" kept as an announcement, class index as pageIndex + 2, the app's
// grade-level heuristic) so the comparator stays a strict equality check.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { readPdf } from "../src/lib/pdf";
import { parseSubstitutionPlan } from "../src/parsers/substitution";
import { buildClassIndex, parseSchedulePage } from "../src/parsers/schedule";
import { parseNewsArticle, parseNewsList, sortNewestFirst } from "../src/parsers/news";
import { mergeEvents, parseWeekHtml } from "../src/parsers/events";
import { mapOpenMeteo, windowHourly } from "../src/parsers/weather";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const out = join(__dirname, "..", "build", "parity", "api");
const write = (name: string, value: unknown) => writeFileSync(join(out, `${name}.json`), JSON.stringify(value, null, 2));
const iso = (s: string) => (s.length === 16 ? `${s}:00.000` : s);
const dropNulls = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
const decode = (h: string) =>
  h.replace(/&nbsp;/g, "\u00a0").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** Dart `.text` of each paragraph: tags removed with nothing in their place, entities decoded, trimmed, joined by blank lines. */
const dartText = (html: string) =>
  html
    .split("\n\n")
    .map((para) => decode(para.replace(/<[^>]+>/g, "")).trim())
    .filter((t) => t !== "")
    .join("\n\n");

it("dumps parser output in golden shape", async () => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // substitution v2
  for (const file of readdirSync(fx("substitution")).filter((f) => f.endsWith(".pdf"))) {
    const plan = parseSubstitutionPlan(await readPdf(new Uint8Array(readFileSync(fx("substitution", file)))));
    // v2 stops collecting announcements at the first absence line; a
    // "Blockierte Räume" line only counts as one when no absence lines exist.
    const announcements = [...plan.announcements];
    if (plan.blockedRooms.length && plan.absentTeachers.length === 0 && plan.absentClasses.length === 0) {
      announcements.push(`Blockierte Räume: ${plan.blockedRooms.join(", ")}`);
    }
    write(file.replace(/\.pdf$/, ""), {
      school: plan.school,
      address: plan.address,
      schoolYear: plan.schoolYear,
      untisVersion: plan.untisVersion,
      generatedAt: plan.generatedAt,
      planDate: plan.planDate,
      weekday: plan.weekday,
      isEmpty: plan.isEmpty,
      announcements,
      absentTeachers: plan.absentTeachers,
      absentClasses: plan.absentClasses,
      entries: plan.entries.filter((e) => e.page === 0).map(({ page: _p, ...rest }) => rest),
      footer: plan.footer ?? {},
    });
  }

  // schedule page + class index
  for (const file of readdirSync(fx("schedule"))) {
    if (file.endsWith(".html")) {
      const items = parseSchedulePage(readFileSync(fx("schedule", file), "utf8")).map((i) => ({
        title: i.title,
        url: i.url,
        halbjahr: i.halbjahr,
        gradeLevel: i.gradeLevel === "J11" || i.gradeLevel === "J12" ? "Unbekannt" : i.gradeLevel,
        fullUrl: i.fullUrl,
      }));
      write(file.replace(/\.html$/, ""), items);
    } else if (file.endsWith(".pdf")) {
      const doc = await readPdf(new Uint8Array(readFileSync(fx("schedule", file))));
      const index = buildClassIndex(doc.pages.map((p) => p.text));
      const classIndex5to10: Record<string, number> = {};
      for (const [k, v] of Object.entries(index)) if (!k.startsWith("j")) classIndex5to10[k] = v + 1;
      write(`class_index_${file.replace(/\.pdf$/, "")}`, { classIndex5to10 });
    }
  }

  // news
  for (const mf of readdirSync(fx("news")).filter((f) => f.startsWith("manifest_"))) {
    const manifest = JSON.parse(readFileSync(fx("news", mf), "utf8"));
    const files = new Map<string, string>(manifest.articles.map((a: { url: string; file: string }) => [a.url, a.file]));
    const list = parseNewsList(readFileSync(fx("news", manifest.listFile), "utf8"));
    const articles = sortNewestFirst(list.map((m) => ({ ...m, ...parseNewsArticle(readFileSync(fx("news", files.get(m.url)!), "utf8")) })));
    write(
      `news_${mf.replace("manifest_", "").replace(".json", "")}`,
      articles.map((a) => ({
        title: a.title,
        author: a.author,
        description: a.description,
        // Dart's textContent drops <br> entirely (we emit "\n"); rebuild from the HTML.
        content: a.htmlContent == null ? null : dartText(a.htmlContent),
        // Dart serialises NBSP as &nbsp;; node-html-parser decodes it.
        html_content: a.htmlContent?.replace(/\u00a0/g, "&nbsp;") ?? null,
        created_date: a.createdDate,
        views: a.views,
        url: a.url,
        links: a.links,
        standalone_links: a.standaloneLinks,
        images: a.images.map((i) => dropNulls({ url: i.url, thumbnail_url: i.thumbnailUrl, alt: i.alt })),
        downloads: a.downloads.map((d) => dropNulls({ title: d.title, url: d.url, file_type: d.fileType, size: d.size })),
        tags: a.tags,
        parsed_date: null, // the app never parsed German long dates
      })),
    );
  }

  // events
  for (const mf of readdirSync(fx("events")).filter((f) => f.startsWith("manifest_"))) {
    const manifest = JSON.parse(readFileSync(fx("events", mf), "utf8"));
    const stamp = mf.replace("manifest_", "").replace(".json", "");
    const golden = JSON.parse(readFileSync(join(__dirname, "goldens", "events", `events_${stamp}.json`), "utf8"));
    const events = mergeEvents(manifest.weeks.map((w: { file: string }) => parseWeekHtml(readFileSync(fx("events", w.file), "utf8"), golden.params.today)));
    write(`events_${stamp}`, events.map((e) => ({ date: `${e.date}T00:00:00.000`, time: e.time, title: e.title })));
  }

  // weather
  for (const g of readdirSync(join(__dirname, "goldens", "weather"))) {
    const golden = JSON.parse(readFileSync(join(__dirname, "goldens", "weather", g), "utf8"));
    const data = mapOpenMeteo(JSON.parse(readFileSync(fx("weather", golden.input.file.split("/").pop()), "utf8")));
    write(g.replace(/\.json$/, ""), {
      current: { ...data.current, dt: iso(data.current.dt) },
      hourly: windowHourly(data.hourly, golden.params.referenceNow).map((h) => ({ ...h, dt: iso(h.dt) })),
      daily: data.daily.map((d) => ({ ...d, dt: `${d.dt}T00:00:00.000`, sunrise: iso(d.sunrise), sunset: iso(d.sunset) })),
    });
  }
});
