// Staff list ("Kollegium") parser for the school's public page
// /cm3/index.php/ansprechpartner/kollegium.
//
// The page's sidebar module holds bold role headings, each followed by one
// person per <br> line:
//   <p><strong>Abteilungsleiter</strong><br>Roth, Dr. Daniel (M,Ph) Ro<br>…</p>
//   <p><strong>Lehrerinnen &amp; Lehrer<br>im Schuljahr 2024/2025 </strong><br>…</p>
// A line is "Nachname, [Dr. ]Vorname (Fach,Fach,…) Code". Lines that do not
// fit are skipped and reported, never thrown on. Only the fields below are
// kept; e-mail addresses are never derived or stored.

export type StaffRole = "schulleitung" | "stellvertretendeSchulleitung" | "abteilungsleitung" | "lehrkraft" | "referendar" | "sonstige";

/** Highest first: a person listed under two headings keeps the higher role. */
export const STAFF_ROLES: readonly StaffRole[] = ["schulleitung", "stellvertretendeSchulleitung", "abteilungsleitung", "lehrkraft", "referendar", "sonstige"];

export interface StaffMember {
  /** Untis teacher code, unique key (e.g. "Ro"). */
  code: string;
  lastName: string;
  firstName: string;
  /** Academic title as printed ("Dr.", "Prof. Dr."), null when none. */
  title: string | null;
  /** "Dr. Daniel Roth" */
  displayName: string;
  subjects: string[];
  role: StaffRole;
  /** Page heading of `role`, e.g. "Abteilungsleiter". */
  roleLabel: string;
  /** Every heading the person is listed under, in page order. */
  roleLabels: string[];
}

export interface KollegiumParse {
  /** "2024/2025" when a heading states the school year. */
  schoolYear: string | null;
  staff: StaffMember[];
  /** Lines under a heading that did not parse as a person. */
  skipped: string[];
  /** Codes used by two different people; the first one on the page is kept. */
  duplicateCodes: { code: string; names: string[] }[];
  /** Headings with people that map to no known role (published as "sonstige"). */
  unknownHeadings: string[];
}

const HEADING_MARK = "";
const CODE_RE = /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9]{0,5}$/u;
const TITLE_RE = /^((?:(?:Prof|Dr)\.\s*)+)/;
const LINE_RE = /^([^,()]+?)\s*,\s*([^()]+?)\s*(?:\(([^()]*)\)\s*(\S+)?)?$/u;
const SCHOOL_YEAR_RE = /Schuljahr\s*(\d{4})\s*\/\s*(\d{2}|\d{4})\b/;

export function roleForHeading(heading: string): StaffRole {
  const h = heading.toLowerCase();
  if (/stellv/.test(h)) return "stellvertretendeSchulleitung";
  if (/schulleit/.test(h)) return "schulleitung";
  if (/abteilungsleit/.test(h)) return "abteilungsleitung";
  if (/referendar/.test(h)) return "referendar";
  if (/lehrer|lehrkr|kollegium/.test(h)) return "lehrkraft";
  return "sonstige";
}

