// News ("Neues") parser for the school's Joomla blog: list page → metadata,
// article page → cleaned content, links, images, downloads.
//
// Port of the app's NewsService (kept field-compatible so the apps can drop
// their own HTML parsing), with two upgrades: German long dates are parsed
// (publishedAt) and the list page's <time datetime> is used when present.
import { parse, type HTMLElement } from "node-html-parser";

export interface NewsLink {
  text: string;
  url: string;
}
export interface NewsImage {
  url: string;
  thumbnailUrl: string | null;
  alt: string | null;
}
export interface NewsDownload {
  title: string;
  url: string;
  /** e.g. "pdf", "audio", "video", "document" */
  fileType: string;
  /** e.g. "3.64 MB" */
  size: string | null;
}

export interface NewsListEntry {
  id: number | null;
  title: string;
  author: string;
  description: string;
  /** As displayed, e.g. "09. September 2026". */
  createdDate: string;
  /** ISO-8601 from <time datetime> when present, else date-only from the German text, else null. */
  publishedAt: string | null;
  views: number;
  url: string;
  tags: string[];
}

export interface NewsArticleContent {
  content: string | null;
  htmlContent: string | null;
  /** Links embedded in running text. */
  links: NewsLink[];
  /** Bare-URL links that stood alone in their paragraph (rendered as buttons). */
  standaloneLinks: NewsLink[];
  images: NewsImage[];
  downloads: NewsDownload[];
}

export type NewsArticle = NewsListEntry & NewsArticleContent;

const SCHOOL = "https://lessing-gymnasium-karlsruhe.de";

export function absoluteUrl(href: string): string {
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `${SCHOOL}${href}`;
  return `${SCHOOL}/cm3/${href}`;
}

const MONTHS: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

/** "09. September 2026" | "9.9.2026" | "09.09.2026" → "2026-09-09"; null when unparseable. */
export function parseGermanDate(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{1,2})\.\s*([\p{L}]+)\s+(\d{4})$/u.exec(t);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (!month) return null;
    return isoDate(Number(m[3]), month, Number(m[1]));
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

function isoDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseNewsList(html: string): NewsListEntry[] {
  const root = parse(html);
  const out: NewsListEntry[] = [];
  for (const item of root.querySelectorAll(".blog-item")) {
    const titleEl = item.querySelector("h2 a");
    if (!titleEl) continue;
    const title = titleEl.text.trim();
    const href = titleEl.getAttribute("href") ?? "";
    const url = href.startsWith("http") ? href : `${SCHOOL}${href}`;
    const idMatch = /\/(\d+)-[^/]*$/.exec(url);

    let author = "Unknown";
    const createdBy = item.querySelector(".createdby");
    if (createdBy?.text.includes("Geschrieben von")) {
      author = createdBy.text.replace("Geschrieben von", "").trim().split("\n")[0]!.trim();
    }

    let createdDate = "Unknown";
    let publishedAt: string | null = null;
    const create = item.querySelector(".create");
    if (create?.text.includes("Erstellt:")) {
      createdDate = create.text.replace("Erstellt:", "").trim().split("\n")[0]!.trim();
      const iso = create.querySelector("time")?.getAttribute("datetime");
      publishedAt = iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString() : parseGermanDate(createdDate);
    }

    let views = 0;
    const hits = item.querySelector(".hits");
    if (hits?.text.includes("Zugriffe:")) {
      views = Number(hits.text.replace("Zugriffe:", "").trim().replace(/[^0-9]/g, "")) || 0;
    }

    let description = "";
    const content = item.querySelector(".item-content");
    if (content) {
      description = content
        .querySelectorAll("p")
        .map((p) => p.text.trim())
        .filter((t) => t !== "")
        .slice(0, 2)
        .join(" ");
    }

    const tags = item
      .querySelectorAll("ul.tags.list-inline a")
      .map((a) => a.text.trim())
      .filter((t) => t !== "");

    out.push({
      id: idMatch ? Number(idMatch[1]) : null,
      title,
      author,
      description,
      createdDate,
      publishedAt,
      views,
      url,
      tags,
    });
  }
  return out;
}

const EMPTY: NewsArticleContent = { content: null, htmlContent: null, links: [], standaloneLinks: [], images: [], downloads: [] };

