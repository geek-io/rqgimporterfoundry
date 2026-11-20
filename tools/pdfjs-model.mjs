// Node harness for the in-Foundry reader: node tools/pdfjs-model.mjs <file.pdf> <out.json> [from] [to]
import fs from "node:fs";
globalThis.foundry = { utils: { getRoute: (p) => p } };
// Needs pdfjs-dist installed for Node (npm i pdfjs-dist); PDFJS overrides the path to its legacy build.
const pdfjs = await import(process.env.PDFJS || "pdfjs-dist/legacy/build/pdf.mjs");
const { readPdf } = await import("../scripts/foundry/pdf-reader.js");
const [,, src, out, from = "1", to = "99999"] = process.argv;
const t0 = Date.now();
const model = await readPdf(fs.readFileSync(src).buffer, { from: +from, to: +to, pdfjs, onProgress: (d, t) => d % 50 === 0 && console.error(d, "/", t) });
fs.writeFileSync(out, JSON.stringify(model));
console.log("pages", model.pages.length, "secs", (Date.now() - t0) / 1000);
