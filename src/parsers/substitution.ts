// Substitution plan (Untis "Vertretungsplan") parser.
//
// Port of the verification harness' extractor v2 (reference implementation
// for the native apps) onto pdf.js line/word geometry, extended to read all
// pages instead of only the first one.
//
// Untis plan shape (per page):
//   header : school / address (left), "SJ YYYY-YYYY" (center),
//            "Untis NNNN" + generation timestamp (right)
//   title  : "Lessing-Klassen D.M. / Weekday"
//   free announcement lines (optional)
//   "Abwesende Lehrer: A, B, C"   (optional)
//   "Abwesende Klassen: X, Y"     (optional)
//   "Blockierte Räume: R1, R2"    (optional)
//   table  : 10 columns — Art | Stunde | Klasse | Vertreter | Fach | Raum |
//            (Fach) | (Lehrer) | (Raum) | Text
//   footer : "[Periode N]  D.M.YYYY (week)  SJ YY/YY"
import type { Line, PdfDocument, Word } from "../lib/pdf";

export const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"] as const;

/** Canonical column names in visual order. Parenthesised columns are the
 *  ORIGINAL (cancelled) subject/teacher/room; unparenthesised are replacements. */
export const COLUMN_NAMES = [
  "type", // Art       (e.g. "Vertretung", "Entfall", "Veranst.", "Raum-Vtr.")
  "period", // Stunde    (e.g. "3", "1-11", "5-6")
  "classes", // Klasse(n)
  "substitute", // Vertreter
  "subject", // Fach
  "room", // Raum
  "originalSubject", // (Fach)
  "originalTeacher", // (Lehrer)
  "originalRoom", // (Raum)
  "note", // Text
] as const;

export type ColumnName = (typeof COLUMN_NAMES)[number];

export interface SubstitutionEntry {
  type: string | null;
  period: string | null;
  /** Expanded class list: "6ab" → ["6a","6b"], "5a, 7c" → ["5a","7c"], "J11" → ["J11"]. */
  classes: string[];
  classesRaw: string | null;
  substitute: string | null;
  subject: string | null;
  room: string | null;
  originalSubject: string | null;
  originalTeacher: string | null;
  originalRoom: string | null;
  note: string | null;
  /** 0-based page the entry starts on. */
  page: number;
}

export interface SubstitutionFooter {
  untisPeriod: number | null;
  date: string | null; // DD.MM.YYYY
  calendarWeek: number | null;
  schoolYearShort: string | null; // "SJ 25/26"
}

export interface SubstitutionPlan {
  school: string | null;
  address: string | null;
  schoolYear: string | null;
  untisVersion: string | null;
  /** Generation timestamp as printed, e.g. "11.9.2026 8:56". */
  generatedAt: string | null;
  planDate: string | null; // DD.MM.YYYY
  weekday: string | null; // German, capitalised
  /** True for the empty weekend/holiday export (page text < 50 chars). */
  isEmpty: boolean;
  announcements: string[];
  absentTeachers: string[];
  absentClasses: string[];
  blockedRooms: string[];
  entries: SubstitutionEntry[];
  footer: SubstitutionFooter | null;
  pageCount: number;
}

/** v1 metadata contract of the shipping Flutter app (goldens/substitution/*.json). */
export interface SubstitutionMeta {
  weekday: string; // "weekend" sentinel for the empty export
  date: string;
  lastUpdated: string;
}

export function planMeta(plan: SubstitutionPlan): SubstitutionMeta {
  if (plan.isEmpty) return { weekday: "weekend", date: "", lastUpdated: "" };
  return {
    weekday: plan.weekday ?? "",
    date: plan.planDate ?? "",
    lastUpdated: plan.generatedAt ?? "",
  };
}

export function expandClasses(cell: string): string[] {
  const out: string[] = [];
  for (const part of cell.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d{1,2})([a-e]{2,})$/.exec(p);
    if (m) {
      for (const letter of m[2]!) out.push(`${m[1]}${letter}`);
    } else {
      out.push(p);
    }
  }
  return out;
}

const FOOTER_RE = /(?:Periode\s+(\d+)\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})\s+\((\d+)\)(?:\s+SJ\s+(\S+))?/;
const FOOTER_DETECT_RE = /\d{1,2}\.\d{1,2}\.\d{4}\s*\(\d+\)/;

