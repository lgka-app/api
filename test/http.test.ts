import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { basicAuthHeader, fetchResource, isSchoolOrigin, MAX_REDIRECTS } from "../src/sources/http";

const env = {
  SCHOOL_BASE_URL: "https://lessing-gymnasium-karlsruhe.de",
  SCHOOL_USERNAME: "user",
  SCHOOL_PASSWORD: "secret",
  USER_AGENT: "LGKA-API/test",
} as unknown as AppEnv;
const AUTH = basicAuthHeader("user", "secret");
const PDF = new TextEncoder().encode("%PDF-1.7 test");

type Call = { url: string; auth: string | undefined; redirect: RequestInit["redirect"] };

/** Stubs global fetch with a route table: url → response factory. Records every call. */
function stubFetch(routes: Record<string, () => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: input, auth: headers.Authorization, redirect: init.redirect });
    const route = routes[input];
    return route ? route() : new Response("not found", { status: 404 });
  });
  return calls;
}
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { Location: to } });
const pdf = () => new Response(PDF, { status: 200, headers: { "Content-Type": "application/pdf" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isSchoolOrigin", () => {
  it("accepts only HTTPS on the school host (and its www alias)", () => {
    expect(isSchoolOrigin(env, "https://lessing-gymnasium-karlsruhe.de/stundenplan/x.pdf")).toBe(true);
    expect(isSchoolOrigin(env, "https://www.lessing-gymnasium-karlsruhe.de/x.pdf")).toBe(true);
    expect(isSchoolOrigin(env, "http://lessing-gymnasium-karlsruhe.de/x.pdf")).toBe(false);
    expect(isSchoolOrigin(env, "https://lessing-gymnasium-karlsruhe.de:8443/x.pdf")).toBe(false);
    expect(isSchoolOrigin(env, "https://lessing-gymnasium-karlsruhe.de.example.com/x.pdf")).toBe(false);
    expect(isSchoolOrigin(env, "https://evil.example/lessing-gymnasium-karlsruhe.de/stundenplan.pdf")).toBe(false);
    expect(isSchoolOrigin(env, "https://user@evil.example/")).toBe(false);
    expect(isSchoolOrigin(env, "not a url")).toBe(false);
  });
});

describe("fetchResource credentials", () => {
  it("sends Basic Auth to the school", async () => {
    const url = "https://lessing-gymnasium-karlsruhe.de/stundenplan/schueler/v_schueler_heute.pdf";
    const calls = stubFetch({ [url]: pdf });
    const res = await fetchResource(env, url, { auth: true, expectPdf: true });
    expect(res.status).toBe(200);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual([{ url, auth: AUTH, redirect: "manual" }]);
  });

  it("never sends the school credentials to a foreign host or over plain HTTP", async () => {
    const foreign = "https://evil.example/stundenplan_hj1.pdf";
    const plain = "http://lessing-gymnasium-karlsruhe.de/stundenplan/x.pdf";
    const calls = stubFetch({ [foreign]: pdf, [plain]: pdf });
    await fetchResource(env, foreign, { auth: true, expectPdf: true });
    await fetchResource(env, plain, { auth: true, expectPdf: true });
    expect(calls.map((c) => c.auth)).toEqual([undefined, undefined]);
  });

  it("keeps the credentials on same-origin redirects and drops them when a redirect leaves the school", async () => {
    const start = "https://lessing-gymnasium-karlsruhe.de/cm3/../stundenplan/a.pdf";
    const moved = "https://lessing-gymnasium-karlsruhe.de/stundenplan/a.pdf";
    const away = "https://cdn.example/a.pdf";
    const calls = stubFetch({ [start]: redirect("/stundenplan/a.pdf", 301), [moved]: redirect(away), [away]: pdf });
    const res = await fetchResource(env, start, { auth: true, expectPdf: true });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { url: start, auth: AUTH, redirect: "manual" },
      { url: moved, auth: AUTH, redirect: "manual" },
      { url: away, auth: undefined, redirect: "manual" },
    ]);
  });

  it("does not treat 304 as a redirect", async () => {
    const url = "https://lessing-gymnasium-karlsruhe.de/stundenplan/schueler/v_schueler_morgen.pdf";
    const calls = stubFetch({ [url]: () => new Response(null, { status: 304, headers: { ETag: '"x"' } }) });
    const res = await fetchResource(env, url, { auth: true, validators: { etag: '"x"' }, expectPdf: true });
    expect(res.notModified).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("gives up after too many redirects", async () => {
    const loop = "https://lessing-gymnasium-karlsruhe.de/loop";
    const calls = stubFetch({ [loop]: redirect(loop) });
    await expect(fetchResource(env, loop, { auth: true })).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("leaves unauthenticated requests to fetch's own redirect handling", async () => {
    const url = "https://lessing-gymnasium-karlsruhe.de/cm3/index.php/neues";
    const calls = stubFetch({ [url]: () => new Response("<html></html>", { status: 200 }) });
    await fetchResource(env, url);
    expect(calls).toEqual([{ url, auth: undefined, redirect: "follow" }]);
  });
});
