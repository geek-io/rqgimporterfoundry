/**
 * Entity parsers for RuneQuest: Roleplaying in Glorantha books.
 * Input: a document from layout.buildDocument(). Output: plain "entity" records that are
 * independent of Foundry; builders.js turns them into RQG system documents.
 *
 * Entity: { kind, name, page, pdfPage, chapter, data: {...}, html }
 *   kind: spiritMagic | runeMagic | sorcery | weapon | armor | gear | skill | cult | npc | chapter
 */
import { chapterKey, cleanText, escapeHtml, linesToHtml, renderRich, slugify, tidyName } from "./layout.js";

const CHARS = ["STR", "CON", "SIZ", "DEX", "INT", "POW", "CHA"];
const SPELL_TRAIT_RE =
  /\b(Ranged|Touch|Self|Temporal|Instant|Permanent|Passive|Active|Ritual|Stackable|Nonstackable|Non-stackable|One-use|One use|Enchantment|Focused|Special|Duration)\b/i;
const SPELL_POINTS_RE = /^(Variable|[\dl]+(?:\s*(?:[–-]|or)\s*\d+)?\s+Points?|Special|Varies)\b\s*,?\s*(.*)$/i;

/* ------------------------------------------------------------------ helpers */

/** Join words broken across lines: "com- bat" -> "combat", but keep "single- or double". */
export function dehyphen(t) {
  return String(t).replace(/([A-Za-z])- ([a-z]+)/g, (m, a, b) => (/^(or|and|to|nor)$/.test(b) ? `${a}- ${b}` : a + b));
}

function headingLevel(line, stats) {
  if (!/[A-Za-z]{2}/.test(line.text)) return 0; // decorative glyphs set in big fonts
  return line.size / stats.bodySize;
}

function nextLines(doc, idx, n) {
  return doc.lines.slice(idx + 1, idx + 1 + n);
}

/** Lines following idx until a line at least as prominent as minSize or the stop predicate. */
function collectUntil(doc, startIdx, { minSize, fam, maxLines = 400, stop } = {}) {
  const out = [];
  const startPage = doc.lines[startIdx]?.page ?? 0;
  for (let i = startIdx; i < doc.lines.length && out.length < maxLines; i++) {
    const l = doc.lines[i];
    if (l.page - startPage > 6) break;
    if (minSize && l.size >= minSize && /[A-Za-z]{2}/.test(l.text) && (!fam || l.fam === fam || l.size >= minSize * 1.35)) break;
    if (stop && stop(l, i)) break;
    out.push(l);
  }
  return out;
}

function parsePrice(text) {
  const m = String(text).match(/Price:\s*([^.;]*)/i);
  if (!m) return null;
  const raw = cleanText(m[1]);
  const vals = [...raw.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:[–-]\s*(\d+(?:[.,]\d+)?)\s*)?(W|L|C|B|G|Wheels?|Lunars?|Clacks?)\b/gi)];
  if (!vals.length) return { raw, real: 0, estimated: 0 };
  const unit = (u) => {
    const c = u[0].toUpperCase();
    return c === "W" ? 20 : c === "C" ? 0.1 : c === "B" ? 0.01 : 1;
  };
  // Low end of the range is the price, high end is the estimate
  const first = vals[0];
  const last = vals[vals.length - 1];
  const low = Number(first[1].replace(",", ".")) * unit(first[3]);
  const highNum = last[2] ?? last[1];
  const high = Number(String(highNum).replace(",", ".")) * unit(last[3]);
  return { raw, real: round2(low), estimated: round2(Math.max(low, high)) };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function wordSet(s) {
  return cleanText(s)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["of", "the", "or", "and"].includes(w))
    .sort()
    .join(" ");
}

/* ----------------------------------------------------------------- tables */

/**
 * Generic table reader on raw (full width) lines. Finds header rows matching `isHeader`
 * and returns rows of {cellName: text}. Multi-line cells are merged onto the nearest data row.
 */
export function readTables(doc, isHeader, { dataTest, maxRows = 80 } = {}) {
  const tables = [];
  for (const page of doc.pages) {
    const raws = page.raw;
    // Header candidates: column lines first, then full-width raw lines (tables spanning the page)
    const cands = page.lines.filter((l) => isHeader(l));
    for (const r of raws) {
      if (!isHeader(r)) continue;
      const k = cands.findIndex((c) => Math.abs(c.y - r.y) < 3);
      if (k < 0) cands.push({ ...r, col: -1 });
      else if (r.words.length > cands[k].words.length && r.words.every((w) => w.fam === r.words[0].fam) && (page.gutter == null || r.words.some((w) => w.x < page.gutter && w.x1 > page.gutter)))
        cands[k] = { ...r, col: -1 };
    }
    for (const hdr of cands) {
      const i = Math.max(0, page.lines.findIndex((l) => Math.abs(l.y - hdr.y) < 3 && l.x0 <= hdr.x0 + 1));
      const cols = headerColumns(hdr);
      if (cols.length < 3) continue;
      const x0 = hdr.x0 - 12;
      const x1 = hdr.col === -1 ? hdr.x1 + 40 : Math.min(hdr.x1 + 40, hdr.col === 0 && page.gutter ? page.gutter + 2 : Infinity);
      const title = findTableTitle(page.lines, i, x0, x1);
      // collect candidate lines below (raw lines restricted to the header's horizontal span)
      const body = [];
      let lastY = hdr.y;
      for (const r of raws) {
        if (r.y <= hdr.y + 1) continue;
        if (body.length >= maxRows * 3) break;
        const words = r.words.filter((w) => w.x >= x0 && w.x1 <= x1);
        if (!words.length) continue;
        if (isHeader({ ...r, text: cleanText(words.map((w) => w.s).join(" ")) })) break;
        const famCount = {};
        for (const w of words) famCount[w.fam] = (famCount[w.fam] || 0) + 1;
        const fam = Object.entries(famCount).sort((a, b) => b[1] - a[1])[0][0];
        const sz = words[0].size;
        if (sz > hdr.size * 1.15) break; // next table title
        if (fam !== hdr.words[hdr.words.length - 1].fam && fam !== hdr.fam) break;
        if (r.y - lastY > hdr.size * 3.2) break;
        if (words.some((w) => w.bold) && words.every((w) => w.bold || !/[a-z]/i.test(w.s)) && !words.some((w) => /\d/.test(w.s)) && words.length >= 2 && body.length) break; // next table title
        if (sz < hdr.size * 0.75) continue; // footnotes
        body.push({ y: r.y, words });
        lastY = r.y;
      }
      const rows = assignRows(body, cols, dataTest);
      if (rows.length) tables.push({ page: page.n, printed: page.printed, chapter: page.chapter, title, header: hdr.text, y: hdr.y, col: hdr.col, cols: cols.map((c) => c.key), rows });
    }
  }
  return tables;
}

function findTableTitle(raws, i, x0, x1) {
  for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
    const words = raws[k].words.filter((w) => w.x >= x0 - 30 && w.x1 <= x1 + 30);
    if (!words.length) continue;
    if (words[0].size >= raws[i].size) {
      const parts = [cleanText(words.map((w) => w.s).join(" "))];
      // two line titles ("Hammers, Maces," / "& Clubs")
      const prev = raws[k - 1];
      if (prev && raws[k].y - prev.y < words[0].size * 1.6) {
        const pw = prev.words.filter((w) => w.x >= x0 - 30 && w.x1 <= x1 + 30 && w.size === words[0].size);
        if (pw.length) parts.unshift(cleanText(pw.map((w) => w.s).join(" ")));
      }
      return parts.join(" ");
    }
  }
  return "";
}

