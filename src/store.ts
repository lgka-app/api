// Storage layout
//   KV  manifest            { [resource]: { hash, updatedAt, sourceUpdatedAt } }
//   KV  res:<resource>      { name, hash, updatedAt, sourceUpdatedAt, data }
//   KV  state:<job>         free-form job state (validators, timestamps, errors)
//   KV  lock:cron           cron mutex (60 s TTL)
//   R2  files/<sha256>.pdf  mirrored PDFs, content-addressed → immutable URLs
//
// One writer (the cron / admin refresh, serialised by the lock) so plain
// read-modify-write on the manifest is safe.
import type { AppEnv, ResourceName } from "./env";
import { contentHash } from "./lib/hash";
import { nowIso } from "./lib/time";

export interface ManifestEntry {
  hash: string;
  /** When the content last changed. */
  updatedAt: string;
  /** Upstream's own timestamp when known (Last-Modified, PDF generation time...). */
  sourceUpdatedAt: string | null;
}
export type Manifest = Partial<Record<ResourceName, ManifestEntry>>;

export interface StoredResource<T = unknown> extends ManifestEntry {
  name: ResourceName;
  data: T;
}

const MANIFEST_KEY = "manifest";
const resKey = (n: ResourceName) => `res:${n}`;
/** Precomputed `?embed=pdf` variant (PDFs inlined as base64), so serving it is one KV read. */
export const embeddedKey = (n: ResourceName) => `res:${n}+pdf`;
const stateKey = (j: string) => `state:${j}`;

// Per-isolate memo: collapses bursts of identical KV reads. Short TTL keeps
// the freshness story simple (KV itself is read with cacheTtl 60).
const memo = new Map<string, { until: number; value: unknown }>();
const MEMO_MS = 5_000;
function memoGet<T>(key: string): T | undefined {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T;
  memo.delete(key);
  return undefined;
}
function memoSet(key: string, value: unknown) {
  memo.set(key, { until: Date.now() + MEMO_MS, value });
}
export function memoClear() {
  memo.clear();
}

export async function getManifest(env: AppEnv, opts: { fresh?: boolean } = {}): Promise<Manifest> {
  if (!opts.fresh) {
    const hit = memoGet<Manifest>(MANIFEST_KEY);
    if (hit) return hit;
  }
  const value = (await env.DATA.get<Manifest>(MANIFEST_KEY, { type: "json", cacheTtl: opts.fresh ? undefined : 60 })) ?? {};
  memoSet(MANIFEST_KEY, value);
  return value;
}

export async function getResourceRaw(env: AppEnv, name: ResourceName): Promise<string | null> {
  const key = resKey(name);
  const hit = memoGet<string>(key);
  if (hit !== undefined) return hit;
  const value = await env.DATA.get(key, { type: "text", cacheTtl: 60 });
  if (value !== null) memoSet(key, value);
  return value;
}

export async function getEmbeddedRaw(env: AppEnv, name: ResourceName): Promise<string | null> {
  const key = embeddedKey(name);
  const hit = memoGet<string>(key);
  if (hit !== undefined) return hit;
  const value = await env.DATA.get(key, { type: "text", cacheTtl: 60 });
  if (value !== null) memoSet(key, value);
  return value;
}

export async function putEmbedded(env: AppEnv, name: ResourceName, stored: StoredResource): Promise<void> {
  await env.DATA.put(embeddedKey(name), JSON.stringify(stored));
}

export async function getResource<T>(env: AppEnv, name: ResourceName): Promise<StoredResource<T> | null> {
  const raw = await getResourceRaw(env, name);
  return raw ? (JSON.parse(raw) as StoredResource<T>) : null;
}

export interface PutResult {
  changed: boolean;
  hash: string;
}

/**
 * Stores a resource if its content hash changed. `hashInput` lets a job hash
 * a projection of the data (e.g. news without volatile view counts).
 */
export async function putResource<T>(
  env: AppEnv,
  name: ResourceName,
  data: T,
  opts: { sourceUpdatedAt?: string | null; hashInput?: unknown } = {},
): Promise<PutResult> {
  const hash = await contentHash(opts.hashInput ?? data);
  const manifest = await getManifest(env, { fresh: true });
  const previous = manifest[name];
  if (previous?.hash === hash) return { changed: false, hash };

  const entry: ManifestEntry = { hash, updatedAt: nowIso(), sourceUpdatedAt: opts.sourceUpdatedAt ?? null };
  const stored: StoredResource<T> = { name, ...entry, data };
  await env.DATA.put(resKey(name), JSON.stringify(stored));
  await env.DATA.put(MANIFEST_KEY, JSON.stringify({ ...manifest, [name]: entry }));
  memoClear();
  return { changed: true, hash };
}

export async function getState<T>(env: AppEnv, job: string): Promise<T | null> {
  return env.DATA.get<T>(stateKey(job), { type: "json" });
}
export async function putState<T>(env: AppEnv, job: string, state: T): Promise<void> {
  await env.DATA.put(stateKey(job), JSON.stringify(state));
}

// ---- files (R2) ------------------------------------------------------------

export const fileKey = (sha256: string) => `files/${sha256}.pdf`;
export const filePath = (sha256: string) => `/v1/files/${sha256}.pdf`;

export async function putFile(env: AppEnv, sha256: string, bytes: Uint8Array, meta: Record<string, string>): Promise<void> {
  const key = fileKey(sha256);
  const existing = await env.FILES.head(key); // content-addressed: already there
  if (existing && existing.size === bytes.byteLength) return;
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: "application/pdf", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { ...meta, sha256 },
  });
}

// ---- cron lock -------------------------------------------------------------

export async function acquireLock(env: AppEnv, name: string, ttlSeconds = 60): Promise<string | null> {
  const key = `lock:${name}`;
  if (await env.DATA.get(key)) return null;
  const token = crypto.randomUUID();
  await env.DATA.put(key, token, { expirationTtl: Math.max(60, ttlSeconds) });
  // KV is eventually consistent; a quick read-back catches the common race.
  const check = await env.DATA.get(key);
  return check === token ? token : null;
}

export async function releaseLock(env: AppEnv, name: string, token: string): Promise<void> {
  const key = `lock:${name}`;
  if ((await env.DATA.get(key)) === token) await env.DATA.delete(key);
}
