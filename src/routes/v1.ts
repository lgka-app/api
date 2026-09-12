import { Hono } from "hono";
import { requireSchoolAuth } from "../auth";
import { isResourceName, RESOURCE_NAMES, type AppEnv, type ResourceName } from "../env";
import { embeddedResourceJson, wantsEmbeddedPdf } from "../embed";
import { fileKey, getManifest, getResource, type StoredResource } from "../store";

export const v1Routes = new Hono<{ Bindings: AppEnv }>();

/** Liveness only: no content, no per-request state. */
v1Routes.get("/healthz", async (c) => {
  const manifest = await getManifest(c.env);
  const updated = Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, v.updatedAt]));
  return c.json({ ok: true, updated }, 200, { "Cache-Control": "public, max-age=30" });
});

v1Routes.use("/v1/*", requireSchoolAuth);

/** Onboarding: 204 when the typed school credentials are right. */
v1Routes.get("/v1/auth/check", (c) => c.body(null, 204));

v1Routes.get("/v1/manifest", async (c) => {
  const manifest = await getManifest(c.env);
  return c.json({ generatedAt: new Date().toISOString(), resources: manifest }, 200, { "Cache-Control": "private, no-cache" });
});

/**
 * The one call the apps make on launch/resume:
 *   GET /v1/sync?substitutions=<hash>&news=<hash>&weather=<hash>...
 * For each known resource: "fresh" (your hash is current — no data sent),
 * "updated" (new hash + full data inline) or "unavailable" (never fetched).
 * Omit a hash (or send "") to always receive the data. `only=a,b` restricts
 * the set of resources considered. `embed=pdf` inlines the mirrored PDFs
 * (base64) into updated substitutions/schedules so no follow-up request is needed.
 */
v1Routes.get("/v1/sync", async (c) => {
  const q = c.req.query();
  const only = q.only ? q.only.split(",").map((s) => s.trim()).filter(isResourceName) : [...RESOURCE_NAMES];
  const embed = wantsEmbeddedPdf(q);
  const manifest = await getManifest(c.env);

  const out: Record<string, unknown> = {};
  await Promise.all(
    only.map(async (name) => {
      const claimed = (q[name] ?? "").trim();
      const entry = manifest[name];
      if (!entry) {
        out[name] = { status: "unavailable" };
        return;
      }
      if (claimed !== "" && claimed === entry.hash) {
        out[name] = { status: "fresh", hash: entry.hash, updatedAt: entry.updatedAt };
        return;
      }
      const stored = await getResource(c.env, name);
      if (!stored) {
        out[name] = { status: "unavailable" };
        return;
      }
      if (claimed !== "" && claimed === stored.hash) {
        // manifest raced ahead of the edge-cached resource; the client is current
        out[name] = { status: "fresh", hash: stored.hash, updatedAt: stored.updatedAt };
        return;
      }
      const data = embed ? (JSON.parse(await embeddedResourceJson(c.env, name, stored)) as StoredResource).data : stored.data;
      out[name] = { status: "updated", hash: stored.hash, updatedAt: stored.updatedAt, sourceUpdatedAt: stored.sourceUpdatedAt, data };
    }),
  );
  return c.json({ generatedAt: new Date().toISOString(), resources: out }, 200, { "Cache-Control": "private, no-cache" });
});

v1Routes.get("/v1/files/:file{[0-9a-f]{64}\\.pdf}", async (c) => {
  const sha = c.req.param("file").slice(0, 64);
  const etag = `"${sha}"`;
  if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag });

  // Content-addressed → cache at the edge for good (key without auth header).
  const cache = caches.default;
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const obj = await c.env.FILES.get(fileKey(sha));
  if (!obj) return c.json({ error: "not found" }, 404);
  const res = new Response(obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(obj.size),
      ETag: etag,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${obj.customMetadata?.source?.split("/").pop() ?? `${sha.slice(0, 12)}.pdf`}"`,
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

v1Routes.get("/v1/:resource", async (c) => {
  const name = c.req.param("resource");
  if (!isResourceName(name)) return c.json({ error: "not found" }, 404);
  const stored: StoredResource | null = await getResource(c.env, name as ResourceName);
  if (!stored) return c.json({ error: "unavailable", resource: name }, 503, { "Retry-After": "60" });
  const embed = wantsEmbeddedPdf(c.req.query());
  const etag = `"${stored.hash}${embed ? "+pdf" : ""}"`;
  if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag, "Cache-Control": "private, no-cache" });
  if (embed) {
    return c.body(await embeddedResourceJson(c.env, name as ResourceName, stored), 200, {
      "Content-Type": "application/json",
      ETag: etag,
      "Cache-Control": "private, no-cache",
    });
  }
  return c.json(stored, 200, { ETag: etag, "Cache-Control": "private, no-cache" });
});
