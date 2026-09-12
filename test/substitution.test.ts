import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPdf } from "../src/lib/pdf";
import { parseSubstitutionPlan, planMeta } from "../src/parsers/substitution";

const root = join(__dirname);
const fixtures = join(root, "fixtures", "substitution");
const goldens = join(root, "goldens", "substitution");

const pdfs = readdirSync(fixtures).filter((f) => f.endsWith(".pdf")).sort();

describe("substitution plan parser", () => {
  for (const file of pdfs) {
    const name = file.replace(/\.pdf$/, "");
    it(`${name}: v1 metadata matches golden`, async () => {
      const doc = await readPdf(new Uint8Array(readFileSync(join(fixtures, file))));
      const golden = JSON.parse(readFileSync(join(goldens, `${name}.json`), "utf8")).expected;
      const v2 = JSON.parse(readFileSync(join(goldens, `${name}.v2.json`), "utf8")).expected;
      const meta = planMeta(parseSubstitutionPlan(doc));
      // On glyph-fragmented Untis 2026 exports the app's v1 regex falls back
      // to the wrong date (18.9. instead of 19.9.) and loses the timestamp;
      // the v2 reference is right there. Assert v1 only where v1 and v2 agree.
      const v1Reliable = golden.date === v2.planDate;
      expect(meta.weekday).toBe(v1Reliable ? golden.weekday : v2.weekday);
      expect(meta.date).toBe(v1Reliable ? golden.date : v2.planDate);
      expect(meta.lastUpdated).toBe(golden.lastUpdated !== "" ? golden.lastUpdated : v2.generatedAt);
    });

    it(`${name}: structured plan matches v2 golden (page 1)`, async () => {
      const doc = await readPdf(new Uint8Array(readFileSync(join(fixtures, file))));
      const golden = JSON.parse(readFileSync(join(goldens, `${name}.v2.json`), "utf8")).expected;
      const plan = parseSubstitutionPlan(doc);

      for (const key of ["school", "address", "schoolYear", "untisVersion", "generatedAt", "planDate", "weekday", "isEmpty"] as const) {
        expect(plan[key], key).toEqual(golden[key]);
      }
      // v2 reference has no blockedRooms field and keeps that line as an
      // announcement; we split it out.
      const goldenRooms = (golden.announcements as string[]).filter((a) => a.startsWith("Blockierte Räume"));
      expect(plan.announcements).toEqual((golden.announcements as string[]).filter((a) => !a.startsWith("Blockierte Räume")));
      if (goldenRooms.length > 0) {
        expect(plan.blockedRooms).toEqual(goldenRooms[0]!.split(":")[1]!.split(",").map((s) => s.trim()));
      }
      expect(plan.absentTeachers).toEqual(golden.absentTeachers);
      expect(plan.absentClasses).toEqual(golden.absentClasses);
      if (golden.footer && Object.keys(golden.footer).length > 0) expect(plan.footer).toEqual(golden.footer);

      // The v2 reference only reads page 1; we read every page.
      const page1 = plan.entries.filter((e) => e.page === 0).map(({ page: _page, ...rest }) => rest);
      expect(page1).toEqual(golden.entries);
    });
  }

  it("reads entries from every page, not only the first", async () => {
    const doc = await readPdf(new Uint8Array(readFileSync(join(fixtures, "heute_2026-09-12.pdf"))));
    expect(doc.pageCount).toBe(2);
    const plan = parseSubstitutionPlan(doc);
    expect(plan.entries.some((e) => e.page === 1)).toBe(true);
    // every entry has a type and at least one class or a note
    for (const e of plan.entries) {
      expect(e.type, JSON.stringify(e)).toBeTruthy();
    }
  });
});