function headerColumns(hdr) {
  const cols = [];
  const ws = hdr.words;
  for (let i = 0; i < ws.length; i++) {
    let label = ws[i].s;
    let x = ws[i].x;
    let x1 = ws[i].x1;
    // merge multi-word labels: "Base %", "Area Covered", "Hit Location", "Move Quietly"
    while (
      i + 1 < ws.length &&
      ws[i + 1].x - x1 < 5 &&
      /^(%|Covered|Location|Quietly|Points?)$/i.test(ws[i + 1].s)
    ) {
      label += " " + ws[i + 1].s;
      x1 = ws[i + 1].x1;
      i++;
    }
    let key = label.toLowerCase().replace(/[^a-z0-9%/]+/g, "");
    if (cols.some((c) => c.key === key)) key = key + "2";
    cols.push({ key, label, x, x1 });
  }
  return cols;
}

function colFor(cols, w) {
  // column whose start is closest at or left of the word (with tolerance), using word centre
  const cx = (w.x + w.x1) / 2;
  let best = 0;
  for (let c = 0; c < cols.length; c++) {
    const start = c === 0 ? -Infinity : (cols[c - 1].x1 + cols[c].x) / 2 - 2;
    if (cx >= start) best = c;
  }
  // left aligned text cells: prefer the column whose start is just left of the word
  for (let c = cols.length - 1; c >= 0; c--) {
    if (w.x >= cols[c].x - 4) {
      if (c > best) return c;
      break;
    }
  }
  return best;
}

const NUMERIC_COL = /^(base%|str|dex|hp|enc|sr|length|range|rate|absorbs|cost|%|d20|pts|movequietly)$/;

function assignRows(body, cols, dataTest) {
  const lines = body.map((b) => {
    const cells = {};
    for (const w of b.words) {
      let ci = colFor(cols, w);
      if (/^\((1H|2H)\)$/i.test(w.s)) ci = 0;
      else if (ci > 0 && NUMERIC_COL.test(cols[ci].key) && /^[A-Za-z][a-z]{2,}$/.test(w.s) && !/^(Special|Arm|Leg|Head|Var)$/i.test(w.s) && !NUMERIC_COL.test(cols[ci - 1].key)) ci -= 1;
      const c = cols[ci].key;
      cells[c] = cells[c] ? cells[c] + " " + w.s : w.s;
    }
    return { y: b.y, cells };
  });
  const isData = (l) => (dataTest ? dataTest(l.cells) : Object.keys(l.cells).length >= Math.max(3, cols.length - 3));
  const data = lines.filter(isData).map((l) => ({ y: l.y, cells: { ...l.cells }, frags: [] }));
  if (!data.length) return [];
  for (const l of lines) {
    if (isData(l)) continue;
    let best = null;
    for (const d of data) {
      const dy = Math.abs(d.y - l.y);
      if (!best || dy < best.dy - 1.5 || (Math.abs(dy - best.dy) <= 1.5 && /,$/.test(Object.values(l.cells).join(" ")) && d.y > l.y)) {
        best = { d, dy };
      }
    }
    if (best && best.dy < 22) best.d.frags.push(l);
  }
  for (const d of data) {
    const parts = [...d.frags, { y: d.y, cells: d.cells, self: true }].sort((a, b) => a.y - b.y);
    const merged = {};
    for (const p of parts) {
      for (const [k, v] of Object.entries(p.cells)) merged[k] = merged[k] ? merged[k] + " " + v : v;
    }
    for (const k of Object.keys(merged)) merged[k] = cleanText(merged[k]);
    d.cells = merged;
  }
  return data.map((d) => d.cells);
}

/* ------------------------------------------------------------------ spells */

export function parseSpells(doc) {
  const out = [];
  const { stats } = doc;
  const L = doc.lines;
  for (let i = 0; i < L.length - 2; i++) {
    const h = L[i];
    if (headingLevel(h, stats) < 1.25) continue;
    let p = L[i + 1];
    let runeText = "";
    // Rune icons set in a symbol font between the name and the cost
    let skip = 0;
    while (p && skip < 2 && p.text.replace(/\s/g, "").length <= 4 && (p.size >= stats.bodySize * 1.8 || /rune|icon|symbol/i.test(p.fam))) {
      skip++;
      p = L[i + 1 + skip];
    }
    // optional rune line between heading and cost ("Rune varies depending on metal", "+ [Rune]")
    if (p && !SPELL_POINTS_RE.test(p.text) && p.bold && p.size <= stats.bodySize * 1.15 && L[p.idx + 1] && SPELL_POINTS_RE.test(L[p.idx + 1].text)) {
      runeText = p.text;
      p = L[p.idx + 1];
    }
    const pm = p && p.text.match(SPELL_POINTS_RE);
    if (!pm || p.size > stats.bodySize * 1.15) continue;
    // traits: rest of the points line + following bold lines
    let traits = pm[2] || "";
    let j = p.idx + 1;
    while (j < L.length && L[j].size <= stats.bodySize * 1.15 && (L[j].bold || (j === i + 2 && SPELL_TRAIT_RE.test(L[j].text) && L[j].text.length < 70))) {
      traits += (traits ? ", " : "") + L[j].text;
      j++;
      if (j - i > 5) break;
    }
    if (!SPELL_TRAIT_RE.test(traits) && !/variable/i.test(pm[1])) continue;
    const ck = chapterKey(h.chapter);
    let headText = h.text;
    const prevH = L[i - 1];
    if (prevH && prevH.size === h.size && prevH.page === h.page && prevH.col === h.col && h.y - prevH.y < h.size * 1.6 && !SPELL_POINTS_RE.test(prevH.text)) headText = prevH.text + " " + h.text;
    let kind;
    if (/sorcery/.test(ck)) kind = "sorcery";
    else if (/spiritmagic/.test(ck)) kind = "spiritMagic";
    else if (/runemagic|runecult|cult/.test(ck)) kind = "runeMagic";
    else if (/stackable|one-?use/i.test(traits)) kind = "runeMagic";
    else kind = "spiritMagic";
    const descLines = collectUntil(doc, j, {
      minSize: h.size - 0.6,
      fam: h.fam,
      stop: (l) => chapterKey(l.chapter) !== ck && l.page !== h.page,
    });
    const name = tidyName(headText);
    out.push({
      kind,
      name,
      page: h.printed,
      pdfPage: h.page,
      chapter: h.chapter,
      data: { ...spellData(pm[1], traits, kind, descLines.map((l) => l.text).join(" ")), runeText },
      html: linesToHtml(descLines, stats),
    });
    i = j - 1;
  }
  return dedupe(out);
}