export function parseNewsArticle(html: string): NewsArticleContent {
  const root = parse(html);
  const body = root.querySelector(".com-content-article__body");
  if (!body) return { ...EMPTY };

  // ---- downloads (Phoca/K2 style doclink-insert) ----
  const downloads: NewsDownload[] = [];
  for (const a of body.querySelectorAll("a.doclink-insert")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    let title = a.getAttribute("data-title") ?? "";
    if (title === "") title = a.text.trim().replace(/\s*\([^)]+\)\s*$/, "").trim();

    let fileType = "document";
    const icon = a.querySelector('span[class*="k-icon-document"]');
    if (icon) {
      for (const cls of icon.classList.values()) {
        if (cls.startsWith("k-icon-document-")) {
          fileType = cls.replace("k-icon-document-", "");
          break;
        }
      }
    }
    if (fileType === "document") {
      const hidden = a.querySelector("span.k-visually-hidden")?.text.trim().toLowerCase();
      if (hidden) fileType = hidden;
    }

    let size: string | null = null;
    const sizeMatch = /\(([^)]+)\)/.exec(a.text);
    if (sizeMatch) {
      size = sizeMatch[1]!.trim();
      if (!/\d+\s*(MB|KB|GB|B|bytes?)/i.test(size)) size = null;
    }
    downloads.push({ title, url: absoluteUrl(href), fileType, size });
  }

  // ---- links: embedded vs standalone ----
  const links: NewsLink[] = [];
  const standaloneLinks: NewsLink[] = [];
  for (const a of body.querySelectorAll("a")) {
    if (a.classList.contains("doclink-insert")) continue;
    const href = a.getAttribute("href");
    const text = a.text.trim();
    if (!href || text === "") continue;
    const link = { text, url: absoluteUrl(href) };
    (isStandalone(a, href, link.url) ? standaloneLinks : links).push(link);
  }

  // ---- images: Simple Image Gallery + inline <img> ----
  const images: NewsImage[] = [];
  for (const gallery of body.querySelectorAll(".sigFreeContainer")) {
    for (const a of gallery.querySelectorAll("a.sigFreeLink")) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const thumb = a.getAttribute("data-thumb");
      const img = a.querySelector("img");
      images.push({
        url: absoluteUrl(href),
        thumbnailUrl: thumb ? absoluteUrl(thumb) : null,
        alt: img?.getAttribute("alt") ?? img?.getAttribute("title") ?? null,
      });
    }
  }
  for (const img of body.querySelectorAll("img")) {
    if (img.classList.contains("sigFreeImg")) continue;
    const src = img.getAttribute("src");
    if (!src) continue;
    const url = absoluteUrl(src);
    if (!images.some((i) => i.url === url)) images.push({ url, thumbnailUrl: null, alt: img.getAttribute("alt") ?? null });
  }

  // ---- text: clone, drop download + standalone links, keep embedded links ----
  const clone = body.clone() as HTMLElement;
  for (const a of clone.querySelectorAll("a.doclink-insert")) a.remove();
  // Gallery markup is reported via `images`; keep it out of the running text.
  for (const g of clone.querySelectorAll(".sigFreeContainer")) g.remove();
  for (const a of clone.querySelectorAll("a")) {
    if (a.classList.contains("doclink-insert")) continue;
    const href = a.getAttribute("href");
    const text = a.text.trim();
    if (!href || text === "") continue;
    if (isStandalone(a, href, absoluteUrl(href))) a.remove();
  }

  const paragraphs = clone.querySelectorAll("p");
  // ASCII trim only: a trailing non-breaking space is content, not padding.
  const cleanHtml = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  let htmlContent: string;
  let content: string;
  if (paragraphs.length === 0) {
    htmlContent = cleanHtml(clone.innerHTML);
    content = clone.text.trim();
  } else {
    htmlContent = paragraphs.map((p) => cleanHtml(p.innerHTML)).filter((h) => h !== "").join("\n\n");
    content = paragraphs.map((p) => p.text.trim()).filter((t) => t !== "").join("\n\n");
  }
  return { content, htmlContent, links, standaloneLinks, images, downloads };
}

function isStandalone(a: HTMLElement, href: string, fullUrl: string): boolean {
  const text = a.text.trim();
  const parent = a.parentNode;
  if (!parent) return false;
  const tag = parent.rawTagName?.toLowerCase();
  if (tag !== "p" && tag !== "div") return false;
  const parentText = parent.text.trim();
  return (
    text === fullUrl ||
    text === href ||
    (text.startsWith("http") && parentText === text) ||
    (text.startsWith("http") && parentText.length <= text.length + 5)
  );
}

/** Newest first by publishedAt; undated articles keep their list position. */
export function sortNewestFirst<T extends { publishedAt: string | null }>(articles: T[]): T[] {
  return articles
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      if (x.a.publishedAt && y.a.publishedAt) {
        const c = y.a.publishedAt.localeCompare(x.a.publishedAt);
        return c !== 0 ? c : x.i - y.i;
      }
      if (x.a.publishedAt) return -1;
      if (y.a.publishedAt) return 1;
      return x.i - y.i;
    })
    .map((x) => x.a);
}