export function parseKollegium(html: string): KollegiumParse {
  const members = new Map<string, StaffMember>();
  const skipped: string[] = [];
  const duplicates = new Map<string, Set<string>>();
  const unknownHeadings: string[] = [];
  let schoolYear: string | null = null;
  let heading: string | null = null;

  // Mark bold headings (their inner <br> is part of the heading), then walk the
  // text line by line. A closing </div> ends the module, so the page footer is
  // never read as staff.
  const marked = html.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) => `<br>${HEADING_MARK}${inner.replace(/<br\s*\/?>/gi, " ")}<br>`);
  const segments = marked.split(/(<\/div>)|<br\s*\/?>|<\/?(?:p|li|ul|ol|h[1-6])\b[^>]*>/i);

  for (const segment of segments) {
    if (segment === undefined) continue;
    if (/^<\/div>$/i.test(segment)) {
      heading = null;
      continue;
    }
    const isHeading = segment.includes(HEADING_MARK);
    const text = cleanText(segment.replace(HEADING_MARK, ""));
    if (text === "") continue;
    if (isHeading) {
      heading = text;
      const year = SCHOOL_YEAR_RE.exec(text);
      if (year && !schoolYear) schoolYear = `${year[1]}/${year[2]!.length === 2 ? year[1]!.slice(0, 2) + year[2] : year[2]}`;
      continue;
    }
    if (heading === null) continue; // intro text, navigation
    const person = parseLine(text);
    if (!person) {
      // a heading that is not a staff group (e.g. the e-mail pattern) has no person lines; its text is not staff
      if (roleForHeading(heading) !== "sonstige" || members.size > 0) skipped.push(text);
      continue;
    }
    const role = roleForHeading(heading);
    if (role === "sonstige" && !unknownHeadings.includes(heading)) unknownHeadings.push(heading);
    const existing = members.get(person.code);
    if (!existing) {
      members.set(person.code, { ...person, role, roleLabel: heading, roleLabels: [heading] });
      continue;
    }
    if (samePerson(existing, person)) {
      if (!existing.roleLabels.includes(heading)) existing.roleLabels.push(heading);
      if (STAFF_ROLES.indexOf(role) < STAFF_ROLES.indexOf(existing.role)) {
        existing.role = role;
        existing.roleLabel = heading;
      }
      for (const s of person.subjects) if (!existing.subjects.includes(s)) existing.subjects.push(s);
      if (!existing.title && person.title) {
        existing.title = person.title;
        existing.displayName = person.displayName;
      }
      continue;
    }
    const names = duplicates.get(person.code) ?? new Set([existing.displayName]);
    names.add(person.displayName);
    duplicates.set(person.code, names);
  }

  return {
    schoolYear,
    staff: [...members.values()],
    skipped,
    duplicateCodes: [...duplicates.entries()].map(([code, names]) => ({ code, names: [...names] })),
    unknownHeadings,
  };
}

type ParsedLine = Omit<StaffMember, "role" | "roleLabel" | "roleLabels">;

/** "Roth, Dr. Daniel (M,Ph) Ro" → person, or null when the line is not a staff entry. */
export function parseLine(line: string): ParsedLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  let lastName = m[1]!.trim();
  let rest = m[2]!.trim();
  let code: string | undefined = m[4];
  const subjects = m[3] === undefined ? [] : [...new Set(m[3].split(",").map((s) => s.trim()).filter((s) => s !== ""))];
  if (m[3] === undefined) {
    // no subject list: "Nachname, Vorname Code" — the code is the last word
    const words = rest.split(" ");
    if (words.length < 2) return null;
    code = words.pop();
    rest = words.join(" ");
  }
  if (!code || !CODE_RE.test(code)) return null;

  let title: string | null = null;
  for (const part of ["first", "last"] as const) {
    const source = part === "first" ? rest : lastName;
    const t = TITLE_RE.exec(source);
    if (!t) continue;
    title = t[1]!.replace(/\s+/g, " ").trim();
    if (part === "first") rest = source.slice(t[0].length).trim();
    else lastName = source.slice(t[0].length).trim();
  }
  const firstName = rest;
  if (!/\p{L}/u.test(lastName) || !/\p{L}/u.test(firstName)) return null;
  const displayName = [title, firstName, lastName].filter(Boolean).join(" ");
  return { code, lastName, firstName, title, displayName, subjects };
}

function samePerson(a: ParsedLine, b: ParsedLine): boolean {
  const key = (p: ParsedLine) => `${p.lastName}|${p.firstName}`.toLowerCase().replace(/\s+/g, "");
  return key(a) === key(b);
}

function cleanText(fragment: string): string {
  return decodeHtml(fragment.replace(/<[^>]*>/g, " "))
    .replace(/[\s ]+/g, " ")
    .trim();
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  ccedil: "ç",
  ndash: "–",
  shy: "",
};

export function decodeHtml(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const n = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[ent] ?? whole;
  });
}
