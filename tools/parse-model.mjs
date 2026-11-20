// Offline harness: node tools/parse-model.mjs <model.json> [out.json]
import fs from "node:fs";
import { buildDocument } from "../scripts/core/layout.js";
import { parseBook } from "../scripts/core/parsers.js";
const [,, modelPath, outPath] = process.argv;
const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
const doc = buildDocument(model);
const ents = parseBook(doc, { includeChapters: true });
const counts = {};
for (const e of ents) counts[e.kind] = (counts[e.kind] || 0) + 1;
console.log(counts);
if (outPath) fs.writeFileSync(outPath, JSON.stringify(ents, null, 1));
