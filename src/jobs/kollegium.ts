import type { AppEnv } from "../env";
import { nowIso } from "../lib/time";
import { parseKollegium, STAFF_ROLES, type StaffMember, type StaffRole } from "../parsers/kollegium";
import { fetchResource, schoolUrl, utf8 } from "../sources/http";
import { getState, putResource, putState } from "../store";
import type { JobResult } from "./types";

export const KOLLEGIUM_PAGE = "/cm3/index.php/ansprechpartner/kollegium";
/** Fewer people than this means a broken page or parser: keep the previous list. */
export const MIN_STAFF = 30;

export interface KollegiumData {
  /** When the staff list last changed (not when it was last checked). */
  updatedAt: string;
  source: string;
  schoolYear: string | null;
  staff: StaffMember[];
}

interface State {
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string | null;
  counts?: Partial<Record<StaffRole, number>>;
  skippedLines?: string[];
  duplicateCodes?: { code: string; names: string[] }[];
  unknownHeadings?: string[];
}

// The school page sends no ETag and a Last-Modified of "now" (Joomla renders
// it per request), so conditional requests cannot save the download. The
// scheduler runs this once a day; the content hash decides whether it changed.
export async function refreshKollegium(env: AppEnv): Promise<JobResult> {
  const state = (await getState<State>(env, "kollegium")) ?? {};
  const source = schoolUrl(env, KOLLEGIUM_PAGE);
  try {
    const page = await fetchResource(env, source);
    if (page.status !== 200 || !page.bytes) throw new Error(`kollegium page HTTP ${page.status}`);
    const parsed = parseKollegium(utf8(page.bytes));
    state.skippedLines = parsed.skipped.slice(0, 20);
    state.duplicateCodes = parsed.duplicateCodes;
    state.unknownHeadings = parsed.unknownHeadings;
    // never publish an empty or truncated list: the page layout changed
    if (parsed.staff.length < MIN_STAFF) throw new Error(`kollegium parsed ${parsed.staff.length} staff, below ${MIN_STAFF} (page layout changed?)`);

    const counts: Partial<Record<StaffRole, number>> = {};
    for (const role of STAFF_ROLES) {
      const n = parsed.staff.filter((s) => s.role === role).length;
      if (n > 0) counts[role] = n;
    }
    const content = { source, schoolYear: parsed.schoolYear, staff: parsed.staff };
    const put = await putResource(env, "kollegium", { updatedAt: nowIso(), ...content } satisfies KollegiumData, { hashInput: content });

    state.counts = counts;
    state.lastCheckedAt = state.lastSuccessAt = nowIso();
    state.lastError = null;
    await putState(env, "kollegium", state);
    const notes = [`${parsed.staff.length} staff (${Object.entries(counts).map(([r, n]) => `${r} ${n}`).join(", ")})`];
    if (parsed.skipped.length > 0) notes.push(`skipped ${parsed.skipped.length} unparsed lines`);
    if (parsed.duplicateCodes.length > 0) notes.push(`duplicate codes: ${parsed.duplicateCodes.map((d) => `${d.code} (${d.names.join(" / ")})`).join(", ")}`);
    if (parsed.unknownHeadings.length > 0) notes.push(`unknown headings as sonstige: ${parsed.unknownHeadings.join(", ")}`);
    return { job: "kollegium", changed: put.changed, hash: put.hash, notes };
  } catch (e) {
    state.lastError = String(e instanceof Error ? e.message : e);
    state.lastCheckedAt = nowIso();
    await putState(env, "kollegium", state);
    return { job: "kollegium", changed: false, error: state.lastError, notes: ["kept previous"] };
  }
}
