// node tools/build-preview.mjs <entities.json> : builds Foundry data for every entity (sanity check)
import fs from "node:fs";
import { buildItem, buildNpcPlan, buildDescriptionJournal, buildChapterJournal, needsJournal } from "../scripts/core/builders.js";
const ents = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const book = { title: "RuneQuest: Roleplaying in Glorantha", key: "RQG Core Rulebook" };
const out = { items: [], journals: [], actors: [] };
for (const e of ents) {
  if (e.kind === "npc") out.actors.push(buildNpcPlan(book, e));
  else if (e.kind === "chapter") out.journals.push(buildChapterJournal(book, e));
  else { const it = buildItem(book, e); if (it) out.items.push(it); if (needsJournal(e)) out.journals.push(buildDescriptionJournal(book, e)); }
}
console.log({ items: out.items.length, journals: out.journals.length, actors: out.actors.length });
const pick = (n) => out.items.find((i) => i.name === n);
console.log(JSON.stringify(pick("Battle Axe").system.usage.twoHand), pick("Battle Axe").flags);
console.log(JSON.stringify(out.actors[0].wanted.slice(0, 40)));
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
