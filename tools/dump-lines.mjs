import fs from "node:fs";
import { buildDocument } from "../scripts/core/layout.js";
const [,, modelPath, from, to] = process.argv;
const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
const doc = buildDocument(model, { firstPage: Number(from), lastPage: Number(to) });
console.log(doc.stats);
for (const p of doc.pages) {
  console.log(`=== pdf ${p.n} printed ${p.printed} chapter ${p.chapter} gutter ${p.gutter}`);
  for (const l of p.lines) console.log(`${l.col} ${l.y.toFixed(0).padStart(4)} ${l.fam.slice(0,10).padEnd(10)} ${l.size} ${l.bold?"B":" "} ${l.boldLead?"["+l.boldLead+"]":""} ${l.text.slice(0,90)}`);
}
