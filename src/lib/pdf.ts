// Thin layer over pdf.js (via unpdf) that gives the parsers what they need:
// per-page plain text, and per-line word geometry for the Untis table layout.
import { getDocumentProxy } from "unpdf";

export interface Word {
  text: string;
  left: number;
  right: number;
  /** True when this word's x was estimated from a merged pdf.js item. */
  estimated: boolean;
}

export interface Line {
  y: number;
  words: Word[];
  text: string;
}

export interface PdfPage {
  index: number; // 0-based
  text: string;
  lines: Line[];
}

export interface PdfDocument {
  pageCount: number;
  pages: PdfPage[];
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

export async function readPdf(bytes: Uint8Array): Promise<PdfDocument> {
  // pdf.js takes ownership of (and detaches) the buffer it is given; hand it
  // a copy so callers can still upload / hash the original bytes afterwards.
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const pages: PdfPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = (content.items as unknown[]).filter(
        (it): it is TextItemLike =>
          typeof (it as TextItemLike).str === "string" && Array.isArray((it as TextItemLike).transform),
      );
      const lines = groupLines(items, viewport.height);
      pages.push({ index: i - 1, text: lines.map((l) => l.text).join("\n"), lines });
      page.cleanup();
    }
  } finally {
    await (doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => void }).destroy?.();
  }
  return { pageCount: pages.length, pages };
}

/** Groups pdf.js text items into visual lines (top-down, left-right). */
function groupLines(items: TextItemLike[], pageHeight: number): Line[] {
  type Raw = { text: string; left: number; right: number; y: number };
  const raws: Raw[] = [];
  for (const it of items) {
    if (it.str.trim() === "") continue;
    const x = it.transform[4] ?? 0;
    const y = pageHeight - (it.transform[5] ?? 0);
    raws.push({ text: it.str, left: x, right: x + it.width, y });
  }
  raws.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.left - b.left));

  const lines: Line[] = [];
  let currentY: number | null = null;
  for (const r of raws) {
    if (currentY === null || Math.abs(r.y - currentY) > 2) {
      currentY = r.y;
      lines.push({ y: r.y, words: [], text: "" });
    }
    lines[lines.length - 1]!.words.push(...splitWords(r));
  }
  for (const line of lines) {
    line.words.sort((a, b) => a.left - b.left);
    line.text = line.words.map((w) => w.text).join(" ");
  }
  return lines;
}

/**
 * pdf.js merges neighbouring glyph runs into one item when the gap is about a
 * space wide, so one item may hold several words. We split on whitespace and
 * estimate each word's x proportionally to its character offset; words after
 * the first are flagged `estimated`.
 */
function splitWords(r: { text: string; left: number; right: number }): Word[] {
  const parts: { text: string; start: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(r.text)) !== null) parts.push({ text: m[0], start: m.index });
  if (parts.length <= 1) {
    return [{ text: r.text.trim(), left: r.left, right: r.right, estimated: false }];
  }
  const perChar = (r.right - r.left) / Math.max(r.text.length, 1);
  return parts.map((p, i) => ({
    text: p.text,
    left: r.left + p.start * perChar,
    right: r.left + (p.start + p.text.length) * perChar,
    estimated: i > 0,
  }));
}
