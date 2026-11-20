/**
 * Reads a PDF in the browser with pdf.js and produces the positioned page model that
 * layout.buildDocument() understands. Also accepts a model JSON made by tools/pdf_to_model.py.
 */
import { MODULE_ID } from "../core/builders.js";

const MODULE_LIB = `modules/${MODULE_ID}/lib/pdfjs/`;
const ESM_CANDIDATES = [
  [`${MODULE_LIB}pdf.min.mjs`, `${MODULE_LIB}pdf.worker.min.mjs`],
  ["scripts/pdfjs/build/pdf.min.mjs", "scripts/pdfjs/build/pdf.worker.min.mjs"],
  ["scripts/pdfjs/build/pdf.mjs", "scripts/pdfjs/build/pdf.worker.mjs"],
];
const UMD_CANDIDATES = [
  [`${MODULE_LIB}pdf.min.js`, `${MODULE_LIB}pdf.worker.min.js`],
  ["scripts/pdfjs/build/pdf.min.js", "scripts/pdfjs/build/pdf.worker.min.js"],
  ["scripts/pdfjs/build/pdf.js", "scripts/pdfjs/build/pdf.worker.js"],
];

let pdfjsPromise = null;

function route(p) {
  try {
    return foundry.utils.getRoute(p);
  } catch {
    return `/${p}`;
  }
}

async function exists(url) {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/** Locate pdf.js: this module's lib/ folder first, then the copy Foundry ships for PDF journal pages. */
export function loadPdfJs() {
  pdfjsPromise ??= (async () => {
    if (globalThis.pdfjsLib?.getDocument) return globalThis.pdfjsLib;
    for (const [lib, worker] of ESM_CANDIDATES) {
      const url = route(lib);
      if (!(await exists(url))) continue;
      try {
        const m = await import(url);
        const pdfjs = m.getDocument ? m : m.default;
        if (pdfjs?.getDocument) {
          pdfjs.GlobalWorkerOptions.workerSrc = route(worker);
          return pdfjs;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | could not import ${url}`, err);
      }
    }
    for (const [lib, worker] of UMD_CANDIDATES) {
      const url = route(lib);
      if (!(await exists(url))) continue;
      try {
        await loadScript(url);
        if (globalThis.pdfjsLib?.getDocument) {
          globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = route(worker);
          return globalThis.pdfjsLib;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | could not load ${url}`, err);
      }
    }
    pdfjsPromise = null;
    throw new Error(
      "pdf.js could not be found. Place pdf.min.mjs and pdf.worker.min.mjs in modules/rqg-importer/lib/pdfjs/, or upload a model JSON made with tools/pdf_to_model.py.",
    );
  })();
  return pdfjsPromise;
}

// Style part of a font name ("GaramondPremrPro-BdIt" -> "BdIt"); abbreviations are common in Chaosium PDFs
const styleOf = (name) => (String(name).includes("-") ? String(name).split("-").pop() : String(name));
const BOLD_RE = { test: (n) => /bold|black|heavy|semibold|demi|^bd|bd(it)?$|^sb|smbd|^hv/i.test(styleOf(n)) || /bold|black/i.test(n) };
const ITALIC_RE = { test: (n) => /italic|oblique|it$|^it/i.test(styleOf(n)) || /italic|oblique/i.test(n) };

/**
 * @param {ArrayBuffer} data PDF bytes
 * @param {{from?: number, to?: number, detectFonts?: boolean, onProgress?: Function, signal?: {cancelled: boolean}}} opts
 */
export async function readPdf(data, { from = 1, to = Infinity, detectFonts = true, onProgress, signal, pdfjs: lib } = {}) {
  const pdfjs = lib ?? (await loadPdfJs());
  const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, fontExtraProperties: true });
  const pdf = await task.promise;
  let title = "";
  try {
    const meta = await pdf.getMetadata();
    title = meta?.info?.Title || "";
  } catch {
    /* no metadata */
  }
  const last = Math.min(to, pdf.numPages);
  const pages = [];
  for (let n = Math.max(1, from); n <= last; n++) {
    if (signal?.cancelled) throw new Error("Cancelled");
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    let glyphs = null;
    if (detectFonts) {
      try {
        const ol = await page.getOperatorList();
        glyphs = glyphStream(ol, pdfjs.OPS);
      } catch {
        /* fonts stay unknown */
      }
    }
    const tc = await page.getTextContent();
    const fontNames = {};
    const fontOf = (id) => {
      if (id in fontNames) return fontNames[id];
      let name = "";
      try {
        const fo = page.commonObjs.get(id);
        name = fo?.name || fo?.loadedName || tc.styles?.[id]?.fontFamily || "";
        if (fo?.bold && !BOLD_RE.test(name)) name += "-Bold";
        if (fo?.italic && !ITALIC_RE.test(name)) name += "-Italic";
      } catch {
        name = tc.styles?.[id]?.fontFamily || "";
      }
      fontNames[id] = name;
      return name;
    };
    const items = [];
    let pendingSpace = 0;
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) {
        if (it.str) pendingSpace = 1; // explicit space item: a real word break
        continue;
      }
      const [a, b, c, d, e, f] = it.transform;
      const size = Math.round((Math.hypot(c, d) || Math.hypot(a, b)) * 2) / 2;
      const [vx, vy] = vp.convertToViewportPoint(e, f);
      const top = vy - size * 0.78;
      const fname = fontOf(it.fontName).split("+").pop();
      const bold = BOLD_RE.test(fname) ? 1 : 0;
      const italic = ITALIC_RE.test(fname) ? 1 : 0;
      // pdf.js puts a space wherever letter-spacing or kerning leaves a gap ("Get t ing the");
      // the glyph stream knows which spaces are real space characters.
      const fixed = glyphs ? respace(it.str, glyphs) : null;
      // split runs into words, distributing the run width over its characters
      const str = fixed ?? it.str;
      const cw = (it.width || size * 0.5 * str.length) / str.length;
      let i = 0;
      while (i < str.length) {
        while (i < str.length && str[i] === " ") i++;
        let j = i;
        while (j < str.length && str[j] !== " ") j++;
        if (j > i) {
          // 9th field: 1 = preceded by a real space, 0 = not (display fonts put letter-spacing spaces inside runs)
          const sp = i > 0 ? (fixed != null || size < 17 ? 1 : 0) : pendingSpace;
          items.push([str.slice(i, j), round1(vx + i * cw), round1(top), round1((j - i) * cw), size, bold, italic, fname, sp]);
          pendingSpace = 0;
        }
        i = j;
      }
    }
    pages.push({ n, w: round1(vp.width), h: round1(vp.height), items });
    page.cleanup();
    onProgress?.(n - from + 1, last - from + 1);
  }
  try {
    await (pdf.destroy ? pdf.destroy() : task.destroy());
  } catch {
    /* ignore */
  }
  return { title, numPages: pages.length, pages };
}

