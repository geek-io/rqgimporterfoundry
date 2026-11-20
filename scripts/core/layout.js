/**
 * Layout engine: turns a positioned page model into reading-ordered lines.
 *
 * Page model (produced by pdf-reader.js in Foundry, or tools/pdf_to_model.py offline):
 *   { title, pages: [{ n, w, h, items: [[text, x, yTop, width, size, bold, italic, font], ...] }] }
 *
 * Pure ES module: no Foundry globals, so it can be tested in Node.
 */

export function familyOf(font) {
  if (!font) return "";
  const f = String(font).split("+").pop();
  return f.split(/[-,]/)[0];
}

function wordFrom(it) {
  const [s, x, y, w, size, bold, italic, font, sp] = it;
  return { s, x, y, w, x1: x + w, size: size || 10, bold: !!bold, italic: !!italic, font: font || "", fam: familyOf(font), sp };
}

/** Normalise typographic oddities that PDF text extraction produces. */
export function cleanText(t) {
  return String(t)
    .replace(/­/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/\s+/g, " ")
    .trim();
}

function joinWords(words) {
  // Letter-spaced runs (display headings, running headers) come out as one word per letter:
  // treat only gaps clearly wider than the typical gap as word breaks.
  const gaps = [];
  for (let i = 1; i < words.length; i++) gaps.push(words[i].x - words[i - 1].x1);
  const singles = words.filter((w) => w.s.length === 1 && /[A-Za-z]/.test(w.s)).length;
  let spaced = null;
  if (words.length >= 4 && singles / words.length > 0.4) {
    const sorted = [...gaps].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    spaced = Math.max(med * 1.7, words[0].size * 0.22);
  } else {
    const sizes = words.map((w) => w.size).sort((a, b) => a - b);
    const medSize = sizes[Math.floor(sizes.length / 2)] ?? 10;
    if (medSize >= 17) spaced = medSize * 0.3;
  }
  let out = "";
  let prev = null;
  for (const w of words) {
    if (prev) {
      const gap = w.x - prev.x1;
      const limit = spaced ?? Math.max(0.8, prev.size * 0.12);
      if (w.sp === 1) out += " ";
      else if (w.sp === 0 && w.size >= 17) {
        /* pdf.js display run: only explicit spaces count */
      } else if (gap > limit) out += " ";
    }
    out += w.s;
    prev = w;
  }
  return cleanText(out);
}

function makeLine(words, page, col) {
  words.sort((a, b) => a.x - b.x);
  const sizes = {};
  const fams = {};
  for (const w of words) {
    sizes[w.size] = (sizes[w.size] || 0) + w.s.length;
    fams[w.fam] = (fams[w.fam] || 0) + w.s.length;
  }
  const size = Number(Object.entries(sizes).sort((a, b) => b[1] - a[1])[0][0]);
  const fam = Object.entries(fams).sort((a, b) => b[1] - a[1])[0][0];
  const text = joinWords(words);
  // Bold lead-in ("Price:" / "Bladesharp:" style run headers)
  let boldLead = null;
  if (words[0].bold) {
    const lead = [];
    for (const w of words) {
      if (!w.bold) break;
      lead.push(w);
    }
    if (lead.length < words.length) boldLead = joinWords(lead);
  }
  return {
    page: page.n,
    col,
    y: Math.min(...(words.filter((w) => w.size === size || /[A-Za-z0-9]/.test(w.s)).map((w) => w.y).concat(words.length ? [] : [0]))),
    x0: words[0].x,
    x1: Math.max(...words.map((w) => w.x1)),
    size,
    fam,
    font: words[0].font,
    bold: words.every((w) => w.bold || !/[A-Za-z0-9]/.test(w.s)),
    italic: words.every((w) => w.italic || !/[A-Za-z0-9]/.test(w.s)),
    boldLead,
    words,
    text,
  };
}

/** Group words into raw (full width) lines by their top coordinate. */
function rawLines(words) {
  // Group on the baseline so mixed sizes on one line (small caps, drop caps) stay together
  const base = (w) => w.y + w.size * 0.78;
  const sorted = [...words].sort((a, b) => base(a) - base(b) || a.x - b.x);
  const lines = [];
  for (const w of sorted) {
    const tol = Math.max(2.2, w.size * 0.38);
    let line = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 12; i--) {
      const d = Math.abs(lines[i].b - base(w));
      if (d <= tol && (!line || d < Math.abs(line.b - base(w)))) line = lines[i];
    }
    if (!line) {
      line = { y: w.y, b: base(w), words: [] };
      lines.push(line);
    }
    line.words.push(w);
    line.y = Math.min(line.y, w.y);
  }
  for (const l of lines) l.words.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.y - b.y);
}