function spellData(pointsText, traitsText, kind, descText) {
  const t = traitsText.toLowerCase();
  const pts = pointsText.replace(/^l\b/, "1").match(/(\d+)/);
  const d = {
    pointsText: cleanText(pointsText),
    traits: cleanText(traitsText),
    points: pts ? Number(pts[1]) : 1,
    isVariable: /variable/i.test(pointsText),
    castingRange: /\bself\b/.test(t) ? "self" : /\btouch\b/.test(t) ? "touch" : /\branged\b/.test(t) ? "ranged" : /special/.test(t) ? "special" : "",
    duration: /\binstant\b/.test(t)
      ? "instant"
      : /\bpermanent\b|enchantment/.test(t)
        ? "permanent"
        : /\bfocused\b/.test(t)
          ? "focused"
          : /\btemporal\b/.test(t)
            ? "temporal"
            : /special/.test(t)
              ? "special"
              : "",
    concentration: /\bactive\b/.test(t) && !/\bpassive\b/.test(t.split("then")[0]) ? "active" : "passive",
    isRitual: /\britual\b/.test(t),
    isEnchantment: /enchantment/.test(t),
    isStackable: /(^|[^n-])stackable/.test(t) && !/nonstackable|non-stackable/.test(t),
    isOneUse: /one-?\s?use/.test(t),
    resistedBy: /resistance roll|overcome (?:the )?(?:target|victim|their|its|the).{0,25}(?:pow|magic points)/i.test(descText) ? "resistanceRoll" : "none",
  };
  if (kind === "spiritMagic") delete d.isStackable;
  return d;
}

/* ----------------------------------------------------------------- weapons */

const MELEE_HDR = (l) => /\bBase %/.test(l.text) && /\bDamage\b/.test(l.text) && /\b(SR|Length)\b/.test(l.text) && !/\bRange\b/.test(l.text) && !/^Size\b/.test(l.text);
const MISSILE_HDR = (l) => /\bBase %/.test(l.text) && /\bDamage\b/.test(l.text) && /\bRange\b/.test(l.text);
const SHIELD_HDR = (l) => /^Size\s+Type\s+Base %/.test(l.text);
const ARMOR_HDR = (l) => /\bAbsorbs\b/.test(l.text) && /\bMaterial\b/.test(l.text);

