// Storage layout — everything lives in one R2 bucket created with EU
// jurisdiction; nothing is persisted anywhere else.
//   data/manifest.json          { [resource]: { hash, updatedAt, sourceUpdatedAt } }
//   data/res/<resource>.json     { name, hash, updatedAt, sourceUpdatedAt, data }
//   data/res/<resource>+pdf.json precomputed `?embed=pdf` variant
//   data/state/<job>.json        free-form job state (validators, timestamps, errors)
//   locks/<name>                 { token, acquiredAt } cron mutex (conditional writes + TTL)
//   files/<sha256>.pdf           mirrored PDFs, content-addressed → immutable URLs
//
// One writer (the cron / admin refresh, serialised by the lock) so plain
// read-modify-write on the manifest is safe. R2 is strongly consistent.
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

export const MANIFEST_KEY = "data/manifest.json";
export const resKey = (n: ResourceName) => `data/res/${n}.json`;
/** Precomputed `?embed=pdf` variant (PDFs inlined as base64), so serving it is one R2 read. */
export const embeddedKey = (n: ResourceName) => `data/res/${n}+pdf.json`;
export const stateKey = (j: string) => `data/state/${j}.json`;
export const lockKey = (name: string) => `locks/${name}`;

const JSON_PUT: R2PutOptions = { httpMetadata: { contentType: "application/json" } };

async function readText(env: AppEnv, key: string): Promise<string | null> {
  const obj = await env.FILES.get(key);
  return obj ? obj.text() : null;
}
async function writeText(env: AppEnv, key: string, text: string): Promise<void> {
  await env.FILES.put(key, text, JSON_PUT);
}

// Per-isolate memo: collapses bursts of identical R2 reads. Short TTL keeps
// the freshness story simple.
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
  const raw = await readText(env, MANIFEST_KEY);
  const value = raw ? (JSON.parse(raw) as Manifest) : {};
  memoSet(MANIFEST_KEY, value);
  return value;
}

async function getMemoText(env: AppEnv, key: string): Promise<string | null> {
  const hit = memoGet<string>(key);
  if (hit !== undefined) return hit;
  const value = await readText(env, key);
  if (value !== null) memoSet(key, value);
  return value;
}

export function getResourceRaw(env: AppEnv, name: ResourceName): Promise<string | null> {
  return getMemoText(env, resKey(name));
}

export function getEmbeddedRaw(env: AppEnv, name: ResourceName): Promise<string | null> {
  return getMemoText(env, embeddedKey(name));
}

export async function putEmbedded(env: AppEnv, name: ResourceName, stored: StoredResource): Promise<void> {
  await writeText(env, embeddedKey(name), JSON.stringify(stored));
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
  await writeText(env, resKey(name), JSON.stringify(stored));
  await writeText(env, MANIFEST_KEY, JSON.stringify({ ...manifest, [name]: entry }));
  memoClear();
  return { changed: true, hash };
}

export async function getState<T>(env: AppEnv, job: string): Promise<T | null> {
  const raw = await readText(env, stateKey(job));
  return raw ? (JSON.parse(raw) as T) : null;
}
export async function putState<T>(env: AppEnv, job: string, state: T): Promise<void> {
  await writeText(env, stateKey(job), JSON.stringify(state));
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
// Create-if-absent (`If-None-Match: *`). A held lock is only taken over once
// its stored `acquiredAt` is older than the TTL, and only with `etagMatches`
// on the object we inspected, so two contenders can never both win. A crashed
// run therefore blocks the cron for at most one TTL.

interface LockBody {
  token: string;
  acquiredAt: string;
}

export async function acquireLock(env: AppEnv, name: string, ttlSeconds = 60, now = Date.now()): Promise<string | null> {
  const key = lockKey(name);
  const token = crypto.randomUUID();
  const body = JSON.stringify({ token, acquiredAt: new Date(now).toISOString() } satisfies LockBody);
  const options = (onlyIf: R2Conditional | Headers): R2PutOptions => ({ ...JSON_PUT, onlyIf });

  for (let attempt = 0; attempt < 2; attempt++) {
    if (await env.FILES.put(key, body, options(new Headers({ "If-None-Match": "*" })))) return token;
    const current = await env.FILES.get(key);
    if (!current) continue; // released between our two calls: try to create again
    let held: Partial<LockBody> | null = null;
    try {
      held = JSON.parse(await current.text()) as Partial<LockBody>;
    } catch {
      // unreadable lock body counts as expired
    }
    const acquiredAt = Date.parse(held?.acquiredAt ?? "");
    if (Number.isFinite(acquiredAt) && now - acquiredAt < ttlSeconds * 1000) return null;
    return (await env.FILES.put(key, body, options({ etagMatches: current.etag }))) ? token : null;
  }
  return null;
}

export async function releaseLock(env: AppEnv, name: string, token: string): Promise<void> {
  const key = lockKey(name);
  const current = await env.FILES.get(key);
  if (!current) return;
  const held = JSON.parse(await current.text()) as Partial<LockBody>;
  if (held.token === token) await env.FILES.delete(key);
}
