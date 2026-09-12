import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/hash";
import { readPdf } from "../src/lib/pdf";

describe("pdf layer", () => {
  it("does not detach or alter the caller's bytes (they are uploaded and hashed afterwards)", async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, "fixtures", "substitution", "heute_2026-09-12.pdf")));
    const before = await sha256Hex(bytes);
    const doc = await readPdf(bytes);
    expect(doc.pageCount).toBe(2);
    expect(bytes.byteLength).toBeGreaterThan(80_000);
    expect(await sha256Hex(bytes)).toBe(before);
  });

  it("groups words into lines with geometry", async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, "fixtures", "substitution", "heute_2026-09-12.pdf")));
    const doc = await readPdf(bytes);
    const header = doc.pages[0]!.lines.find((l) => l.text.startsWith("Art Stunde"));
    expect(header).toBeDefined();
    expect(header!.words.length).toBe(10);
    // "Vertret Fach" arrives merged from pdf.js; the split word is flagged as estimated
    expect(header!.words.filter((w) => w.estimated).map((w) => w.text)).toEqual(["Fach"]);
  });
});