function encOf(s) {
  if (!s) return 0;
  const m = String(s).match(/\((\d+)\)/);
  if (m) return round2(1 / Number(m[1]));
  const n = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function intOf(s) {
  const m = String(s ?? "").match(/-?\d+/);
  return m ? Number(m[0]) : 0;
}

function rateOf(s) {
  s = String(s || "").replace(/^l/, "1");
  if (/^S\/MR/i.test(s)) return 0;
  const m = s.match(/1\/(\d*)\s*M?R/i);
  if (m) return m[1] ? Number(m[1]) : 1;
  return 0;
}

const DAMAGE_TYPES = {
  C: [{ name: "Bash", damageType: "crush" }],
  S: [{ name: "Cut", damageType: "slash" }],
  I: [{ name: "Thrust", damageType: "impale" }],
  CT: [
    { name: "Cut", damageType: "slash" },
    { name: "Thrust", damageType: "impale" },
  ],
  H: [{ name: "Hit", damageType: "crush" }],
};

function usageKeyFromCategory(cat, name) {
  const c = (cat || "").toLowerCase();
  if (/two-?handed|\(2h\)/.test(c)) return "twoHand";
  return "oneHand";
}

/** RQG skill name for a melee weapon table row. */
export function meleeSkillName(cat, name) {
  const c = cleanText(cat || "");
  const base = c.replace(/,?\s*(One|Two)-handed\s*\((1H|2H)\)/i, "").replace(/,\s*$/, "").trim();
  const hands = /\((1H|2H)\)/i.exec(c)?.[1]?.toUpperCase();
  if (/^sword/i.test(base)) return tidyName(name).replace(/,.*$/, "").trim(); // swords train per weapon
  if (/^dagger/i.test(base)) return "Dagger";
  if (hands) return `${hands} ${base}`.replace(/\s+/g, " ");
  return base || tidyName(name);
}

export function parseWeapons(doc) {
  const byName = new Map();
  const get = (name) => {
    const key = wordSet(name);
    if (!byName.has(key)) byName.set(key, { name: tidyName(name), usages: {}, rows: [] });
    return byName.get(key);
  };
  const isData = (c) => /\d/.test(c["base%"] || "") || /\d/.test(c.damage || "");

  for (const t of readTables(doc, MELEE_HDR, { dataTest: isData })) {
    for (const r of t.rows) {
      const name = r.name || r.type;
      if (!name) continue;
      const w = get(name);
      const usage = usageKeyFromCategory(r.category, name);
      const natural = /^(fist|kick|grapple|head ?butt)$/i.test(name);
      w.rows.push({ ...r, table: t.title, page: t.printed, pdfPage: t.page });
      w.page ??= t.printed;
      w.pdfPage ??= t.page;
      w.hp = w.hp ?? (/^\d+$/.test(r.hp) ? Number(r.hp) : null);
      w.hpLocation = /^(arm|leg)$/i.test(r.hp || "") ? r.hp : w.hpLocation;
      w.enc = w.enc ?? encOf(r.enc);
      w.length = w.length ?? r.length;
      w.isNatural = w.isNatural || natural;
      w.usages[usage] = {
        skill: meleeSkillName(r.category, name),
        base: intOf(r["base%"]),
        minStrength: intOf(r.str),
        minDexterity: intOf(r.dex),
        damage: cleanText(r.damage || "").replace(/\*$/, ""),
        sr: intOf(r.sr),
        type: (r.type2 || r.type || "").trim(),
      };
    }
  }
  for (const t of readTables(doc, MISSILE_HDR, { dataTest: isData })) {
    for (const r of t.rows) {
      const name = r.type || r.name;
      if (!name) continue;
      const w = get(name);
      w.rows.push({ ...r, table: t.title, page: t.printed, pdfPage: t.page });
      w.page ??= t.printed;
      w.pdfPage ??= t.page;
      w.hp = w.hp ?? (/^\d+$/.test(r.hp) ? Number(r.hp) : null);
      w.enc = w.enc ?? encOf(r.enc);
      w.range = intOf(r.range);
      w.rate = rateOf(r.rate);
      const cat = (r.category || "").toLowerCase();
      w.missileKind = /bow|crossbow|sling|atlatl/.test(cat) ? "projectileWeapon" : "thrown";
      w.usages.missile = {
        skill: missileSkillName(r.category, name),
        base: intOf(r["base%"]),
        minStrength: intOf(r.str),
        minDexterity: intOf(r.dex),
        damage: cleanText(r.damage || "").replace(/\*$/, ""),
        sr: null,
        type: (r.type2 || "").trim(),
      };
    }
  }
  for (const t of readTables(doc, SHIELD_HDR, { dataTest: isData })) {
    for (const r of t.rows) {
      const size = tidyName(r.size || "");
      if (!size) continue;
      const w = get(`${size} Shield`);
      w.isShield = true;
      w.rows.push({ ...r, table: t.title, page: t.printed, pdfPage: t.page });
      w.page ??= t.printed;
      w.pdfPage ??= t.page;
      w.hp = intOf(r.hp);
      w.enc = encOf(r.enc);
      w.material = r.type;
      w.usages.oneHand = {
        skill: `${size} Shield`,
        base: intOf(r["base%"]),
        minStrength: intOf(r.str),
        minDexterity: 0,
        damage: cleanText(r.damage || ""),
        sr: intOf(r.sr),
        type: "C",
        shield: true,
      };
    }
  }
  return [...byName.values()].map((w) => ({
    kind: "weapon",
    name: w.name,
    page: w.page,
    pdfPage: w.pdfPage,
    chapter: "",
    data: w,
    html: "",
  }));
}

function missileSkillName(cat, name) {
  const c = cleanText(cat || "");
  if (/javelin/i.test(c)) return "Javelin";
  if (/^axe/i.test(c)) return "Throwing Axe";
  if (/^dagger/i.test(c)) return "Throwing Dagger";
  if (/^rock/i.test(c)) return "Throw";
  return c || tidyName(name);
}

/* ------------------------------------------------------------------- armor */

const ARMOR_TYPE_KEYS = {
  hood: "Hood",
  "broad-brimmed hat": "BroadBrimmedHat",
  cap: "Cap",
  "composite helm": "CompositeHelm",
  "open helm": "OpenHelm",
  "closed helm": "ClosedHelm",
  "full helm": "FullHelm",
  sleeves: "Sleeves",
  vambraces: "Vambraces",
  cuirass: "Cuirass",
  linothorax: "Linothorax",
  segmented: "Segmented",
  hauberk: "Hauberk",
  skirt: "Skirt",
  skirts: "Skirt",
  "pants/trews": "PantsTrews",
  greaves: "Greaves",
};
const MATERIAL_KEYS = {
  leather: "Leather",
  "heavy leather": "HeavyLeather",
  "studded leather": "StuddedLeather",
  cuirboilli: "Cuirboilli",
  linen: "Linen",
  quilted: "Quilted",
  "ring mail": "BronzeRingMail",
  turtleshell: "TurtleShell",
  "light scale": "LightBronzeScale",
  "heavy scale": "HeavyBronzeScale",
  "segmented bronze plate": "SegmentedBronzePlate",
  "bronze plate": "BronzePlate",
  "disk plate": "BronzeDiskPlate",
  "iron plate": "IronPlate",
  plate: "BronzePlate",
};
const AREA_LOCATIONS = {
  head: ["head"],
  arms: ["left-arm", "right-arm"],
  chest: ["chest"],
  abdomen: ["abdomen"],
  legs: ["left-leg", "right-leg"],
};

export function parseArmor(doc) {
  const out = [];
  const isData = (c) => /\d/.test(c.absorbs || "") || /\*\*/.test(c.absorbs || "");
  for (const t of readTables(doc, ARMOR_HDR, { dataTest: isData })) {
    for (const r of t.rows) {
      const type = cleanText(r.type || "").replace(/[†*]/g, "").trim();
      let material = cleanText(r.material || "").replace(/[†*]/g, "").trim();
      if (!type || !material) continue;
      const locs = [];
      for (const [k, v] of Object.entries(AREA_LOCATIONS)) if (new RegExp(`\\b${k}\\b`, "i").test(r.areacovered || "")) locs.push(...v);
      const typeKey = ARMOR_TYPE_KEYS[type.toLowerCase()] ?? type;
      if (typeKey === "Segmented" && /bronze plate/i.test(material)) material = "Segmented Bronze Plate";
      const matKey = MATERIAL_KEYS[material.toLowerCase()] ?? material;
      const name = `${type}, ${material.replace(/^Plate$/, "Bronze Plate").replace(/^Segmented /, "")}`;
      out.push({
        kind: "armor",
        name: tidyName(name),
        page: t.printed,
        pdfPage: t.page,
        chapter: t.chapter,
        data: {
          area: r.areacovered,
          hitLocations: r.hitlocation,
          locations: locs,
          armorType: typeKey,
          material: matKey,
          materialLabel: material,
          typeLabel: type,
          absorbs: intOf(r.absorbs),
          enc: encOf((r.enc || "").replace(/\*/g, "")),
          price: intOf(r.cost),
          moveQuietly: intOf((r.movequietly || "").replace("–", "-")),
          wornUnder: /\*\*/.test(r.absorbs || ""),
        },
        html: "",
      });
    }
  }
  return dedupe(out);
}

/* ---------------------------------------------- "Name: text. Price: x" runs */

/** Paragraphs that start with a bold lead-in, e.g. "Belt, Sword: A leather belt ... Price: 1 L." */
export function boldLeadParagraphs(doc, chapterTest) {
  const out = [];
  const L = doc.lines;
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (!l.boldLead || l.fam !== doc.stats.bodyFamily) continue;
    if (chapterTest && !chapterTest(chapterKey(l.chapter))) continue;
    const lead = l.boldLead.trim();
    if (!/[:.]$/.test(lead) || lead.length > 60) continue;
    const lines = [l];
    for (let j = i + 1; j < L.length && lines.length < 25; j++) {
      const n = L[j];
      if (n.boldLead && /[:.]$/.test(n.boldLead.trim()) && n.boldLead.length < 60) break;
      if (n.size > doc.stats.bodySize * 1.08) break;
      if (n.fam !== doc.stats.bodyFamily) continue;
      if (n.x0 > n.margin + 5 && n.x0 - n.margin < 40) break; // indented = new paragraph
      lines.push(n);
      if (/Price:[^.]*\.\s*$/.test(n.text) && /[.]$/.test(n.text)) break;
    }
    const text = dehyphen(lines.map((x) => x.text).join(" "));
    out.push({ lead: lead.replace(/[:.]$/, "").trim(), text, line: l, lines });
  }
  return out;
}

/** Attach "Name: description. Price: X" paragraphs to weapons/armor by name. */
export function attachDescriptions(doc, entities) {
  const paras = boldLeadParagraphs(doc, (ck) => /combat|equipment|weapon|armor/.test(ck));
  const index = new Map();
  for (const e of entities) index.set(wordSet(e.name), e);
  for (const p of paras) {
    const names = expandLead(p.lead);
    for (const n of names) {
      const e = index.get(wordSet(n));
      if (!e || e.html) continue;
      const body = p.text.slice(p.text.indexOf(p.lead) + p.lead.length).replace(/^[:.]\s*/, "");
      e.html = `<p>${escapeHtml(body)}</p>`;
      const price = parsePrice(p.text);
      if (price) e.data.price = e.data.price || price.real, (e.data.priceEstimated = price.estimated), (e.data.priceText = price.raw);
    }
  }
}

/** "Spear, Long or Short" -> ["Spear, Long", "Spear, Short"]; "Helmet, Open" -> also "Open Helm". */
function expandLead(lead) {
  const out = [lead];
  const m = lead.match(/^([^,]+),\s*(.+)$/);
  if (m) {
    const alts = m[2].split(/\s+or\s+|\s*\/\s*/);
    for (const a of alts) out.push(`${m[1]}, ${a}`);
    if (/^helmet$/i.test(m[1])) for (const a of alts) out.push(`${a} Helm`);
  }
  return out;
}

/* -------------------------------------------------------------------- gear */

