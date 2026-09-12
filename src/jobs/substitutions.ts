import type { AppEnv } from "../env";
import { readPdf } from "../lib/pdf";
import { nowIso } from "../lib/time";
import { parseSubstitutionPlan, planMeta, type SubstitutionMeta, type SubstitutionPlan } from "../parsers/substitution";
import { fetchResource, schoolUrl, type Validators } from "../sources/http";
import { filePath, getResource, getState, putFile, putResource, putState } from "../store";
import type { JobResult } from "./types";

export const SUBSTITUTION_SOURCES = {
  today: "/stundenplan/schueler/v_schueler_heute.pdf",
  tomorrow: "/stundenplan/schueler/v_schueler_morgen.pdf",
} as const;
type DayKey = keyof typeof SUBSTITUTION_SOURCES;

export interface DayPlan {
  /** Upstream file name, e.g. "v_schueler_heute.pdf". */
  source: string;
  pdf: { url: string; sha256: string; bytes: number; pageCount: number };
  /** Upstream Last-Modified (HTTP date) when the server sent one. */
  sourceLastModified: string | null;
  meta: SubstitutionMeta;
  plan: SubstitutionPlan;
  /** Plain text per page (for client-side search). */
  pages: string[];
}

export interface SubstitutionsData {
  today: DayPlan | null;
  tomorrow: DayPlan | null;
}

interface DayState extends Validators {
  sha256?: string | null;
  lastCheckedAt?: string;
  lastError?: string | null;
}
type State = Partial<Record<DayKey, DayState>>;

export async function refreshSubstitutions(env: AppEnv): Promise<JobResult> {
  const state = (await getState<State>(env, "substitutions")) ?? {};
  const current = (await getResource<SubstitutionsData>(env, "substitutions"))?.data ?? { today: null, tomorrow: null };
  const next: SubstitutionsData = { ...current };
  const notes: string[] = [];
  let anyChange = false;

  for (const day of Object.keys(SUBSTITUTION_SOURCES) as DayKey[]) {
    const path = SUBSTITUTION_SOURCES[day];
    const ds: DayState = { ...(state[day] ?? {}) };
    try {
      const res = await fetchResource(env, schoolUrl(env, path), { auth: true, validators: ds, expectPdf: true });
      ds.lastCheckedAt = nowIso();
      if (res.notModified) {
        notes.push(`${day}: 304`);
      } else if (res.status !== 200 || !res.bytes || !res.sha256) {
        throw new Error(`HTTP ${res.status}`);
      } else if (res.sha256 === ds.sha256 && current[day]) {
        notes.push(`${day}: unchanged`);
        ds.etag = res.etag;
        ds.lastModified = res.lastModified;
      } else {
        const doc = await readPdf(res.bytes);
        const plan = parseSubstitutionPlan(doc);
        await putFile(env, res.sha256, res.bytes, { source: path, day, lastModified: res.lastModified ?? "" });
        next[day] = {
          source: path.split("/").pop()!,
          pdf: { url: filePath(res.sha256), sha256: res.sha256, bytes: res.bytes.byteLength, pageCount: doc.pageCount },
          sourceLastModified: res.lastModified,
          meta: planMeta(plan),
          plan,
          pages: doc.pages.map((p) => p.text),
        };
        ds.etag = res.etag;
        ds.lastModified = res.lastModified;
        ds.sha256 = res.sha256;
        anyChange = true;
        notes.push(`${day}: updated (${plan.isEmpty ? "empty" : `${plan.entries.length} entries, ${plan.weekday} ${plan.planDate}`})`);
      }
      ds.lastError = null;
    } catch (e) {
      ds.lastError = String(e instanceof Error ? e.message : e);
      notes.push(`${day}: error ${ds.lastError}`);
    }
    state[day] = ds;
  }

  await putState(env, "substitutions", state);
  if (!anyChange) return { job: "substitutions", changed: false, notes };
  const sourceUpdatedAt = [next.today?.sourceLastModified, next.tomorrow?.sourceLastModified].filter(Boolean).sort().at(-1) ?? null;
  const put = await putResource(env, "substitutions", next, { sourceUpdatedAt });
  return { job: "substitutions", changed: put.changed, hash: put.hash, notes };
}