export function parseSubstitutionPlan(doc: PdfDocument): SubstitutionPlan {
  const plan: SubstitutionPlan = {
    school: null,
    address: null,
    schoolYear: null,
    untisVersion: null,
    generatedAt: null,
    planDate: null,
    weekday: null,
    isEmpty: false,
    announcements: [],
    absentTeachers: [],
    absentClasses: [],
    blockedRooms: [],
    entries: [],
    footer: null,
    pageCount: doc.pageCount,
  };

  const firstLines = doc.pages[0]?.lines ?? [];
  if (firstLines.map((l) => l.text.trim()).join("").length < 50) {
    plan.isEmpty = true;
    return plan;
  }

  let footerYear: string | null = null;
  // The footer is on every page; parse it from the last page that has one.
  for (const page of doc.pages) {
    const footerLine = page.lines.find((l) => FOOTER_DETECT_RE.test(l.text));
    if (!footerLine) continue;
    const m = FOOTER_RE.exec(footerLine.text.replace(/\s+/g, " "));
    if (!m) continue;
    footerYear = m[4]!;
    plan.footer = {
      untisPeriod: m[1] ? Number(m[1]) : null,
      date: `${m[2]!.padStart(2, "0")}.${m[3]!.padStart(2, "0")}.${m[4]}`,
      calendarWeek: Number(m[5]),
      schoolYearShort: m[6] ? `SJ ${m[6]}` : null,
    };
  }

  for (const page of doc.pages) {
    parsePage(page.index, page.lines, plan, footerYear, page.index === 0);
  }
  return plan;
}

function parsePage(pageIndex: number, lines: Line[], plan: SubstitutionPlan, footerYear: string | null, isFirst: boolean) {
  let titleIdx: number | null = null;
  let teachersIdx: number | null = null;
  let classesIdx: number | null = null;
  let roomsIdx: number | null = null;
  let headerIdx: number | null = null;
  let footerIdx: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.text.trim();
    if (titleIdx === null && t.includes("Klassen") && t.includes("/") && WEEKDAYS.some((w) => t.includes(w))) {
      titleIdx = i;
    } else if (t.startsWith("Abwesende Lehrer")) {
      teachersIdx = i;
    } else if (t.startsWith("Abwesende Klassen")) {
      classesIdx = i;
    } else if (t.startsWith("Blockierte Räume")) {
      roomsIdx = i;
    } else if (headerIdx === null && t.startsWith("Art") && t.includes("Stunde")) {
      headerIdx = i;
    } else if (FOOTER_DETECT_RE.test(t)) {
      footerIdx = i;
    }
  }

  if (isFirst) {
    // ---- fixed header lines (above the title) ----
    // The left/centre/right header blocks share a baseline, so one visual
    // line holds up to three of them; split on large horizontal gaps.
    for (let i = 0; i < (titleIdx ?? lines.length); i++) {
      for (const t of segments(lines[i]!)) {
        if (/^(SJ|Schuljahr) \d{4}-\d{4}$/.test(t)) plan.schoolYear = t;
        else if (t.startsWith("Untis ")) plan.untisVersion = t;
        else if (/^\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}$/.test(t)) plan.generatedAt = t.replace(/\s+/g, " ");
        else if (plan.school === null) plan.school = t;
        else if (plan.address === null) plan.address = t;
      }
    }

    // ---- title: partial date + weekday, year from footer ----
    if (titleIdx !== null) {
      const m = /(\d{1,2})\.(\d{1,2})\.\s*\/\s*(\p{L}+)/u.exec(lines[titleIdx]!.text);
      if (m) {
        plan.weekday = m[3]!;
        const year = footerYear ?? String(new Date().getFullYear());
        plan.planDate = `${m[1]!.padStart(2, "0")}.${m[2]!.padStart(2, "0")}.${year}`;
      }
    }

    // ---- announcements: between title and first structural line ----
    const annEnd = Math.min(...[teachersIdx, classesIdx, roomsIdx, headerIdx, footerIdx, lines.length].filter((x): x is number => x !== null));
    if (titleIdx !== null) {
      for (let i = titleIdx + 1; i < annEnd; i++) {
        const t = lines[i]!.text.trim().replace(/\s+/g, " ");
        if (t) plan.announcements.push(t);
      }
    }

    // ---- absences ----
    if (teachersIdx !== null) plan.absentTeachers = valuesAfterColon(lines[teachersIdx]!.text);
    if (classesIdx !== null) plan.absentClasses = valuesAfterColon(lines[classesIdx]!.text);
    if (roomsIdx !== null) plan.blockedRooms = valuesAfterColon(lines[roomsIdx]!.text);
  }

  // ---- table ----
  if (headerIdx === null) return;
  const tableEnd = footerIdx ?? lines.length;
  const columns = columnStarts(lines[headerIdx]!, lines.slice(headerIdx + 1, tableEnd));
  if (!columns) return;

  let current: SubstitutionEntry | null = null;
  for (let i = headerIdx + 1; i < tableEnd; i++) {
    const cells = assignCells(lines[i]!.words, columns);
    if (cells.every((c) => c === "")) continue;

    const isNewEntry = cells[0] !== "" || cells[1] !== "";
    if (isNewEntry) {
      current = {
        type: cells[0] || null,
        period: cells[1] || null,
        classes: expandClasses(cells[2] ?? ""),
        classesRaw: cells[2] || null,
        substitute: cells[3] || null,
        subject: cells[4] || null,
        room: cells[5] || null,
        originalSubject: cells[6] || null,
        originalTeacher: cells[7] || null,
        originalRoom: cells[8] || null,
        note: cells[9] || null,
        page: pageIndex,
      };
      plan.entries.push(current);
    } else if (current) {
      // continuation line: append wrapped cell text
      for (let c = 0; c < COLUMN_NAMES.length; c++) {
        const name = COLUMN_NAMES[c]!;
        const cell = cells[c]!;
        if (cell === "" || name === "classes") continue;
        const prev = current[name];
        current[name] = prev == null ? cell : `${prev} ${cell}`;
      }
    }
  }
}

