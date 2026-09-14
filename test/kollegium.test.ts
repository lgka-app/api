import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncTargets, type AppEnv } from "../src/env";
import { intervalMinutes } from "../src/jobs";
import { MIN_STAFF, refreshKollegium, type KollegiumData } from "../src/jobs/kollegium";
import { berlinTime } from "../src/lib/time";
import { decodeHtml, parseKollegium, parseLine, roleForHeading } from "../src/parsers/kollegium";
import { getManifest, getResource, getState, memoClear } from "../src/store";

// Synthetic staff list (fake names and codes) inside the page's real markup.
const FIXTURE = readFileSync(join(__dirname, "fixtures", "kollegium", "kollegium_2026-09-14.html"), "utf8");

describe("kollegium parser", () => {
  const parsed = parseKollegium(FIXTURE);
  const byCode = new Map(parsed.staff.map((s) => [s.code, s]));

  it("reads every heading group of the page", () => {
    expect(parsed.schoolYear).toBe("2024/2025");
    const counts: Record<string, number> = {};
    for (const s of parsed.staff) counts[s.role] = (counts[s.role] ?? 0) + 1;
    expect(counts).toEqual({ schulleitung: 1, stellvertretendeSchulleitung: 1, abteilungsleitung: 2, lehrkraft: 40, referendar: 5 });
    expect(parsed.skipped).toEqual([]);
    expect(parsed.duplicateCodes).toEqual([]);
    expect(parsed.unknownHeadings).toEqual([]);
  });

  it("keeps page order and the documented fields only (no e-mail)", () => {
    expect(parsed.staff[0]).toEqual({
      code: "Xul",
      lastName: "Sauter",
      firstName: "Ulrike",
      title: "Dr.",
      displayName: "Dr. Ulrike Sauter",
      subjects: ["D", "Gk", "E"],
      role: "schulleitung",
      roleLabel: "Schulleiterin",
      roleLabels: ["Schulleiterin"],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/@|mail/i);
  });

  it("merges a person listed under two headings into the higher role", () => {
    expect(parsed.staff.filter((s) => s.code === "Xre")).toHaveLength(1);
    expect(byCode.get("Xre")).toMatchObject({
      role: "abteilungsleitung",
      roleLabel: "Abteilungsleiter",
      roleLabels: ["Abteilungsleiter", "Lehrerinnen & Lehrer im Schuljahr 2024/2025"],
      displayName: "Dr. Daniel Rothe",
    });
  });

  it("handles titles, double names, entities, missing spaces and trailing whitespace", () => {
    expect(byCode.get("Xdh")).toMatchObject({ lastName: "Dornbach", firstName: "David", title: "Dr." });
    expect(byCode.get("Xif")).toMatchObject({ lastName: "Imhof-Kessel", subjects: ["D", "Gk", "WBS", "Geo"] });
    expect(byCode.get("Xmt")).toMatchObject({ firstName: "Mara-Lena", subjects: ["M", "Ph"] });
    expect(byCode.get("Xfr")).toMatchObject({ lastName: "Fichtner", firstName: "Felix" });
    expect(byCode.get("Xjn")).toMatchObject({ lastName: "Jänsen", displayName: "Jonas Jänsen" });
    expect(byCode.get("XoJ")).toMatchObject({ lastName: "Ohm-Jessen", role: "referendar", roleLabel: "Oberreferendarinnen & -referendare" });
  });

  it("parses single lines robustly", () => {
    expect(parseLine("Roth, Dr. Daniel (M,Ph) Ro")).toMatchObject({ title: "Dr.", firstName: "Daniel", code: "Ro" });
    expect(parseLine("Dr. Roth, Daniel (M) Ro")).toMatchObject({ title: "Dr.", lastName: "Roth" });
    expect(parseLine("Weber, Prof. Dr. Nathalie (M,Ph) Web")).toMatchObject({ title: "Prof. Dr.", displayName: "Prof. Dr. Nathalie Weber" });
    expect(parseLine("Held, Marcus () Hed")).toMatchObject({ subjects: [], code: "Hed" });
    expect(parseLine("Held, Marcus Hed")).toMatchObject({ firstName: "Marcus", subjects: [], code: "Hed" });
    expect(parseLine("Held, Marcus (evRel)")).toBeNull(); // no code: cannot be keyed
    expect(parseLine("Held, Marcus")).toBeNull();
    expect(parseLine("Zur Vereinbarung von Terminen wenden Sie sich an das Sekretariat.")).toBeNull();
    expect(decodeHtml("Lehrerinnen &amp; Lehrer &#228; &#xFC;&nbsp;x")).toBe("Lehrerinnen & Lehrer ä ü x");
  });

  it("reports skipped lines, duplicate codes and unknown groups", () => {
    const html = `<div><p><strong>Schulleiter</strong><br>Muster, Max (D) Mu</p>
      <p><strong>Lehrkräfte</strong><br>Probe, Paula (E) Mu<br>Kaputt ohne Komma<br>Muster, Max (D,E) Mu<br>Beispiel, Bea (M)</p>
      <p><strong>Sekretariat</strong><br>Amt, Anja (-) Amt</p></div><footer><p>Impressum, Seite (x) Imp</p></footer>`;
    const r = parseKollegium(html);
    expect(r.staff.map((s) => [s.code, s.role, s.subjects])).toEqual([
      ["Mu", "schulleitung", ["D", "E"]],
      ["Amt", "sonstige", ["-"]],
    ]);
    expect(r.duplicateCodes).toEqual([{ code: "Mu", names: ["Max Muster", "Paula Probe"] }]);
    expect(r.skipped).toEqual(["Kaputt ohne Komma", "Beispiel, Bea (M)"]);
    expect(r.unknownHeadings).toEqual(["Sekretariat"]);
    expect(r.schoolYear).toBeNull();
  });

  it("maps headings to stable roles", () => {
    expect(roleForHeading("stellvertretende Schulleiterin")).toBe("stellvertretendeSchulleitung");
    expect(roleForHeading("Schulleiter")).toBe("schulleitung");
    expect(roleForHeading("Abteilungsleiterinnen")).toBe("abteilungsleitung");
    expect(roleForHeading("Referendarinnen & Referendare")).toBe("referendar");
    expect(roleForHeading("Neu im Kollegium")).toBe("lehrkraft");
  });
});

describe("kollegium job", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    memoClear();
  });

  function fakeEnv() {
    const objects = new Map<string, string>();
    const env = {
      SCHOOL_BASE_URL: "https://lessing-gymnasium-karlsruhe.de",
      USER_AGENT: "test",
      FILES: {
        async get(key: string) {
          const text = objects.get(key);
          return text === undefined ? null : { text: async () => text };
        },
        async put(key: string, value: string) {
          objects.set(key, value);
          return {};
        },
      },
    } as unknown as AppEnv;
    return { env, objects };
  }
  const serve = (status: number, body: string) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(status === 200 ? body : null, { status })));

  it("publishes once, leaves an unchanged list alone and keeps it through failures", async () => {
    const { env, objects } = fakeEnv();
    serve(200, FIXTURE);
    const first = await refreshKollegium(env);
    expect(first).toMatchObject({ job: "kollegium", changed: true, notes: ["49 staff (schulleitung 1, stellvertretendeSchulleitung 1, abteilungsleitung 2, lehrkraft 40, referendar 5)"] });
    memoClear();
    const stored = await getResource<KollegiumData>(env, "kollegium");
    expect(stored?.data).toMatchObject({ source: "https://lessing-gymnasium-karlsruhe.de/cm3/index.php/ansprechpartner/kollegium", schoolYear: "2024/2025" });
    expect(stored?.data.staff).toHaveLength(49);
    const manifest = await getManifest(env, { fresh: true });
    expect(manifest.kollegium?.hash).toBe(first.hash);

    const writes = objects.get("data/res/kollegium.json");
    const second = await refreshKollegium(env);
    expect(second).toMatchObject({ changed: false, hash: first.hash });
    expect(objects.get("data/res/kollegium.json")).toBe(writes); // updatedAt not bumped

    const tiny = FIXTURE.replace(/<p><strong>Lehrerinnen[\s\S]*?<\/p>/, "");
    serve(200, tiny);
    const broken = await refreshKollegium(env);
    expect(broken.error).toBe(`kollegium parsed 9 staff, below ${MIN_STAFF} (page layout changed?)`);
    expect(objects.get("data/res/kollegium.json")).toBe(writes);

    serve(503, "");
    const down = await refreshKollegium(env);
    expect(down).toMatchObject({ changed: false, error: "kollegium page HTTP 503" });
    expect(objects.get("data/res/kollegium.json")).toBe(writes);
    expect(await getState(env, "kollegium")).toMatchObject({ lastError: "kollegium page HTTP 503", counts: { lehrkraft: 40 } });
  });

  it("runs once a day and retries a failure after 3 h", () => {
    const t = berlinTime(new Date("2026-09-14T08:00:00Z"));
    expect(intervalMinutes("kollegium", t)).toBe(24 * 60);
    expect(intervalMinutes("kollegium", t, true)).toBe(3 * 60);
  });
});

describe("sync targets", () => {
  it("leaves opt-in resources out unless the client names them", () => {
    expect(syncTargets({ substitutions: "abc", news: "" })).toEqual(["substitutions", "schedules", "news", "events", "weather"]);
    expect(syncTargets({ kollegium: "" })).toContain("kollegium");
    expect(syncTargets({ only: "kollegium,news" })).toEqual(["kollegium", "news"]);
  });
});
