// Access model: every app user knows the school's shared credentials (they
// type them at onboarding). The Worker validates exactly those, so there is no
// identity, no token and nothing to store. Comparison is constant-time.
import type { Context, Next } from "hono";
import type { AppEnv } from "./env";

async function digest(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(da, db);
}

export function parseBasic(header: string | undefined): { username: string; password: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

export async function credentialsValid(env: AppEnv, username: string, password: string): Promise<boolean> {
  if (!(await safeEqual(username, env.SCHOOL_USERNAME))) return false;
  if (await safeEqual(password, env.SCHOOL_PASSWORD)) return true;
  if (env.SCHOOL_PASSWORD_PREVIOUS) return safeEqual(password, env.SCHOOL_PASSWORD_PREVIOUS);
  return false;
}

export async function requireSchoolAuth(c: Context<{ Bindings: AppEnv }>, next: Next) {
  const creds = parseBasic(c.req.header("authorization"));
  if (!creds || !(await credentialsValid(c.env, creds.username, creds.password))) {
    return c.json({ error: "unauthorized", hint: "HTTP Basic with the school's Vertretungsplan credentials" }, 401, {
      "WWW-Authenticate": 'Basic realm="LGKA+", charset="UTF-8"',
      "Cache-Control": "no-store",
    });
  }
  await next();
}

export async function requireAdmin(c: Context<{ Bindings: AppEnv }>, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!c.env.ADMIN_TOKEN || token === "" || !(await safeEqual(token, c.env.ADMIN_TOKEN))) {
    return c.json({ error: "unauthorized" }, 401, { "Cache-Control": "no-store" });
  }
  await next();
}
