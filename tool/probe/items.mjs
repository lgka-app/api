import { readFileSync } from "node:fs";
import { getDocumentProxy } from "unpdf";
const file = process.argv[2];
const pdf = await getDocumentProxy(new Uint8Array(readFileSync(file)));
console.log("pages", pdf.numPages);
const page = await pdf.getPage(1);
const vp = page.getViewport({ scale: 1 });
console.log("viewport", vp.width, vp.height);
const tc = await page.getTextContent();
let n = 0;
for (const it of tc.items) {
  if (!("str" in it)) continue;
  const [a, b, c, d, x, y] = it.transform;
  console.log(`x=${x.toFixed(1)} y=${(vp.height - y).toFixed(1)} w=${it.width.toFixed(1)} h=${it.height.toFixed(1)} eol=${it.hasEOL?1:0} "${it.str}"`);
  if (++n > 140) break;
}
