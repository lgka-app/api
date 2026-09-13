import type { AppEnv } from "../env";
import { readPdf } from "../lib/pdf";
import { nowIso } from "../lib/time";
import { buildClassIndex, parseSchedulePage, type ScheduleLink } from "../parsers/schedule";
import { fetchResource, schoolUrl, utf8, type Validators } from "../sources/http";
import { filePath, getResource, getState, putFile, putResource, putState } from "../store";
import { embeddedResourceJson } from "../embed";
import type { JobResult } from "./types";

export const SCHEDULE_PAGE = "/cm3/index.php/unterricht/stundenplan";

export interface ScheduleItem extends ScheduleLink {
  available: boolean;
  pdf: { url: string; sha256: string; bytes: number; pageCount: number; sourceLastModified: string | null } | null;
  /** class → 1-based page in this PDF (5a..10e, j11, j12 where present). */
  classIndex: Record<string, number>;
  /** Plain text per page (for client-side search). */
  pages: string[];
}

export interface SchedulesData {
  items: ScheduleItem[];
}

interface PdfState extends Validators {
  sha256?: string | null;
  available?: boolean;
}
interface State {
  page?: Validators & { sha256?: string | null };
  pdfs?: Record<string, PdfState>;
  lastCheckedAt?: string;
  lastError?: string | null;
}

export async function refreshSchedules(env: AppEnv): Promise<JobResult> {
  const state = (await getState<State>(env, "schedules")) ?? {};
  const current = (await getResource<SchedulesData>(env, "schedules"))?.data ?? { items: [] };
  const notes: string[] = [];
  try {
    const page = await fetchResource(env, schoolUrl(env, SCHEDULE_PAGE), { auth: true });
    if (page.status !== 200 || !page.bytes) throw new Error(`schedule page HTTP ${page.status}`);
    const links = parseSchedulePage(utf8(page.bytes));
    // no PDF links means the page layout changed: keep the previous timetables instead of publishing none
    if (links.length === 0) throw new Error("schedule page parsed 0 PDF links (page layout changed?)");
    state.page = { etag: page.etag, lastModified: page.lastModified, sha256: page.sha256 };

    const pdfs = state.pdfs ?? {};
    const items: ScheduleItem[] = [];
    let changed = false;
    for (const link of links) {
      const prev = current.items.find((i) => i.fullUrl === link.fullUrl);
      const ps: PdfState = { ...(pdfs[link.fullUrl] ?? {}) };
      let item: ScheduleItem = prev
        ? { ...prev, ...link }
        : { ...link, available: false, pdf: null, classIndex: {}, pages: [] };

      const res = await fetchResource(env, link.fullUrl, { auth: true, validators: ps, expectPdf: true });
      if (res.notModified && prev?.pdf) {
        notes.push(`${link.title}: 304`);
      } else if (res.status === 404) {
        item = { ...item, available: false, pdf: null, classIndex: {}, pages: [] };
        ps.available = false;
        notes.push(`${link.title}: not published yet (404)`);
      } else if (res.status !== 200 || !res.bytes || !res.sha256) {
        notes.push(`${link.title}: HTTP ${res.status}, keeping previous`);
      } else if (res.sha256 === ps.sha256 && prev?.pdf) {
        notes.push(`${link.title}: unchanged`);
      } else {
        const doc = await readPdf(res.bytes);
        await putFile(env, res.sha256, res.bytes, { source: link.fullUrl, lastModified: res.lastModified ?? "" });
        item = {
          ...item,
          available: true,
          pdf: { url: filePath(res.sha256), sha256: res.sha256, bytes: res.bytes.byteLength, pageCount: doc.pageCount, sourceLastModified: res.lastModified },
          classIndex: buildClassIndex(doc.pages.map((p) => p.text)),
          pages: doc.pages.map((p) => p.text),
        };
        ps.etag = res.etag;
        ps.lastModified = res.lastModified;
        ps.sha256 = res.sha256;
        ps.available = true;
        changed = true;
        notes.push(`${link.title}: updated (${doc.pageCount} pages, ${Object.keys(item.classIndex).length} classes)`);
      }
      pdfs[link.fullUrl] = ps;
      items.push(item);
    }
    state.pdfs = pdfs;
    state.lastCheckedAt = nowIso();
    state.lastError = null;
    await putState(env, "schedules", state);

    const put = await putResource(env, "schedules", { items } satisfies SchedulesData, {
      sourceUpdatedAt: items.map((i) => i.pdf?.sourceLastModified).filter(Boolean).sort().at(-1) ?? null,
    });
    if (put.changed) {
      const stored = await getResource(env, "schedules");
      if (stored) await embeddedResourceJson(env, "schedules", stored); // precompute ?embed=pdf variant
    }
    return { job: "schedules", changed: changed || put.changed, hash: put.hash, notes };
  } catch (e) {
    state.lastError = String(e instanceof Error ? e.message : e);
    state.lastCheckedAt = nowIso();
    await putState(env, "schedules", state);
    return { job: "schedules", changed: false, error: state.lastError, notes };
  }
}
