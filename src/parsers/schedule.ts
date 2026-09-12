// Schedule ("Stundenplan") page scrape + class → page index for the PDFs.
import { parse } from "node-html-parser";

export interface ScheduleLink {
  title: string;
  /** href exactly as found on the page. */
  url: string;
  fullUrl: string;
  halbjahr: "1. Halbjahr" | "2. Halbjahr" | "Unbekannt";
  /** "Klassen 5-10" | "J11" | "J12" | "J11/J12" | "Unbekannt" */
  gradeLevel: string;
}

const SCHOOL = "https://lessing-gymnasium-karlsruhe.de";

/**
 * Same contract as the app: anchors inside `#mod-custom213` whose href
 * contains "stundenplan", deduplicated by absolute URL, in page order.
 */
export function parseSchedulePage(html: string): ScheduleLink[] {
  const root = parse(html);
  const module = root.querySelector("#mod-custom213");
  if (!module) throw new Error("schedule module #mod-custom213 not found");

  const out: ScheduleLink[] = [];
  const seen = new Set<string>();
  for (const a of module.querySelectorAll('a[href*="stundenplan"]')) {
    const href = a.getAttribute("href");
    const text = a.text.trim();
    const title = text !== "" ? text : (a.getAttribute("title") ?? "");
    if (!href || title === "") continue;

    let fullUrl = href;
    if (href.startsWith("/cm3/../")) fullUrl = href.replace("/cm3/../", `${SCHOOL}/`);
    else if (href.startsWith("/")) fullUrl = `${SCHOOL}${href}`;
    try {
      const u = new URL(fullUrl);
      if (!u.protocol.startsWith("http")) continue;
    } catch {
      continue;
    }
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    const halbjahr = href.includes("hj2") ? "2. Halbjahr" : href.includes("hj1") ? "1. Halbjahr" : halbjahrFromTitle(title);
    out.push({ title, url: href, fullUrl, halbjahr, gradeLevel: gradeLevelFromTitle(title) });
  }
  if (out.length === 0) throw new Error("no schedule links found");
  return out;
}

function halbjahrFromTitle(title: string): ScheduleLink["halbjahr"] {
  if (title.includes("1.HJ")) return "1. Halbjahr";
  if (title.includes("2.HJ")) return "2. Halbjahr";
  return "Unbekannt";
}

/** The app's heuristic plus the separate J11 / J12 exports the school started publishing in 2026/27. */
export function gradeLevelFromTitle(title: string): string {
  if (title.includes("5-10")) return "Klassen 5-10";
  if (title.includes("J11/12") || title.includes("11-12") || title.includes("J11/J12")) return "J11/J12";
  const tail = title.split(" - ").pop()?.trim() ?? "";
  if (/^J?11$/.test(tail)) return "J11";
  if (/^J?12$/.test(tail)) return "J12";
  return "Unbekannt";
}

/** All class tokens a schedule PDF can contain, in the order we report them. */
export const CLASS_TOKENS: readonly string[] = [
  ...[5, 6, 7, 8, 9, 10].flatMap((g) => ["a", "b", "c", "d", "e"].map((l) => `${g}${l}`)),
  "j11",
  "j12",
];

/**
 * class → 1-based PDF page. Mirrors the app: lowercased page text scan, first
 * page containing the token wins. (The app stores pageIndex + 2 because of a
 * viewer quirk; the API reports the real 1-based page number.)
 */
export function buildClassIndex(pageTexts: readonly string[]): Record<string, number> {
  const index: Record<string, number> = {};
  const lowered = pageTexts.map((t) => t.toLowerCase());
  for (const token of CLASS_TOKENS) {
    const re = token.startsWith("j") ? new RegExp(`\\b${token}\\b`) : new RegExp(`(?<![0-9])${token}(?![a-z])`);
    for (let i = 0; i < lowered.length; i++) {
      if (re.test(lowered[i]!)) {
        index[token] = i + 1;
        break;
      }
    }
  }
  return index;
}