/** Splits a visual line into text blocks separated by a gap wider than a space. */
function segments(line: Line, minGap = 20): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let prevRight: number | null = null;
  for (const w of line.words) {
    if (prevRight !== null && w.left - prevRight > minGap && current.length > 0) {
      out.push(current.join(" "));
      current = [];
    }
    current.push(w.text);
    prevRight = w.right;
  }
  if (current.length > 0) out.push(current.join(" "));
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

function valuesAfterColon(text: string): string[] {
  const colon = text.indexOf(":");
  if (colon < 0) return [];
  return text
    .slice(colon + 1)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Column x-starts. The header gives the count and rough positions; where a
 * header word's x is only an estimate (pdf.js merged it with its neighbour),
 * we snap it to an exact item start seen in the table rows between its
 * neighbours, which is where the cells of that column actually begin.
 */
function columnStarts(header: Line, rows: Line[]): number[] | null {
  const xs = header.words.map((w) => ({ x: w.left, estimated: w.estimated }));
  if (xs.length !== COLUMN_NAMES.length) return null;

  const exactStarts = rows.flatMap((r) => r.words.filter((w) => !w.estimated).map((w) => w.left));
  return xs.map((col, i) => {
    if (!col.estimated) return col.x;
    const lo = xs[i - 1]?.x ?? -Infinity;
    const hi = xs[i + 1]?.x ?? Infinity;
    const candidates = exactStarts.filter((x) => x > lo + 3 && x < hi - 3);
    if (candidates.length === 0) return col.x;
    // most frequent candidate (rounded) wins
    const counts = new Map<number, number>();
    for (const x of candidates) counts.set(Math.round(x), (counts.get(Math.round(x)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  });
}

/** Distributes a row's words into the 10 columns. */
function assignCells(words: Word[], columns: number[]): string[] {
  const cells = new Array<string>(columns.length).fill("");
  let prevCol: number | null = null;
  for (const w of words) {
    const t = w.text.trim();
    if (!t) continue;
    let c: number;
    if (!w.estimated) {
      c = lastColumnAtOrBefore(w.left, columns);
    } else {
      // Estimated word: it belongs to a later column only if it clearly sits
      // at or beyond that column's start; otherwise it continues the previous cell.
      c = prevCol ?? 0;
      const next = c + 1;
      if (next < columns.length && w.left >= columns[next]! - 6) c = lastColumnAtOrBefore(w.left + 6, columns);
    }
    cells[c] = cells[c] === "" ? t : `${cells[c]} ${t}`;
    prevCol = c;
  }
  return cells;
}

function lastColumnAtOrBefore(x: number, columns: number[]): number {
  for (let c = columns.length - 1; c >= 0; c--) {
    if (x >= columns[c]! - 3) return c;
  }
  return 0;
}
