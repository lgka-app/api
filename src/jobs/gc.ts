// Deletes mirrored PDFs that no current resource references any more. Files
// are content-addressed, so a freshly superseded PDF is kept for two days in
// case a client still holds its URL.
import type { AppEnv } from "../env";
import { getResource } from "../store";
import type { SchedulesData } from "./schedules";
import type { SubstitutionsData } from "./substitutions";
import type { JobResult } from "./types";

const GRACE_MS = 2 * 24 * 3600 * 1000;

export async function gcFiles(env: AppEnv): Promise<JobResult> {
  const referenced = new Set<string>();
  const subs = (await getResource<SubstitutionsData>(env, "substitutions"))?.data;
  for (const day of [subs?.today, subs?.tomorrow]) if (day?.pdf) referenced.add(day.pdf.sha256);
  const sched = (await getResource<SchedulesData>(env, "schedules"))?.data;
  for (const item of sched?.items ?? []) if (item.pdf) referenced.add(item.pdf.sha256);

  let deleted = 0;
  let kept = 0;
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: "files/", cursor, limit: 500 });
    for (const obj of page.objects) {
      const sha = obj.key.slice("files/".length, -".pdf".length);
      const old = Date.now() - obj.uploaded.getTime() > GRACE_MS;
      if (!referenced.has(sha) && old) {
        await env.FILES.delete(obj.key);
        deleted++;
      } else {
        kept++;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { job: "gc", changed: deleted > 0, notes: [`deleted ${deleted}, kept ${kept}, referenced ${referenced.size}`] };
}