/** Find the vertical gutter of a two column page, or null for single column pages. */
function findGutter(page, words) {
  const w = page.w;
  const lo = Math.floor(w * 0.36);
  const hi = Math.ceil(w * 0.64);
  const cov = new Array(hi - lo + 1).fill(0);
  let bodyWords = 0;
  for (const wd of words) {
    if (wd.y < page.h * 0.07 || wd.y > page.h * 0.93) continue;
    bodyWords++;
    const a = Math.max(lo, Math.floor(wd.x));
    const b = Math.min(hi, Math.ceil(wd.x1));
    for (let x = a; x <= b; x++) cov[x - lo]++;
  }
  if (bodyWords < 20) return null;
  // Widest run of near-zero coverage
  const limit = Math.max(1, bodyWords * 0.01);
  let best = null;
  let start = null;
  for (let i = 0; i <= cov.length; i++) {
    const empty = i < cov.length && cov[i] <= limit;
    if (empty && start === null) start = i;
    if (!empty && start !== null) {
      const len = i - start;
      if (!best || len > best.len) best = { len, mid: lo + start + len / 2 };
      start = null;
    }
  }
  if (!best || best.len < 6) return null;
  // Both sides need real content
  let left = 0;
  let right = 0;
  for (const wd of words) {
    if (wd.x1 < best.mid) left++;
    else if (wd.x > best.mid) right++;
  }
  if (left < bodyWords * 0.15 || right < bodyWords * 0.15) return null;
  return best.mid;
}

/**
 * Build the document: reading ordered lines per page, chapter tracking, printed page numbers.
 * @returns {{pages: object[], lines: object[], stats: object}}
 */
