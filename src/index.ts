import { Hono } from "hono";
import { alertNow, errorText } from "./alerts";
import type { AppEnv } from "./env";
import { runDueJobs } from "./jobs";
import { adminRoutes } from "./routes/admin";
import { v1Routes } from "./routes/v1";

const app = new Hono<{ Bindings: AppEnv }>();

// Privacy: no request logging anywhere in this file or the routes.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

app.get("/", (c) =>
  c.json({
    name: "LGKA+ API",
    docs: "https://github.com/lgka-app/api",
    endpoints: ["/healthz", "/v1/sync", "/v1/manifest", "/v1/{substitutions|schedules|news|events|weather}", "/v1/files/{sha256}.pdf"],
  }),
);

app.route("/", v1Routes);
app.route("/", adminRoutes);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  console.log(JSON.stringify({ error: err.message, path }));
  c.executionCtx.waitUntil(alertNow(c.env, "http:500", "Unhandled API error (HTTP 500)", `${err.message} (${c.req.method} ${path})`));
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    ctx.waitUntil(
      runDueJobs(env).catch((e) => alertNow(env, "cron:crash", "Cron run crashed", errorText(e))),
    );
  },
} satisfies ExportedHandler<AppEnv>;
