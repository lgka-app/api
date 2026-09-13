import type { AppEnv } from "../env";
import { minutesSince, nowIso } from "../lib/time";
import { parseNewsArticle, parseNewsList, sortNewestFirst, type NewsArticle, type NewsArticleContent } from "../parsers/news";
import { fetchResource, schoolUrl, utf8 } from "../sources/http";
import { getResource, getState, putResource, putState } from "../store";
import type { JobResult } from "./types";

export const NEWS_LIST = "/cm3/index.php/neues";
/** Article bodies are re-read this often even when the list did not change. */
const ARTICLE_REFRESH_MINUTES = 6 * 60;
const ARTICLE_CONCURRENCY = 4;

export interface NewsData {
  articles: NewsArticle[];
}

interface State {
  articleFetchedAt?: Record<string, string>;
  lastCheckedAt?: string;
  lastError?: string | null;
}

export async function refreshNews(env: AppEnv): Promise<JobResult> {
  const state = (await getState<State>(env, "news")) ?? {};
  const current = (await getResource<NewsData>(env, "news"))?.data ?? { articles: [] };
  const notes: string[] = [];
  try {
    const list = await fetchResource(env, schoolUrl(env, NEWS_LIST));
    if (list.status !== 200 || !list.bytes) throw new Error(`news list HTTP ${list.status}`);
    const entries = parseNewsList(utf8(list.bytes));
    // an empty list means the page layout changed: keep the previous news instead of publishing nothing
    if (entries.length === 0) throw new Error("news list parsed 0 articles (page layout changed?)");
    const fetchedAt = state.articleFetchedAt ?? {};
    const byUrl = new Map(current.articles.map((a) => [a.url, a]));

    // Which article pages need (re)reading: new ones, or older than the refresh window.
    const stale = entries.filter((e) => !byUrl.has(e.url) || minutesSince(fetchedAt[e.url]) > ARTICLE_REFRESH_MINUTES);
    const contents = new Map<string, NewsArticleContent>();
    for (let i = 0; i < stale.length; i += ARTICLE_CONCURRENCY) {
      await Promise.all(
        stale.slice(i, i + ARTICLE_CONCURRENCY).map(async (e) => {
          try {
            const res = await fetchResource(env, e.url);
            if (res.status !== 200 || !res.bytes) throw new Error(`HTTP ${res.status}`);
            contents.set(e.url, parseNewsArticle(utf8(res.bytes)));
            fetchedAt[e.url] = nowIso();
          } catch (err) {
            notes.push(`${e.title}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
    }

    const articles = sortNewestFirst(
      entries.map((e) => {
        const fresh = contents.get(e.url);
        const prev = byUrl.get(e.url);
        const body: NewsArticleContent = fresh ?? prev ?? { content: null, htmlContent: null, links: [], standaloneLinks: [], images: [], downloads: [] };
        return { ...e, ...body };
      }),
    );

    // forget bookkeeping for articles that left the list
    for (const url of Object.keys(fetchedAt)) if (!entries.some((e) => e.url === url)) delete fetchedAt[url];
    state.articleFetchedAt = fetchedAt;
    state.lastCheckedAt = nowIso();
    state.lastError = null;
    await putState(env, "news", state);

    // View counts churn constantly; keep them out of the change hash so apps
    // are not told "new news" for a counter tick.
    const hashInput = articles.map(({ views: _views, ...rest }) => rest);
    const put = await putResource(env, "news", { articles } satisfies NewsData, {
      hashInput,
      sourceUpdatedAt: articles[0]?.publishedAt ?? null,
    });
    notes.unshift(`${entries.length} articles, ${stale.length} bodies refreshed`);
    return { job: "news", changed: put.changed, hash: put.hash, notes };
  } catch (e) {
    state.lastError = String(e instanceof Error ? e.message : e);
    state.lastCheckedAt = nowIso();
    await putState(env, "news", state);
    return { job: "news", changed: false, error: state.lastError, notes };
  }
}