export function parseGear(doc, known = new Set()) {
  const out = [];
  let section = "";
  const sections = new Map();
  for (const l of doc.lines) {
    if (l.size >= doc.stats.bodySize * 1.3 && l.size < doc.stats.bodySize * 1.9) sections.set(l.idx, tidyName(l.text));
  }
  const sectionAt = (idx) => {
    let s = "";
    for (const [k, v] of sections) if (k <= idx) s = v;
    return s;
  };
  for (const p of boldLeadParagraphs(doc, (ck) => /equipment|wealth|market|gear/.test(ck))) {
    if (!/Price:/i.test(p.text)) continue;
    const name = tidyName(p.lead);
    if (known.has(wordSet(name))) continue;
    const price = parsePrice(p.text);
    let body = p.text.slice(p.text.indexOf(p.lead) + p.lead.length).replace(/^[:.]\s*/, "");
    section = sectionAt(p.line.idx);
    out.push({
      kind: "gear",
      name,
      page: p.line.printed,
      pdfPage: p.line.page,
      chapter: p.line.chapter,
      data: { price: price?.real ?? 0, priceEstimated: price?.estimated ?? 0, priceText: price?.raw ?? "", category: section },
      html: `<p>${escapeHtml(body)}</p>`,
    });
  }
  return dedupe(out);
}

/* ------------------------------------------------------------------ skills */

const SKILL_CATEGORIES = {
  agility: ["Boat", "Climb", "Dodge", "Drive", "Jump", "Ride", "Swim"],
  communication: ["Act", "Art", "Bargain", "Charm", "Dance", "Disguise", "Fast Talk", "Intimidate", "Intrigue", "Orate", "Sing", "Speak"],
  knowledge: [
    "Animal Lore", "Battle", "Celestial Lore", "Cult Lore", "Customs", "Elder Race Lore", "Evaluate", "Farm", "First Aid", "Game", "Herd",
    "Homeland", "Library Use", "Manage Household", "Mineral Lore", "Peaceful Cut", "Plant Lore", "Read/Write", "River Lore", "Shiphandling",
    "Survival", "Treat Disease", "Treat Poison", "Craft", "Lore",
  ],
  magic: ["Meditate", "Prepare Corpse", "Spirit Combat", "Spirit Dance", "Spirit Lore", "Spirit Travel", "Worship", "Sense Assassin", "Sense Chaos", "Sorcery"],
  manipulation: ["Conceal", "Devise", "Play Instrument", "Sleight", "Martial Arts"],
  perception: ["Insight", "Listen", "Scan", "Search", "Track"],
  stealth: ["Hide", "Move Quietly"],
};

export function skillCategory(name) {
  for (const [cat, list] of Object.entries(SKILL_CATEGORIES)) {
    for (const s of list) if (name === s || name.startsWith(s + " ") || name.startsWith(s + "(") || name.startsWith(s + " (")) return cat;
  }
  return "otherSkills";
}

export function parseSkills(doc) {
  const out = [];
  const L = doc.lines;
  for (let i = 0; i < L.length; i++) {
    const h = L[i];
    if (!/^skills$/.test(chapterKey(h.chapter))) continue;
    if (headingLevel(h, doc.stats) < 1.08 || h.fam === doc.stats.bodyFamily) continue;
    const m = h.text.match(/^(.+?)\s*\(([^()]*)\)\s*$/);
    if (!m) continue;
    const baseRaw = m[2].trim();
    if (!/^(\d+|\d+\s*\/\s*\d+|[A-Z]{3}\s*[x×]\s*\d+|var\.?|varies|special|\d+\s*or\s*\d+|own.*)$/i.test(baseRaw)) continue;
    let name = tidyName(m[1]);
    const lines = collectUntil(doc, i + 1, { minSize: h.size - 0.6, fam: h.fam, stop: (l) => !/^skills$/.test(chapterKey(l.chapter)) });
    const spec = name.match(/^(.*?)\s*\((.*)\)$/);
    out.push({
      kind: "skill",
      name,
      page: h.printed,
      pdfPage: h.page,
      chapter: h.chapter,
      data: {
        skillName: spec ? spec[1] : name,
        specialization: spec ? spec[2] : "",
        baseChance: /^\d+/.test(baseRaw) ? Number(baseRaw.match(/^\d+/)[0]) : 0,
        baseText: baseRaw,
        category: skillCategory(name),
      },
      html: linesToHtml(lines, doc.stats),
    });
  }
  return dedupe(out);
}

/** Weapon skills implied by the weapon tables (base chances from the tables). */
export function weaponSkills(weapons) {
  const map = new Map();
  for (const w of weapons) {
    for (const [usage, u] of Object.entries(w.data.usages)) {
      if (!u.skill || map.has(u.skill)) continue;
      const cat = u.shield ? "shields" : usage === "missile" ? "missileWeapons" : w.data.isNatural ? "naturalWeapons" : "meleeWeapons";
      map.set(u.skill, {
        kind: "skill",
        name: u.skill,
        page: w.page,
        pdfPage: w.pdfPage,
        chapter: "",
        data: { skillName: u.skill, specialization: "", baseChance: u.base, baseText: String(u.base), category: cat, fromWeaponTable: true },
        html: "",
      });
    }
  }
  return [...map.values()];
}

/* ------------------------------------------------------------------- cults */

export function parseCults(doc) {
  const out = [];
  const L = doc.lines;
  const { bodySize } = doc.stats;
  for (let i = 0; i < L.length; i++) {
    const h = L[i];
    if (headingLevel(h, doc.stats) < 1.3 || h.size > bodySize * 2) continue;
    if (!/cult/.test(chapterKey(h.chapter))) continue;
    // Must have a "Holy Days" subheading before the next heading of the same size
    const block = collectUntil(doc, i + 1, { minSize: h.size - 0.6, fam: h.fam, maxLines: 700 });
    const hasHoly = block.slice(0, 60).some((l) => /^holy days?$/i.test(l.text) && l.size > bodySize);
    if (!hasHoly) continue;
    let tagLine = block[0] && block[0].size > bodySize * 1.03 && !/^holy days?$/i.test(block[0].text) ? block[0].text : "";
    if (tagLine && /,$/.test(tagLine) && block[1] && block[1].size === block[0].size) tagLine += " " + block[1].text;
    const field = (re) => {
      const idx = block.findIndex((l) => l.boldLead && re.test(l.boldLead));
      if (idx < 0) return "";
      let t = block[idx].text.slice(block[idx].boldLead.length).trim();
      for (let k = idx + 1; k < block.length && !block[k].boldLead && block[k].size <= bodySize * 1.03; k++) t += " " + block[k].text;
      return cleanText(dehyphen(t));
    };
    const section = (re) => {
      const idx = block.findIndex((l) => re.test(l.text) && l.size > bodySize * 1.03);
      if (idx < 0) return "";
      const parts = [];
      for (let k = idx + 1; k < block.length && block[k].size <= bodySize * 1.03; k++) parts.push(block[k].text);
      return cleanText(dehyphen(parts.join(" ")));
    };
    out.push({
      kind: "cult",
      name: tidyName(h.text),
      page: h.printed,
      pdfPage: h.page,
      chapter: h.chapter,
      data: {
        tagline: tagLine,
        holyDays: section(/^holy days?$/i),
        cultSkills: field(/^Cult Skills/i),
        spiritMagic: field(/^Spirit Magic/i),
        commonRuneMagic: field(/^Common Rune Magic/i),
        specialRuneMagic: field(/^Special Rune Magic/i),
        enchantments: field(/^Enchantments/i),
        favoredPassions: field(/^Favored Passions/i),
        gifts: section(/\bgifts?\b/i),
        geases: section(/\bgeas(es)?\b/i),
      },
      html: linesToHtml(block, doc.stats),
    });
  }
  return dedupe(out);
}

