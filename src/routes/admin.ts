import { Hono } from "hono";
import { requireAdmin } from "../auth";
import type { AppEnv } from "../env";
import { getRunState, JOB_NAMES, runDueJobs, type JobName } from "../jobs";
import { getManifest, getState } from "../store";

export const adminRoutes = new Hono<{ Bindings: AppEnv }>();
adminRoutes.use("/admin/*", requireAdmin);

/** POST /admin/refresh?job=all | job=substitutions,weather — runs jobs now (respects the cron lock). */
adminRoutes.post("/admin/refresh", async (c) => {
  const q = (c.req.query("job") ?? "all").trim();
  const force: JobName[] | "all" = q === "all" ? "all" : (q.split(",").map((s) => s.trim()).filter((s): s is JobName => (JOB_NAMES as string[]).includes(s)));
  if (force !== "all" && force.length === 0) return c.json({ error: "unknown job", jobs: JOB_NAMES }, 400);
  const result = await runDueJobs(c.env, { force });
  return c.json(result, result.locked ? 409 : 200);
});

adminRoutes.get("/admin/status", async (c) => {
  const [manifest, runs, ...states] = await Promise.all([
    getManifest(c.env, { fresh: true }),
    getRunState(c.env),
    ...["substitutions", "schedules", "news", "events", "weather"].map((j) => getState(c.env, j)),
  ]);
  return c.json({
    manifest,
    runs,
    state: Object.fromEntries(["substitutions", "schedules", "news", "events", "weather"].map((j, i) => [j, states[i]])),
  });
});
