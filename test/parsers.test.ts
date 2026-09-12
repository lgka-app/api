import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPdf } from "../src/lib/pdf";
import { buildClassIndex, parseSchedulePage } from "../src/parsers/schedule";
import { parseNewsArticle, parseNewsList, sortNewestFirst } from "../src/parsers/news";
import { mergeEvents, parseWeekHtml } from "../src/parsers/events";
import { mapOpenMeteo, windowHourly } from "../src/parsers/weather";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);
const gold = (...p: string[]) => JSON.parse(readFileSync(join(__dirname, "goldens", ...p), "utf8"));
const read = (...p: string[]) => readFileSync(fx(...p), "utf8");

describe("schedule page scrape", () => {
  for (const g of readdirSync(join(__dirname, "goldens", "schedule")).filter((f) => f.startsWith("stundenplan_page_"))) {
    it(`${g} matches golden`, () => {
      const golden = gold("schedule", g);
      const items = parseSchedulePage(read("schedule", golden.input.file.split("/").pop()));
      expect(items.length).toBe(golden.expected.length);
      items.forEach((item, i) => {
        const exp = golden.expected[i];
        expect(item.title).toBe(exp.title);
        expect(item.url).toBe(exp.url);
        expect(item.fullUrl).toBe(exp.fullUrl);
        expect(item.halbjahr).toBe(exp.halbjahr);
        // The app cannot classify the separate J11 / J12 exports ("Unbekannt"); we can.
        if (exp.gradeLevel !== "Unbekannt") expect(item.gradeLevel).toBe(exp.gradeLevel);
        else expect(["J11", "J12"]).toContain(item.gradeLevel);
      });
    });
  }
});

describe("class index", () => {
  for (const g of readdirSync(join(__dirname, "goldens", "schedule")).filter((f) => f.startsWith("class_index_"))) {
    it(`${g} matches golden (app stores pageIndex + 2, we store the 1-based page)`, async () => {
      const golden = gold("schedule", g);
      const doc = await readPdf(new Uint8Array(readFileSync(fx("schedule", golden.input.file.split("/").pop()))));
      expect(doc.pageCount).toBe(golden.input.pageCount);
      const index = buildClassIndex(doc.pages.map((p) => p.text));
      const ours5to10: Record<string, number> = {};
      for (const [k, v] of Object.entries(index)) if (!k.startsWith("j")) ours5to10[k] = v + 1;
      expect(ours5to10).toEqual(golden.expected.classIndex5to10);
      if (g.includes("j11j12")) expect(index).toMatchObject({ j11: 1, j12: 2 });
      if (/_11_/.test(g)) expect(index.j11).toBe(1);
      if (/_12_/.test(g)) expect(index.j12).toBe(1);
    });
  }
});

describe("news", () => {
  for (const mf of readdirSync(fx("news")).filter((f) => f.startsWith("manifest_")).sort()) {
    it(`${mf} matches golden`, () => {
      const manifest = JSON.parse(read("news", mf));
      const stamp = mf.replace("manifest_", "").replace(".json", "");
      const golden = gold("news", `news_${stamp}.json`).expected as Record<string, unknown>[];
      const files = new Map<string, string>(manifest.articles.map((a: { url: string; file: string }) => [a.url, a.file]));

      const list = parseNewsList(read("news", manifest.listFile));
      const articles = sortNewestFirst(list.map((m) => ({ ...m, ...parseNewsArticle(read("news", files.get(m.url)!)) })));

      expect(articles.map((a) => a.title)).toEqual(golden.map((g) => g.title));
      articles.forEach((a, i) => {
        const g = golden[i]!;
        expect(a.author).toBe(g.author);
        expect(a.description).toBe(g.description);
        expect(a.createdDate).toBe(g.created_date);
        expect(a.views).toBe(g.views);
        expect(a.url).toBe(g.url);
        expect(a.tags).toEqual(g.tags);
        expect(a.links).toEqual(g.links);
        expect(a.standaloneLinks).toEqual(g.standalone_links);
        expect(a.downloads.map((d) => dropNulls({ title: d.title, url: d.url, file_type: d.fileType, size: d.size }))).toEqual(g.downloads);
        // the app's toJson omits null keys
        expect(a.images.map((im) => dropNulls({ url: im.url, thumbnail_url: im.thumbnailUrl, alt: im.alt }))).toEqual(g.images);
        // the app's text extraction glues words across <br>; we insert a space
        expect(norm(a.content)?.replace(/\s+/g, "")).toBe(norm(g.content as string | null)?.replace(/\s+/g, ""));
        expect(norm(a.htmlContent)).toBe(norm(g.html_content as string | null));
        // upgrade over the app: German long dates are parsed
        expect(a.publishedAt, a.title).toMatch(/^\d{4}-\d{2}-\d{2}/);
        expect(a.id, a.title).toBeTypeOf("number");
      });
    });
  }
});

describe("events", () => {
  for (const mf of readdirSync(fx("events")).filter((f) => f.startsWith("manifest_")).sort()) {
    it(`${mf} matches golden`, () => {
      const manifest = JSON.parse(read("events", mf));
      const stamp = mf.replace("manifest_", "").replace(".json", "");
      const golden = gold("events", `events_${stamp}.json`);
      const today = golden.params.today as string;
      const events = mergeEvents(manifest.weeks.map((w: { file: string }) => parseWeekHtml(read("events", w.file), today)));
      expect(events).toEqual(
        golden.expected.map((e: { date: string; time: string | null; title: string }) => ({ date: e.date.slice(0, 10), time: e.time, title: e.title })),
      );
    });
  }
});

describe("weather", () => {
  for (const g of readdirSync(join(__dirname, "goldens", "weather")).sort()) {
    it(`${g} matches golden`, () => {
      const golden = gold("weather", g);
      const data = mapOpenMeteo(JSON.parse(read("weather", golden.input.file.split("/").pop())));
      const iso = (s: string) => (s.length === 16 ? `${s}:00.000` : s);
      expect({ ...data.current, dt: iso(data.current.dt) }).toEqual(golden.expected.current);
      const hourly = windowHourly(data.hourly, golden.params.referenceNow).map((h) => ({ ...h, dt: iso(h.dt) }));
      expect(hourly).toEqual(golden.expected.hourly);
      expect(data.daily.map((d) => ({ ...d, dt: `${d.dt}T00:00:00.000`, sunrise: iso(d.sunrise), sunset: iso(d.sunset) }))).toEqual(golden.expected.daily);
      expect(data.hourly.length).toBe(72);
    });
  }
});

function dropNulls<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as Partial<T>;
}

function norm(s: string | null): string | null {
  if (s == null) return s;
  return s.replace(/&nbsp;| /g, " ").replace(/\s+/g, " ").replace(/\s+</g, "<").replace(/>\s+/g, ">").trim();
}