/* -------------------------------------------------------------------- NPCs */

const collapse = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");

const CHAR_RE = /\b(STR|CON|SIZ|DEX|INT|POW|CHA):?\s+(\d{1,3}|—|-)(?=\s|$|,|;)/g;

const ATTACK_HDR = (l) => /^Weapons?\**\s+%\s+Damage/i.test(l.text);
const HITLOC_HDR = (l) => /^Location\s+D20\s+(Armor|AP)\s*\/\s*HP/i.test(l.text);
const CHAR_TOKEN = /^(STR|CON|SIZ|DEX|INT|POW|CHA)$/;

/** Characteristics as "STR 16 CON 12 ..." pairs, or a header row "STR CON SIZ ..." over a value row. */
function readCharacteristics(L, i) {
  const l = L[i];
  const pairs = [...l.text.matchAll(CHAR_RE)];
  if (pairs.length >= 3) {
    const chars = {};
    let j = i;
    for (; j < L.length && j < i + 3; j++) {
      const ps = [...L[j].text.matchAll(CHAR_RE)];
      if (!ps.length && j > i) break;
      for (const p of ps) if (!chars[p[1]]) chars[p[1]] = p[2];
    }
    return Object.keys(chars).length >= 4 ? { chars, end: j } : null;
  }
  const toks = l.text.split(/\s+/);
  if (toks.length < 4 || !toks.every((t) => CHAR_TOKEN.test(t))) return null;
  const v = L[i + 1];
  if (!v || v.page !== l.page) return null;
  const vals = v.text.split(/\s+/);
  if (vals.length !== toks.length || !vals.every((x) => /^(\d{1,3}\**|—|–|-)$/.test(x))) return null;
  return { chars: Object.fromEntries(toks.map((t, n) => [t, vals[n].replace(/\*+$/, "")])), end: i + 2 };
}

export const RUNE_TYPES = {
  Fire: "element", Sky: "element", Air: "element", Moon: "element", Darkness: "element", Earth: "element", Water: "element",
  Man: "form", Beast: "form", Plant: "form", Chaos: "form", Spirit: "form", Dragonewt: "form",
  Fertility: "power", Death: "power", Harmony: "power", Disorder: "power", Truth: "power", Illusion: "power", Stasis: "power", Movement: "power",
  Magic: "condition", Infinity: "condition", Mastery: "condition", Luck: "condition", Fate: "condition",
};

/**
 * Rune diagrams on character sheets: bold Rune names with their percentages printed below them.
 * Each digit is given to the nearest label above it (digits of one number can come as one run, "6000").
 */
export function readRuneDiagram(doc, pageN) {
  const pg = doc.pages.find((p) => p.n === pageN);
  if (!pg) return [];
  const words = pg.raw.flatMap((r) => r.words);
  const labels = words.filter((w) => w.bold && RUNE_TYPES[w.s.replace(/[^A-Za-z]/g, "")] && w.s.length <= 12);
  if (labels.length < 4) return [];
  const digits = [];
  for (const w of words) {
    if (!/^\d{1,6}$/.test(w.s)) continue;
    const cw = w.w / w.s.length;
    for (let k = 0; k < w.s.length; k++) digits.push({ ch: w.s[k], cx: w.x + (k + 0.5) * cw, y: w.y, size: w.size });
  }
  const got = new Map();
  for (const d of digits) {
    let best = null;
    for (const lab of labels) {
      const dy = d.y - lab.y;
      const dx = Math.abs(d.cx - (lab.x + lab.x1) / 2);
      if (dy < 2 || dy > 42 || dx > 40) continue;
      const score = dx + dy * 0.6;
      if (!best || score < best.score) best = { lab, score };
    }
    if (!best) continue;
    if (!got.has(best.lab)) got.set(best.lab, []);
    got.get(best.lab).push(d);
  }
  const out = [];
  for (const [lab, ds] of got) {
    ds.sort((a, b) => a.cx - b.cx);
    const value = Number(ds.map((d) => d.ch).join(""));
    if (!Number.isFinite(value) || value > 100 || ds.length > 3) continue;
    const rune = lab.s.replace(/[^A-Za-z]/g, "");
    if (out.some((r) => r.rune === rune)) continue;
    out.push({ rune, type: RUNE_TYPES[rune], value });
  }
  return out;
}

const ATTRIBUTE_FIELDS = /^(Hit Points|Move|Strike Rank|Rune Points|Magic Points|DEX SR|SIZ SR|Base SR|Damage Bonus|Healing Rate|Spirit Combat Damage)$/i;

