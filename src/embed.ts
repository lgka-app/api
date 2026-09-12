// `?embed=…`: inline mirrored PDFs (base64) into a resource payload so a
// client gets plan + files in one round trip. Only paid on change (hash sync).
//
//   embed=pdf                      every resource that has PDFs
//   embed=substitutions.pdf        only that resource (comma-separated list ok)
import type { AppEnv, ResourceName } from "./env";
import { isResourceName } from "./env";
import { fileKey, getEmbeddedRaw, putEmbedded, type StoredResource } from "./store";

interface PdfRef {
  sha256: string;
  bytes: number;
  base64?: string;
}

const PDF_RESOURCES: readonly ResourceName[] = ["substitutions", "schedules"];

/** Which resources the caller wants PDFs inlined for (empty set = none). */
export function embedTargets(query: Record<string, string>): Set<ResourceName> {
  const out = new Set<ResourceName>();
  for (const raw of (query.embed ?? "").split(",")) {
    const token = raw.trim();
    if (token === "pdf") for (const r of PDF_RESOURCES) out.add(r);
    else if (token.endsWith(".pdf")) {
      const name = token.slice(0, -4);
      if (isResourceName(name) && PDF_RESOURCES.includes(name)) out.add(name);
    }
  }
  return out;
}

/**
 * Returns the resource JSON with PDFs inlined. Served from the precomputed R2
 * variant when it matches the current hash; otherwise built from R2 once and
 * stored for the next request (self-healing after deploys / restarts).
 */
export async function embeddedResourceJson(env: AppEnv, name: ResourceName, stored: StoredResource): Promise<string> {
  const raw = await getEmbeddedRaw(env, name);
  if (raw) {
    const cached = JSON.parse(raw) as StoredResource;
    if (cached.hash === stored.hash) return raw;
  }
  await embedPdfs(env, name, stored.data);
  await putEmbedded(env, name, stored);
  return JSON.stringify(stored);
}

/** Mutates `data` in place, adding `pdf.base64` to every PDF reference of the resource. */
export async function embedPdfs(env: AppEnv, name: ResourceName, data: unknown): Promise<void> {
  const refs = pdfRefs(name, data);
  await Promise.all(
    refs.map(async (ref) => {
      const obj = await env.FILES.get(fileKey(ref.sha256));
      if (!obj) return;
      ref.base64 = toBase64(new Uint8Array(await obj.arrayBuffer()));
    }),
  );
}

function pdfRefs(name: ResourceName, data: unknown): PdfRef[] {
  const d = data as Record<string, unknown> | null;
  if (!d) return [];
  if (name === "substitutions") {
    return [d.today, d.tomorrow]
      .map((day) => (day as { pdf?: PdfRef } | null)?.pdf)
      .filter((p): p is PdfRef => !!p);
  }
  if (name === "schedules") {
    return ((d.items as { pdf?: PdfRef | null }[] | undefined) ?? []).map((i) => i.pdf).filter((p): p is PdfRef => !!p);
  }
  return [];
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
