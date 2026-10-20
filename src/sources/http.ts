// Outbound fetch helpers: school server (optionally with Basic Auth) and
// third parties, with conditional requests so unchanged resources cost a 304.
import type { AppEnv } from "../env";
import { sha256Hex } from "../lib/hash";

export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
}

export interface FetchResult {
  status: number;
  notModified: boolean;
  bytes: Uint8Array | null;
  sha256: string | null;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

export interface FetchOptions {
  auth?: boolean;
  validators?: Validators;
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  /** Extra guard against HTML error pages served as 200 for binary resources. */
  expectPdf?: boolean;
}

export function schoolUrl(env: AppEnv, path: string): string {
  return path.startsWith("http") ? path : `${env.SCHOOL_BASE_URL}${path}`;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

/**
 * The school's Basic Auth may only travel to the school itself, over HTTPS.
 * Links scraped from school pages (timetable PDFs) can point anywhere, and
 * redirects can too, so every hop is checked against SCHOOL_BASE_URL.
 */
export function isSchoolOrigin(env: AppEnv, url: string): boolean {
  try {
    const u = new URL(url);
    const school = new URL(env.SCHOOL_BASE_URL);
    const host = school.hostname;
    return u.protocol === "https:" && u.port === school.port && (u.hostname === host || u.hostname === `www.${host}`);
  } catch {
    return false;
  }
}

export const MAX_REDIRECTS = 5;

/**
 * GET/HEAD with the shared headers. Authenticated requests follow redirects by
 * hand so the Authorization header is only ever sent to the school origin.
 */
async function send(env: AppEnv, url: string, opts: FetchOptions): Promise<Response> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  let current = url;
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = { "User-Agent": env.USER_AGENT, Accept: "*/*" };
    if (opts.auth && isSchoolOrigin(env, current)) headers.Authorization = basicAuthHeader(env.SCHOOL_USERNAME, env.SCHOOL_PASSWORD);
    if (opts.validators?.etag) headers["If-None-Match"] = opts.validators.etag;
    if (opts.validators?.lastModified) headers["If-Modified-Since"] = opts.validators.lastModified;

    const res = await fetch(current, {
      method: opts.method ?? "GET",
      headers,
      redirect: opts.auth ? "manual" : "follow",
      signal,
      // never let Cloudflare's cache answer for the origin here
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const location = res.headers.get("location");
    if (!opts.auth || res.status < 300 || res.status > 399 || res.status === 304 || !location) return res;
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects fetching ${url}`);
    current = new URL(location, current).toString();
  }
}

export async function fetchResource(env: AppEnv, url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const res = await send(env, url, opts);

  const base = {
    status: res.status,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    contentType: res.headers.get("content-type"),
  };
  if (res.status === 304) {
    await res.body?.cancel();
    return { ...base, notModified: true, bytes: null, sha256: null };
  }
  if (opts.method === "HEAD" || !res.ok) {
    await res.body?.cancel();
    return { ...base, notModified: false, bytes: null, sha256: null };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (opts.expectPdf) {
    const head = new TextDecoder().decode(bytes.subarray(0, 8));
    if (!head.startsWith("%PDF-")) {
      return { ...base, status: 502, notModified: false, bytes: null, sha256: null };
    }
  }
  return { ...base, notModified: false, bytes, sha256: await sha256Hex(bytes) };
}

export const utf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);