export function parseNpcs(doc) {
  const out = [];
  const L = doc.lines;
  const { bodySize } = doc.stats;
  const attackTables = readTables(doc, ATTACK_HDR, { dataTest: (c) => /\d/.test(c["%"] || "") });
  const locTables = readTables(doc, HITLOC_HDR, { dataTest: (c) => /\d/.test(c.d20 || "") || /\//.test(c["armor/hp"] || c["ap/hp"] || "") || !!c.quality });
  const used = new Set();

  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (/\bvs\.?\b|×|resistance/i.test(l.text)) continue;
    const cr = readCharacteristics(L, i);
    // "STR 16 CON 12" pairs only count in the body font (sidebars quote characteristics in prose)
    if (cr && !/^STR\s+CON/.test(l.text) && l.fam !== doc.stats.bodyFamily) continue;
    if (!cr) continue;
    const { chars } = cr;
    const j = cr.end;

    // Name: bold lines directly above the stat block ("Hungry" / "Great Troll (Uzdo)"),
    // otherwise the nearest heading above it.
    let nameLine = null;
    let subtitle = "";
    const stack = [];
    for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
      const x = L[k];
      if (x.page !== l.page || !/[A-Za-z]/.test(x.text) || /:$/.test(x.text) || x.text.length > 90) break;
      if (!(x.bold || x.size >= bodySize * 1.2)) break;
      if (x.fam !== doc.stats.bodyFamily && x.size >= bodySize * 1.3 && stack.length) break;
      if (stack.length && stack[0].y - x.y > x.size * 2.6) break;
      stack.unshift(x);
    }
    let bioStart = i;
    if (stack.length) {
      // the name is the most prominent of those lines; smaller ones are a subtitle ("Initiate of ... Male, 26")
      nameLine = stack.find((x) => x.text.length <= 60) ?? stack[0];
      subtitle = stack.filter((x) => x !== nameLine && x.idx > nameLine.idx).map((x) => x.text).join(" ");
      bioStart = stack[0].idx;
    } else {
      for (let k = i - 1; k >= 0 && k >= i - 40; k--) {
        if (L[k].page < l.page - 2) break;
        if (headingLevel(L[k], doc.stats) >= 1.25 && !/attacks|hit locations/i.test(L[k].text)) {
          nameLine = L[k];
          bioStart = k + 1;
          break;
        }
      }
    }
    // A big heading above with only prose between (pregenerated adventurers) gives title and biography
    let titleLine = null;
    for (let k = (nameLine ? nameLine.idx : i) - 1; k >= 0 && k >= i - 160; k--) {
      if (L[k].page < l.page - 2) break;
      if (L[k].size >= bodySize * 1.8 && /[A-Za-z]{3}/.test(L[k].text)) {
        titleLine = L[k];
        break;
      }
      if (headingLevel(L[k], doc.stats) >= 1.08) break;
    }
    const name = nameLine ? tidyName(nameLine.text) : `Unnamed (p.${l.printed ?? l.page})`;

    // Labeled fields after the characteristics
    const fields = {};
    let cur = null;
    let curLine = null;
    let lastIdx = j - 1;
    const inline = L.slice(i, j).map((x) => x.text).join(" ");
    for (const m of inline.matchAll(/(Hit Points|Move|DEX SR|SIZ SR|Base SR):\s*([^:]+?)(?=\s+[A-Z][A-Za-z ]+:|$)/g)) fields[m[1]] = m[2].trim();
    for (let k = j; k < L.length && k < j + 80; k++) {
      const x = L[k];
      if (headingLevel(x, doc.stats) >= 1.25) {
        // character sheets put the fields under a heading ("Gear, Treasure & Abilities"): keep going if labels follow
        const nx = L[k + 1];
        if (nx && nx.page === x.page && nx.boldLead && /:$/.test(nx.boldLead) && x.text.length < 40) continue;
        break;
      }
      if (readCharacteristics(L, k)) break;
      if (x.page > l.page + 1) break;
      const isField = x.boldLead && /:$/.test(x.boldLead) && x.boldLead.length <= 45;
      const isCont = !isField && cur && curLine && x.fam === curLine.fam && x.size === curLine.size && x.page === curLine.page && x.col === curLine.col && x.y - curLine.y < x.size * 2;
      if (!isField && !isCont) {
        // prose after the stat block ends it; tables between fields are skipped
        if (Object.keys(fields).length && (x.fam === doc.stats.bodyFamily || x.fam === curLine?.fam) && !/^[A-Z][A-Za-z ]+ \d+$/.test(x.text)) break;
        cur = null;
        lastIdx = k;
        continue;
      }
      if (isField) {
        // a line may contain two labels ("Hit Points: 23 Move: 12")
        const segs = x.text.split(/\s(?=(?:Hit Points|Move|DEX SR|SIZ SR|Base SR|Basic SR|Combat):)/);
        for (const sg of segs) {
          const m = sg.match(/^([^:]{2,40}):\s*(.*)$/);
          if (m) {
            cur = m[1].trim();
            fields[cur] = m[2].trim();
          }
        }
        curLine = x;
        lastIdx = k;
      } else {
        fields[cur] = (fields[cur] + " " + x.text).trim();
        curLine = x;
        lastIdx = k;
      }
    }
    for (const key of Object.keys(fields)) fields[key] = cleanText(dehyphen(fields[key]));

    // Tables: the attack / hit location tables nearest after the characteristics
    const after = (t) => t.page > l.page || (t.page === l.page && (t.y > l.y || t.col !== l.col));
    const pick = (tables) => {
      const first = name.split(/[\s,]/)[0].toLowerCase();
      const cands = tables.filter((t) => !used.has(t) && t.page >= l.page && t.page <= l.page + 1 && after(t));
      let t = cands.find((t) => t.title.toLowerCase().startsWith(first)) ?? null;
      if (!t) {
        t = cands.sort((a, b) => a.page - b.page || Number(a.col !== l.col) - Number(b.col !== l.col) || a.y - b.y)[0] ?? null;
        // a table in a far away column belongs to another stat block
        if (t && t.page === l.page && t.col !== l.col && t.col !== -1 && cands.some((c) => c.col === l.col)) t = cands.find((c) => c.col === l.col);
      }
      if (t) used.add(t);
      return t;
    };
    const atk = pick(attackTables);
    const loc = pick(locTables);
    // Combined "Hit Locations / Attributes" tables carry Hit Points, Move, Strike Rank...
    for (const r of loc?.rows || []) {
      if (r.quality && ATTRIBUTE_FIELDS.test(r.quality.trim())) fields[r.quality.trim()] ??= cleanText(r.value || "");
    }
    if (fields["Strike Rank"]) {
      const m = fields["Strike Rank"].match(/DEX\s*(\d+).*?SIZ\s*(\d+)/i);
      if (m) {
        fields["DEX SR"] ??= m[1];
        fields["SIZ SR"] ??= m[2];
      }
    }
    const bioLines = titleLine ? L.slice(titleLine.idx + 1, nameLine ? nameLine.idx : i) : L.slice(bioStart, i).filter((x) => x !== nameLine && !stack.includes(x));
    const title = titleLine ? tidyName(titleLine.text) : "";
    // Letter-spaced display titles sometimes come out broken ("Vasa Na Far Na N's"); fall back to the stat block name
    const broken =
      (title.match(/\b[A-Za-z]{1,2}\b/g) || []).filter((t) => !/^(of|de|la|le|an|a|i)$/i.test(t)).length >= 2 || (!/\s/.test(title) && (title.length > 14 || collapse(title).startsWith(collapse(name))));
    out.push({
      kind: "npc",
      name: title && !broken ? title : name,
      page: l.printed,
      pdfPage: l.page,
      chapter: l.chapter,
      data: {
        key: `npc-${l.page}-${i}`,
        shortName: name,
        subtitle,
        lineRange: [stack.length ? stack[0].idx : i, Math.max(lastIdx, j - 1)],
        characteristics: Object.fromEntries(Object.entries(chars).map(([a, v]) => [a, /^\d+$/.test(v) ? Number(v) : null])),
        fields,
        attacks: (atk?.rows || [])
          .filter((r) => r.weapon)
          .map((r) => ({
            name: cleanText(r.weapon || "").replace(/\*+$/, ""),
            chance: intOf(r["%"]),
            damage: cleanText(r.damage || "").replace(/\*$/, ""),
            sr: r.sr ? cleanText(r.sr) : "",
            hp: intOf(r.pts),
          })),
        hitLocations: (loc?.rows || [])
          .filter((r) => r.location && /\d/.test(r.d20 || ""))
          .map((r) => {
            const ah = String(r["armor/hp"] ?? r["ap/hp"] ?? "").split("/");
            const d = String(r.d20 || "").split(/[–-]/).map((n) => Number(n));
            return { name: cleanText(r.location || ""), from: d[0] || 0, to: d[1] || d[0] || 0, armor: intOf(ah[0]), hp: intOf(ah[1]) };
          }),
      },
      html: linesToHtml(bioLines, doc.stats),
    });
  }
  // Character sheets: one stat block per page under a page-wide banner; the banner is the name
  // (it also corrects sheets whose stat block heading was left over from another character).
  const perPage = {};
  for (const n of out) perPage[n.pdfPage] = (perPage[n.pdfPage] || 0) + 1;
  // Character sheets show Runes as a diagram of labels and big numbers instead of a "Runes:" line
  for (const n of out) {
    if (n.data.fields.Runes || perPage[n.pdfPage] !== 1) continue;
    const runes = readRuneDiagram(doc, n.pdfPage).filter((r) => r.value > 0);
    if (runes.length >= 2) {
      n.data.fields.Runes = runes.map((r) => `${r.rune} ${r.value}%`).join(", ") + ".";
      n.data.runeDiagram = runes;
    }
  }
  for (const n of out) {
    if (perPage[n.pdfPage] !== 1) continue;
    const pg = doc.pages.find((p) => p.n === n.pdfPage);
    const banner = pg?.lines.find((x) => x.size >= bodySize * 1.8 && x.y < pg.h * 0.1 && /[A-Za-z]{3}/.test(x.text));
    if (!banner || /adventurers|characters|pregen|npcs|non-player|creatures|bestiary/i.test(banner.text) || chapterKey(banner.text) === chapterKey(pg.chapter)) continue;
    const b = tidyName(banner.text);
    if (b && collapse(b) !== collapse(n.name)) {
      if (!collapse(b).includes(collapse(n.data.shortName))) n.data.subtitle = [n.data.subtitle, `(stat block heading: ${n.data.shortName})`].filter(Boolean).join(" ");
      n.name = b;
      n.data.shortName = b;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- chapters */

/** Stat block as HTML for chapter journals; {{NPC:key}} is replaced with a link to the imported actor. */
export function statBlockHtml(npc) {
  const d = npc.data;
  const e = escapeHtml;
  const chars = Object.entries(d.characteristics || {});
  const parts = [`<div class="rqgi-statblock">`, `<h3>${e(d.shortName || npc.name)}</h3>`];
  if (d.subtitle) parts.push(`<p><em>${e(d.subtitle)}</em></p>`);
  parts.push(`<p class="rqgi-actor-link">{{NPC:${d.key}}}</p>`);
  if (chars.length)
    parts.push(`<table class="rqgi-table"><tr>${chars.map(([k]) => `<th>${k}</th>`).join("")}</tr><tr>${chars.map(([, v]) => `<td>${v ?? "—"}</td>`).join("")}</tr></table>`);
  if (d.attacks?.length)
    parts.push(
      `<table class="rqgi-table"><tr><th>Weapon</th><th>%</th><th>Damage</th><th>SR</th><th>Pts</th></tr>${d.attacks
        .map((a) => `<tr><td>${e(a.name)}</td><td>${a.chance}</td><td>${e(a.damage)}</td><td>${e(a.sr || "")}</td><td>${a.hp || "—"}</td></tr>`)
        .join("")}</table>`,
    );
  if (d.hitLocations?.length)
    parts.push(
      `<table class="rqgi-table"><tr><th>Location</th><th>D20</th><th>AP/HP</th></tr>${d.hitLocations
        .map((h) => `<tr><td>${e(h.name)}</td><td>${h.from === h.to ? h.from : `${h.from}–${h.to}`}</td><td>${h.armor}/${h.hp}</td></tr>`)
        .join("")}</table>`,
    );
  for (const [k, v] of Object.entries(d.fields || {})) parts.push(`<p><strong>${e(k)}:</strong> ${e(v)}</p>`);
  parts.push(`</div>`);
  return parts.join("\n");
}

/** Whole chapters as journals: one entry per chapter, one page per main heading, stat blocks formatted. */
export function parseChapters(doc, { npcs = [] } = {}) {
  const { bodySize } = doc.stats;
  const statBlocks = new Map();
  for (const n of npcs) {
    const [a, b] = n.data.lineRange || [];
    if (a != null) statBlocks.set(a, { end: b, html: statBlockHtml(n) });
  }
  const isHead = (l, f) => l.size >= bodySize * f && l.size < bodySize * 3 && /[A-Za-z]{2}/.test(l.text) && l.text.length < 90;
  // group lines by chapter
  const groups = [];
  for (const l of doc.lines) {
    const key = chapterKey(l.chapter) || "frontmatter";
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, names: [], lines: [] };
      groups.push(g);
    }
    if (l.chapter && !g.names.includes(l.chapter)) g.names.push(l.chapter);
    g.lines.push(l);
  }
  return groups
    .map((g) => {
      // page breaks on the biggest heading level used in the chapter body
      const big = g.lines.some((l) => isHead(l, 1.8));
      const level = big ? 1.8 : 1.25;
      const sections = [];
      let cur = null;
      for (const l of g.lines) {
        if (isHead(l, level) && !(cur && cur.lines.length === 0 && cur.headLine && l.y - cur.headLine.y < l.size * 1.8 && l.page === cur.headLine.page)) {
          cur = { name: tidyName(l.text), page: l.printed, headLine: l, lines: [] };
          sections.push(cur);
          continue;
        }
        if (cur && cur.lines.length === 0 && cur.headLine && isHead(l, level)) {
          cur.name = `${cur.headLine.text.replace(/\s+$/, "")} ${l.text}`.replace(/\s+/g, " ");
          cur.name = tidyName(cur.name.replace(/:(?=\s)/, ":")); // two-line heading ("Opening Scene: / At the Market")
          cur.headLine = l;
          continue;
        }
        if (!cur) {
          cur = { name: "Introduction", page: l.printed, lines: [] };
          sections.push(cur);
        }
        cur.lines.push(l);
      }
      const name = g.names.find((n) => /\s/.test(n)) ?? g.names[0] ?? "Front Matter";
      const first = g.lines[0];
      return {
        kind: "chapter",
        name: prettyChapter(name),
        page: first?.printed,
        pdfPage: first?.page,
        data: { sections: sections.map((s) => ({ name: s.name, page: s.page, html: renderRich(s.lines, doc.stats, { statBlocks }) })).filter((s) => s.html.trim()) },
        html: "",
      };
    })
    .filter((c) => c.data.sections.length && !/^(contents|tableofcontents|index)$/.test(chapterKey(c.name)));
}

function prettyChapter(k) {
  return String(k)
    .replace(/&/g, " & ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------------------------------------------- all */

function dedupe(list) {
  const seen = new Map();
  for (const e of list) {
    const k = e.kind + ":" + slugify(e.name);
    if (!seen.has(k)) seen.set(k, e);
    else if ((e.html || "").length > (seen.get(k).html || "").length && !seen.get(k).html) seen.set(k, e);
  }
  return [...seen.values()];
}

export function parseBook(doc, { kinds = null, includeChapters = false } = {}) {
  const want = (k) => !kinds || kinds.includes(k);
  const result = [];
  const spells = parseSpells(doc).filter((s) => want(s.kind));
  const weapons = want("weapon") ? parseWeapons(doc) : [];
  const armor = want("armor") ? parseArmor(doc) : [];
  attachDescriptions(doc, [...weapons, ...armor]);
  const known = new Set([...weapons, ...armor].map((e) => wordSet(e.name)));
  const gear = want("gear") ? parseGear(doc, known) : [];
  let skills = want("skill") ? parseSkills(doc) : [];
  if (want("skill")) {
    const have = new Set(skills.map((s) => slugify(s.name)));
    skills = skills.concat(weaponSkills(weapons).filter((s) => !have.has(slugify(s.name))));
  }
  const cults = want("cult") ? parseCults(doc) : [];
  const npcs = want("npc") ? parseNpcs(doc) : [];
  result.push(...spells, ...weapons, ...armor, ...gear, ...skills, ...cults, ...npcs);
  if (includeChapters) result.push(...parseChapters(doc, { npcs: want("npc") ? npcs : parseNpcs(doc) }));
  return result;
}
