import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { gcFiles } from "../src/jobs/gc";
import {
  acquireLock,
  getManifest,
  getResource,
  getState,
  lockKey,
  memoClear,
  putResource,
  putState,
  releaseLock,
} from "../src/store";

/** In-memory R2 bucket with the conditional-write semantics the store relies on. */
class FakeR2 {
  objects = new Map<string, { text: string; etag: string; uploaded: Date }>();
  private seq = 0;

  private passes(key: string, onlyIf: R2Conditional | Headers | undefined): boolean {
    const cur = this.objects.get(key);
    if (!onlyIf) return true;
    if (onlyIf instanceof Headers) {
      const inm = onlyIf.get("If-None-Match");
      if (inm === "*") return !cur;
      const im = onlyIf.get("If-Match");
      if (im) return !!cur && (im === "*" || im === cur.etag);
      return true;
    }
    if (onlyIf.etagMatches !== undefined && (!cur || cur.etag !== onlyIf.etagMatches)) return false;
    if (onlyIf.etagDoesNotMatch !== undefined && cur && cur.etag === onlyIf.etagDoesNotMatch) return false;
    return true;
  }

  async put(key: string, value: string | Uint8Array, opts?: R2PutOptions) {
    if (!this.passes(key, opts?.onlyIf)) return null;
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    const obj = { text, etag: `e${++this.seq}`, uploaded: new Date() };
    this.objects.set(key, obj);
    return { key, etag: obj.etag, size: text.length, uploaded: obj.uploaded };
  }
  async get(key: string) {
    const obj = this.objects.get(key);
    return obj ? { key, etag: obj.etag, size: obj.text.length, uploaded: obj.uploaded, text: async () => obj.text } : null;
  }
  async head(key: string) {
    return this.get(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(opts: R2ListOptions) {
    const objects = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(opts.prefix ?? ""))
      .map(([key, o]) => ({ key, etag: o.etag, size: o.text.length, uploaded: o.uploaded }));
    return { objects, truncated: false };
  }
}

let bucket: FakeR2;
let env: AppEnv;
beforeEach(() => {
  memoClear();
  bucket = new FakeR2();
  env = { FILES: bucket as unknown as R2Bucket } as AppEnv;
});

describe("R2 store", () => {
  it("writes resource + manifest under data/ and reads them back", async () => {
    const first = await putResource(env, "events", { events: [1] }, { sourceUpdatedAt: "x" });
    expect(first.changed).toBe(true);
    expect([...bucket.objects.keys()].sort()).toEqual(["data/manifest.json", "data/res/events.json"]);
    const stored = await getResource<{ events: number[] }>(env, "events");
    expect(stored).toMatchObject({ name: "events", hash: first.hash, sourceUpdatedAt: "x", data: { events: [1] } });
    expect((await getManifest(env, { fresh: true })).events?.hash).toBe(first.hash);

    const etag = bucket.objects.get("data/res/events.json")!.etag;
    expect(await putResource(env, "events", { events: [1] })).toEqual({ changed: false, hash: first.hash });
    expect(bucket.objects.get("data/res/events.json")!.etag).toBe(etag);
  });

  it("stores job state as JSON", async () => {
    expect(await getState(env, "news")).toBeNull();
    await putState(env, "news", { etag: "abc" });
    expect(bucket.objects.has("data/state/news.json")).toBe(true);
    expect(await getState(env, "news")).toEqual({ etag: "abc" });
  });
});

describe("R2 cron lock", () => {
  const t0 = Date.parse("2026-09-12T10:00:00Z");

  it("is exclusive until released", async () => {
    const a = await acquireLock(env, "cron", 120, t0);
    expect(a).toBeTruthy();
    expect(await acquireLock(env, "cron", 120, t0 + 1000)).toBeNull();
    await releaseLock(env, "cron", "not-the-owner");
    expect(bucket.objects.has(lockKey("cron"))).toBe(true);
    await releaseLock(env, "cron", a!);
    expect(bucket.objects.has(lockKey("cron"))).toBe(false);
    expect(await acquireLock(env, "cron", 120, t0 + 2000)).toBeTruthy();
  });

  it("lets a new run take over a lock older than the TTL, exactly once", async () => {
    const crashed = await acquireLock(env, "cron", 120, t0);
    expect(crashed).toBeTruthy();
    expect(await acquireLock(env, "cron", 120, t0 + 119_000)).toBeNull();
    const next = await acquireLock(env, "cron", 120, t0 + 121_000);
    expect(next).toBeTruthy();
    expect(next).not.toBe(crashed);
    // the takeover rewrote acquiredAt, so a second contender at the same moment loses
    expect(await acquireLock(env, "cron", 120, t0 + 121_000)).toBeNull();
    // the crashed run waking up must not release the new owner's lock
    await releaseLock(env, "cron", crashed!);
    expect(bucket.objects.has(lockKey("cron"))).toBe(true);
  });

  it("loses the takeover when someone else replaced the stale lock first", async () => {
    await acquireLock(env, "cron", 120, t0);
    const realGet = bucket.get.bind(bucket);
    bucket.get = async (key: string) => {
      const seen = await realGet(key);
      // a competitor takes over between our read and our conditional write
      bucket.objects.set(key, { text: JSON.stringify({ token: "other", acquiredAt: new Date(t0 + 121_000).toISOString() }), etag: "competitor", uploaded: new Date() });
      return seen;
    };
    expect(await acquireLock(env, "cron", 120, t0 + 121_000)).toBeNull();
  });
});

describe("gc", () => {
  it("never deletes data/ or locks/ objects", async () => {
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await putResource(env, "weather", { t: 1 });
    await putState(env, "runs", {});
    await acquireLock(env, "cron", 120);
    const orphan = `files/${"a".repeat(64)}.pdf`;
    await bucket.put(orphan, "pdf");
    for (const o of bucket.objects.values()) o.uploaded = old;

    const result = await gcFiles(env);
    expect(result.notes[0]).toBe("deleted 1, kept 0, referenced 0");
    expect([...bucket.objects.keys()].sort()).toEqual(["data/manifest.json", "data/res/weather.json", "data/state/runs.json", "locks/cron"]);
  });
});