export function buildDocument(model, { firstPage = 1, lastPage = Infinity } = {}) {
  const famCount = {};
  const sizeCount = {};
  const pages = [];
  for (const p of model.pages) {
    if (p.n < firstPage || p.n > lastPage) continue;
    const words = (p.items || []).map(wordFrom).filter((w) => w.s && w.s.trim());
    // Body text = the font of running prose: count only long runs of words in one family and size,
    // so table-heavy pages (character sheets) don't make the table font look like the body font.
    for (const r of rawLines(words)) {
      const groups = {};
      for (const w of r.words) {
        const k = `${w.fam}|${Math.round(w.size * 2) / 2}`;
        (groups[k] ??= []).push(w);
      }
      for (const [k, ws] of Object.entries(groups)) {
        if (ws.length < 7 || ws.filter((w) => /^[a-z]/.test(w.s)).length < 4) continue;
        const [fam, size] = k.split("|");
        const n = ws.reduce((a, w) => a + w.s.length, 0);
        famCount[fam] = (famCount[fam] || 0) + n;
        sizeCount[size] = (sizeCount[size] || 0) + n;
      }
    }
    pages.push({ src: p, words });
  }
  if (!Object.keys(famCount).length) {
    for (const { words } of pages) for (const w of words) famCount[w.fam] = (famCount[w.fam] || 0) + w.s.length;
    for (const { words } of pages) for (const w of words) sizeCount[Math.round(w.size * 2) / 2] = (sizeCount[Math.round(w.size * 2) / 2] || 0) + w.s.length;
  }
  const bodyFamily = Object.entries(famCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const bodySize = Number(Object.entries(sizeCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 10);

  // Book level gutter: used for pages where detection is inconclusive (sparse columns, sidebars)
  const detected = pages.map(({ src, words }) => findGutter(src, words)).filter((g) => g != null).sort((a, b) => a - b);
  const bookGutter = detected.length >= 3 ? detected[Math.floor(detected.length / 2)] : null;
  const outPages = [];
  const allLines = [];
  let chapter = "";
  let lastHeaderTexts = [];
  const bodyHint = bodySize;
  for (const { src: p, words } of pages) {
    const raws = rawLines(words);
    let gutter = findGutter(p, words);
    if (gutter == null && bookGutter != null && Math.abs(p.w - pages[0].src.w) < 2) {
      const crossing = words.filter((w) => w.x < bookGutter - 3 && w.x1 > bookGutter + 3 && w.size < bodySize * 1.6).length;
      const left = words.filter((w) => w.x1 <= bookGutter).length;
      const right = words.filter((w) => w.x >= bookGutter).length;
      if (crossing <= Math.max(2, words.length * 0.02) && left > 10 && right > 10) gutter = bookGutter;
    }
    const header = [];
    const footer = [];
    const body = [];
    for (const r of raws) {
      const isTop = r.y < p.h * 0.052;
      const isBottom = r.y > p.h * 0.935;
      if ((isTop || isBottom) && r.words.reduce((n, w) => n + w.s.length + 1, 0) <= 60) {
        const sz = Math.max(...r.words.map((w) => w.size));
        if (isBottom || sz <= bodyHint * 1.2) {
          (isTop ? header : footer).push(joinWords(r.words));
          continue;
        }
      }
      body.push(r);
    }
    // Printed page number
    let printed = null;
    for (const f of footer) {
      const m = f.match(/^(\d{1,4})$/) || f.match(/(?:^|\s)(\d{1,4})$/);
      if (m) printed = Number(m[1]);
    }
    // Chapter = running header text that is not the book title (title repeats on every left page)
    const headerText = header.map((h) => h.replace(/\s+/g, "")).filter((h) => h && !/^\d+$/.test(h));
    lastHeaderTexts.push(...headerText);
    // Chapter opening pages carry a giant title instead of a running header (may wrap over two lines)
    const bigLines = raws.filter((r) => r.y < p.h * 0.45 && r.words.some((w) => w.size >= bodySize * 3));
    if (bigLines.length) {
      const t = bigLines
        .slice(0, 3)
        .map((r) => joinWords(r.words.filter((w) => w.size >= bodySize * 3)))
        .join(" ")
        .replace(/[^A-Za-z&' -]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (t.replace(/\s/g, "").length >= 3) chapter = t;
    }
    for (const h of headerText) {
      const count = lastHeaderTexts.filter((x) => x === h).length;
      // book title shows on (almost) every left page; chapters only on a run of right pages
      if (!isLikelyBookTitle(h, model.title)) chapter = h;
      void count;
    }

    // Split into columns and reading order
    const segs = [];
    for (const r of body) {
      if (gutter == null) {
        segs.push({ col: 0, y: r.b ?? r.y, words: r.words });
        continue;
      }
      const bigBothSides =
        r.words.some((w) => w.size >= bodySize * 1.7 && /[A-Za-z]/.test(w.s) && w.x1 <= gutter + 3) &&
        r.words.some((w) => w.size >= bodySize * 1.7 && /[A-Za-z]/.test(w.s) && w.x > gutter - 3);
      const crosses = bigBothSides || r.words.some((w) => w.x < gutter - 3 && w.x1 > gutter + 3);
      if (crosses) {
        segs.push({ col: -1, y: r.b ?? r.y, words: r.words });
        continue;
      }
      const left = r.words.filter((w) => w.x1 <= gutter + 3);
      const right = r.words.filter((w) => w.x1 > gutter + 3);
      if (left.length) segs.push({ col: 0, y: r.b ?? r.y, words: left });
      if (right.length) segs.push({ col: 1, y: r.b ?? r.y, words: right });
    }
    // Regions separated by spanning lines
    const spans = segs.filter((s) => s.col === -1).sort((a, b) => a.y - b.y);
    const ordered = [];
    let regionStart = -Infinity;
    const flushRegion = (yEnd) => {
      for (const col of [0, 1]) {
        segs
          .filter((s) => s.col === col && s.y >= regionStart && s.y < yEnd)
          .sort((a, b) => a.y - b.y)
          .forEach((s) => ordered.push(s));
      }
    };
    for (const sp of spans) {
      flushRegion(sp.y);
      ordered.push(sp);
      regionStart = sp.y + 0.01;
    }
    flushRegion(Infinity);

    const pageObj = { n: p.n, w: p.w, h: p.h, printed, chapter, gutter, lines: [], raw: [] };
    for (const s of ordered) {
      const line = makeLine(s.words, p, s.col);
      line.chapter = chapter;
      line.printed = printed;
      pageObj.lines.push(line);
    }
    for (const r of body) {
      const line = makeLine([...r.words], p, -2);
      line.chapter = chapter;
      pageObj.raw.push(line);
    }
    // left margin per column (for paragraph indent detection)
    for (const col of [-1, 0, 1]) {
      const xs = pageObj.lines.filter((l) => l.col === col && l.fam === bodyFamily).map((l) => l.x0);
      if (xs.length) {
        xs.sort((a, b) => a - b);
        pageObj[`margin${col}`] = xs[Math.floor(xs.length * 0.2)];
      }
    }
    for (const l of pageObj.lines) l.margin = pageObj[`margin${l.col}`] ?? l.x0;
    outPages.push(pageObj);
    allLines.push(...pageObj.lines);
  }
  // Fill missing printed page numbers from the most common pdf->printed offset
  const offs = {};
  for (const pg of outPages) if (pg.printed != null) offs[pg.printed - pg.n] = (offs[pg.printed - pg.n] || 0) + 1;
  const off = Number(Object.entries(offs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
  for (const pg of outPages) {
    if (pg.printed == null || pg.printed - pg.n !== off) pg.printed = pg.n + off;
    for (const l of pg.lines) l.printed = pg.printed;
    for (const l of pg.raw) l.printed = pg.printed;
  }
  allLines.forEach((l, i) => (l.idx = i));
  return { title: model.title, pages: outPages, lines: allLines, stats: { bodyFamily, bodySize } };
}

function isLikelyBookTitle(h, title) {
  const s = h.toLowerCase();
  if (/^runequest$/.test(s)) return true;
  const t = String(title || "").toLowerCase().replace(/[^a-z]/g, "");
  return t && s.replace(/[^a-z]/g, "") === t;
}

/** Normalise a chapter header ("Spiri t Magic") to a compact lowercase key ("spiritmagic"). */
export function chapterKey(ch) {
  return String(ch || "").toLowerCase().replace(/[^a-z]/g, "");
}

export function isHeading(line, stats, factor = 1.25) {
  return line.size >= stats.bodySize * factor;
}

/**
 * Turn a run of lines into HTML paragraphs, joining hyphenated line breaks.
 * Lines are expected in reading order. Lines in non-body font families are skipped
 * unless keepFamilies includes them.
 */
export function linesToHtml(lines, stats, { keepFamilies = [], subheadFactor = 1.08 } = {}) {
  const paras = [];
  let cur = null;
  let prev = null;
  const allowed = new Set([stats.bodyFamily, ...keepFamilies]);
  for (const l of lines) {
    const isSub = l.size >= stats.bodySize * subheadFactor && l.size < stats.bodySize * 2.2 && (l.bold || l.size >= stats.bodySize * 1.25) && l.text.length < 90;
    if (!allowed.has(l.fam) && !isSub) continue;
    if (isSub && !/[A-Za-z]{2}/.test(l.text)) continue; // bullet glyphs and rune symbols set in display fonts
    if (isSub) {
      paras.push({ tag: "h3", text: l.text });
      cur = null;
      prev = l;
      continue;
    }
    const gap = prev && prev.page === l.page && prev.col === l.col ? l.y - prev.y : 0;
    const newPara =
      !cur ||
      gap > l.size * 1.9 ||
      (l.x0 > (l.margin ?? l.x0) + 5 && l.x0 - (l.margin ?? 0) < 40 && !/^([•●▪]|\.\s?(?=[A-Z"'(]))/.test(cur.text) && !(prev && prev.col === l.col && prev.page === l.page && l.x0 - prev.x0 < 3)) ||
      (l.boldLead && (/[.:!?)]$/.test(cur.text) || (/:$/.test(l.boldLead) && l.boldLead.length <= 40))) ||
      /^([•●▪]|\.\s?(?=[A-Z"'(]))/.test(l.text) ||
      (prev && !allowed.has(prev.fam) && /^[.•]$/.test(prev.text));
    if (newPara) {
      cur = { tag: "p", text: "", boldLead: l.boldLead || null };
      paras.push(cur);
      cur.text = l.text;
    } else if (/[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(l.text) && !/^(or|and|to|nor)\b/.test(l.text)) {
      cur.text = cur.text.slice(0, -1) + l.text;
    } else {
      cur.text += " " + l.text;
    }
    prev = l;
  }
  return paras
    .filter((p) => p.text && p.text.trim())
    .map((p) => {
      if (p.tag === "p") p.text = p.text.replace(/^[.•●▪]\s*/, "• ");
      const esc = escapeHtml(p.text);
      if (p.tag === "h3") return `<h3>${esc}</h3>`;
      if (p.boldLead && p.text.startsWith(p.boldLead)) {
        const lead = escapeHtml(p.boldLead);
        return `<p><strong>${lead}</strong>${esc.slice(lead.length)}</p>`;
      }
      return `<p>${esc}</p>`;
    })
    .join("\n");
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Title-case names printed in ALL CAPS; leaves mixed case untouched. */
export function tidyName(s) {
  s = cleanText(s).replace(/\s*[:.]$/, "");
  // small-caps fonts come out as "krarsHTkiD" / "Varina THe seaMsTress": title-case them
  if (/[a-z][A-Z]|[A-Z]{2}[a-z]/.test(s) || /^[a-z]/.test(s)) {
    s = s
      .split(" ")
      .map((w, n) => (n > 0 && /^(of|the|and|in|on|a|an)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join(" ");
  }
  if (s === s.toUpperCase() && /[A-Z]{3}/.test(s)) {
    s = s.toLowerCase().replace(/(^|[\s(\-\/])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }
  return s;
}

/* ------------------------------------------------------------ rich text */

/** Split a line into cells at wide gaps (table rows). */
function cellsOf(line) {
  const cells = [];
  let cur = [];
  let prev = null;
  for (const w of line.words) {
    if (prev && w.x - prev.x1 > Math.max(6, w.size * 1.1)) {
      cells.push(cur);
      cur = [];
    }
    cur.push(w);
    prev = w;
  }
  if (cur.length) cells.push(cur);
  return cells.map((c) => joinWords(c));
}

/** Sidebar / boxed text (other font families): title, tables and paragraphs. */
function renderAside(lines, stats) {
  const out = [];
  let table = null;
  let para = null;
  let prev = null;
  const flushPara = () => {
    if (para) out.push(para.small ? `<p class="rqgi-note"><small>${escapeHtml(para.text)}</small></p>` : `<p>${escapeHtml(para.text.replace(/^([.•●▪])\s*/, "• "))}</p>`);
    para = null;
  };
  const flushTable = () => {
    if (!table) return;
    const width = Math.max(...table.rows.map((r) => r.length));
    out.push(
      `<table class="rqgi-table">${table.rows
        .map((r, n) => {
          const tag = n === 0 && table.header ? "th" : "td";
          return `<tr>${[...r, ...Array(Math.max(0, width - r.length)).fill("")].map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join("")}</tr>`;
        })
        .join("")}</table>`,
    );
    table = null;
  };
  for (const l of lines) {
    const rel = l.size / stats.bodySize;
    const cells = cellsOf(l);
    if (l.bold && !l.boldLead && rel >= 1.05 && /[A-Za-z]{2}/.test(l.text) && l.text.length < 80 && cells.length < 3) {
      flushPara();
      flushTable();
      out.push(`<h4>${escapeHtml(l.text)}</h4>`);
      prev = l;
      continue;
    }
    if (cells.length >= 3 || (cells.length === 2 && (table || l.bold))) {
      flushPara();
      table ??= { rows: [], header: l.bold };
      table.rows.push(cells);
      prev = l;
      continue;
    }
    flushTable();
    const small = rel < 0.8;
    const gap = prev && prev.page === l.page && prev.col === l.col ? l.y - prev.y : 0;
    if (!para || gap > l.size * 1.9 || /^([•●▪]|\.\s?(?=[A-Z"'(]))/.test(l.text) || para.small !== small) {
      flushPara();
      para = { text: l.text, small };
    } else if (/[A-Za-z]-$/.test(para.text) && /^[a-z]/.test(l.text) && !/^(or|and|to|nor)\b/.test(l.text)) para.text = para.text.slice(0, -1) + l.text;
    else para.text += " " + l.text;
    prev = l;
  }
  flushPara();
  flushTable();
  const html = out.join("\n");
  return html.trim() ? `<blockquote class="rqgi-sidebar">${html}</blockquote>` : "";
}

/**
 * Render a run of lines (one journal page) with structure: headings, paragraphs, bullets,
 * sidebars (other font families) as boxed quotes placed after the paragraph they interrupt,
 * tables, and stat blocks replaced by pre-rendered HTML.
 * @param {{statBlocks?: Map<number, {end: number, html: string}>}} opts keyed by first line idx
 */
export function renderRich(lines, stats, { statBlocks = new Map() } = {}) {
  const out = [];
  const queued = [];
  let asideLines = [];
  let para = null;
  let prev = null;
  let skipUntil = -1;

  const flushQueued = () => {
    while (queued.length) out.push(queued.shift());
  };
  const flushPara = () => {
    if (para) {
      const t = para.text.replace(/^([.•●▪])\s*/, "• ");
      let esc = escapeHtml(t);
      if (para.lead && t.startsWith(para.lead)) {
        const lead = escapeHtml(para.lead);
        esc = `<strong>${lead}</strong>${esc.slice(lead.length)}`;
      }
      out.push(`<p>${esc}</p>`);
      para = null;
    }
    flushQueued();
  };
  const closeAside = () => {
    if (!asideLines.length) return;
    const html = renderAside(asideLines, stats);
    asideLines = [];
    if (!html) return;
    // keep a sentence that runs around the box together: place the box after it
    if (para && !/[.!?:"”)]$/.test(para.text)) queued.push(html);
    else {
      flushPara();
      out.push(html);
    }
  };

  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    if (l.idx <= skipUntil) continue;
    const sb = statBlocks.get(l.idx);
    if (sb) {
      closeAside();
      flushPara();
      out.push(sb.html);
      skipUntil = sb.end;
      prev = null;
      continue;
    }
    if (!/[A-Za-z0-9]/.test(l.text)) continue; // decorative glyphs
    const isBody = l.fam === stats.bodyFamily;
    const rel = l.size / stats.bodySize;
    const isHeading = rel >= 1.08 && /[A-Za-z]{2}/.test(l.text) && (l.bold || rel >= 1.25) && l.text.length < 90 && !l.boldLead;
    if (isHeading && !isBody) {
      // a title followed by text in a non-body font is the title of a sidebar
      const next = lines.slice(n + 1).find((x) => /[A-Za-z]{2}/.test(x.text) && x.size < l.size);
      if (next && next.fam !== stats.bodyFamily && next.fam !== l.fam) {
        if (asideLines.length && asideLines[asideLines.length - 1].page !== l.page) closeAside();
        asideLines.push(l);
        continue;
      }
    }
    if (isHeading) {
      closeAside();
      flushPara();
      const tag = rel >= 1.25 ? "h2" : "h3";
      const last = out[out.length - 1];
      if (prev && prev.size === l.size && prev.col === l.col && l.y - prev.y < l.size * 1.6 && last?.startsWith(`<${tag}>`)) {
        out[out.length - 1] = last.replace(`</${tag}>`, ` ${escapeHtml(l.text)}</${tag}>`);
      } else out.push(`<${tag}>${escapeHtml(l.text)}</${tag}>`);
      prev = l;
      continue;
    }
    if (!isBody) {
      asideLines.push(l);
      continue;
    }
    closeAside();
    const gap = prev && prev.page === l.page && prev.col === l.col ? l.y - prev.y : 0;
    const newPara =
      !para ||
      gap > l.size * 1.9 ||
      /^([•●▪]|\.\s?(?=[A-Z"'(]))/.test(l.text) ||
      (l.x0 > (l.margin ?? l.x0) + 5 && l.x0 - (l.margin ?? 0) < 40 && !/^([•●▪]|\.\s?(?=[A-Z"'(]))/.test(para.text) && !(prev && prev.col === l.col && prev.page === l.page && l.x0 - prev.x0 < 3)) ||
      (l.boldLead && (/[.:!?)]$/.test(para.text) || (/:$/.test(l.boldLead) && l.boldLead.length <= 40)));
    if (newPara) {
      flushPara();
      para = { text: l.text, lead: l.boldLead };
    } else if (/[A-Za-z]-$/.test(para.text) && /^[a-z]/.test(l.text) && !/^(or|and|to|nor)\b/.test(l.text)) {
      para.text = para.text.slice(0, -1) + l.text;
    } else {
      para.text += " " + l.text;
    }
    prev = l;
  }
  closeAside();
  flushPara();
  return out.join("\n");
}