/** Non-space characters of the page's text operators, with a flag for "a real space came before". */
function glyphStream(ol, OPS) {
  const showOps = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText].filter((x) => x != null));
  const chars = [];
  const spaceBefore = [];
  let pending = false;
  for (let i = 0; i < ol.fnArray.length; i++) {
    if (!showOps.has(ol.fnArray[i])) continue;
    const args = ol.argsArray[i];
    const arr = args?.find?.((a) => Array.isArray(a)) ?? args?.[0];
    if (!Array.isArray(arr)) continue;
    for (const g of arr) {
      if (!g || typeof g === "number") continue;
      const u = String(g.unicode ?? "").normalize("NFKC");
      if (g.isSpace || /^\s+$/.test(u)) {
        pending = true;
        continue;
      }
      for (const ch of u.replace(/\s+/g, "")) {
        chars.push(ch);
        spaceBefore.push(pending);
        pending = false;
      }
    }
  }
  return { text: chars.join(""), spaceBefore, cursor: 0 };
}

/** Rebuild an item's spaces from the glyph stream; null when the item can't be matched. */
function respace(str, gs) {
  if (!/\s/.test(str)) return null;
  const letters = str.normalize("NFKC").replace(/\s+/g, "");
  if (letters.length < 2) return null;
  let at = gs.text.indexOf(letters, gs.cursor);
  if (at < 0) at = gs.text.indexOf(letters);
  if (at < 0) return null;
  gs.cursor = at + letters.length;
  let out = "";
  for (let k = 0; k < letters.length; k++) {
    if (k > 0 && gs.spaceBefore[at + k]) out += " ";
    out += letters[k];
  }
  return out;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Read a File (PDF or model JSON) into a page model. */
export async function readFileToModel(file, opts = {}) {
  const buf = await file.arrayBuffer();
  if (/\.json$/i.test(file.name) || file.type === "application/json") {
    const model = JSON.parse(new TextDecoder().decode(buf));
    if (!Array.isArray(model.pages)) throw new Error("This JSON is not a page model (missing pages).");
    const from = opts.from ?? 1;
    const to = opts.to ?? Infinity;
    model.pages = model.pages.filter((p) => p.n >= from && p.n <= to);
    return model;
  }
  const model = await readPdf(buf, opts);
  model.title ||= file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  return model;
}
