/**
 * The importer window: pick a PDF (or a page-model JSON), analyse it, review what was found, import.
 */
import { KIND_INFO, MODULE_ID } from "../core/builders.js";
import { buildDocument } from "../core/layout.js";
import { parseBook } from "../core/parsers.js";
import { readFileToModel } from "./pdf-reader.js";
import { BookWriter } from "./writer.js";
import { compendiumActive } from "./compendium-link.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const KIND_ORDER = ["weapon", "armor", "gear", "spiritMagic", "runeMagic", "sorcery", "skill", "cult", "npc", "chapter"];
const KIND_HELP = {
  weapon: "Weapon, missile and shield tables, with descriptions and prices",
  armor: "Armor table, with descriptions and prices",
  gear: "Priced goods and services",
  spiritMagic: "Spirit magic spells (item + description journal)",
  runeMagic: "Rune magic spells (item + description journal)",
  sorcery: "Sorcery spells (journal only; the RQG system has no sorcery item yet)",
  skill: "Skills and weapon skills (item + description journal)",
  cult: "Rune cults (item + full write-up journal)",
  npc: "Stat blocks with characteristics, attacks and hit locations",
  chapter: "Whole chapters as journals: use for adventures and scenarios",
};

export class RqgImporterApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rqg-importer-app",
    tag: "div",
    classes: ["rqg-importer"],
    window: { title: "RQG Book Importer", icon: "fa-solid fa-book-open", resizable: true },
    position: { width: 760, height: 760 },
    actions: {
      analyze: RqgImporterApp.#onAnalyze,
      import: RqgImporterApp.#onImport,
      cancel: RqgImporterApp.#onCancel,
      toggleKind: RqgImporterApp.#onToggleKind,
      selectAll: RqgImporterApp.#onSelectAll,
      downloadJson: RqgImporterApp.#onDownloadJson,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/importer.hbs`, scrollable: [".rqgi-scroll"] },
  };

  constructor(options = {}) {
    super(options);
    this.file = null;
    this.imp = {
      bookTitle: "",
      bookKey: "",
      from: 1,
      to: "",
      detectFonts: true,
      overwrite: true,
      useCompendium: true,
      kinds: Object.fromEntries(KIND_ORDER.map((k) => [k, k !== "chapter"])),
      targets: { Item: "new", Actor: "new", JournalEntry: "new" },
      entities: null,
      excluded: new Set(),
      busy: false,
      progress: null,
      log: [],
    };
    this.signal = { cancelled: false };
  }

  async _prepareContext() {
    const s = this.imp;
    const packOptions = (docType) => [
      { value: "new", label: "New world compendiums for this book", selected: s.targets[docType] === "new" },
      ...game.packs
        .filter((p) => p.documentName === docType && (p.metadata.packageType !== "system"))
        .map((p) => ({ value: p.collection, label: `${p.metadata.label} (${p.metadata.packageName ?? p.metadata.package ?? "world"})`, selected: s.targets[docType] === p.collection })),
    ];
    let groups = [];
    if (s.entities) {
      groups = KIND_ORDER.map((k) => {
        const list = s.entities.filter((e) => e.kind === k).sort((a, b) => a.name.localeCompare(b.name));
        return {
          kind: k,
          label: KIND_INFO[k].label,
          enabled: s.kinds[k],
          count: list.length,
          selected: list.filter((e) => !s.excluded.has(e._key)).length,
          entries: list.map((e) => ({ key: e._key, name: e.name, page: e.page, checked: !s.excluded.has(e._key), extra: summary(e) })),
        };
      }).filter((g) => g.count);
    }
    return {
      fileName: this.file?.name ?? "",
      state: s,
      kinds: KIND_ORDER.map((k) => ({ kind: k, label: KIND_INFO[k].label, help: KIND_HELP[k], checked: s.kinds[k] })),
      itemPacks: packOptions("Item"),
      actorPacks: packOptions("Actor"),
      journalPacks: packOptions("JournalEntry"),
      groups,
      hasEntities: !!s.entities,
      hasCompendium: compendiumActive(),
      totalSelected: groups.reduce((n, g) => n + (g.enabled ? g.selected : 0), 0),
      progressPct: s.progress ? Math.round((100 * s.progress.done) / Math.max(1, s.progress.total)) : 0,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    const fileInput = el.querySelector("input[name=file]");
    fileInput?.addEventListener("change", (ev) => {
      this.file = ev.target.files?.[0] ?? null;
      if (this.file && !this.imp.bookTitle) this.imp.bookTitle = this.file.name.replace(/\.(pdf|json)$/i, "").replace(/[_-]+/g, " ").trim();
      this.imp.entities = null;
      this.render();
    });
    const drop = el.querySelector(".rqgi-drop");
    drop?.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      drop.classList.add("hover");
    });
    drop?.addEventListener("dragleave", () => drop.classList.remove("hover"));
    drop?.addEventListener("drop", (ev) => {
      ev.preventDefault();
      drop.classList.remove("hover");
      const f = ev.dataTransfer?.files?.[0];
      if (f) {
        this.file = f;
        if (!this.imp.bookTitle) this.imp.bookTitle = f.name.replace(/\.(pdf|json)$/i, "").replace(/[_-]+/g, " ").trim();
        this.imp.entities = null;
        this.render();
      }
    });
    for (const input of el.querySelectorAll("[data-field]")) {
      input.addEventListener("change", () => this.#readField(input));
    }
    for (const cb of el.querySelectorAll("input[data-entry]")) {
      cb.addEventListener("change", () => {
        if (cb.checked) this.imp.excluded.delete(cb.dataset.entry);
        else this.imp.excluded.add(cb.dataset.entry);
        const counter = el.querySelector(".rqgi-total");
        if (counter) counter.textContent = String(this.#selectedEntities().length);
      });
    }
    const logEl = el.querySelector(".rqgi-log");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  #readField(input) {
    const s = this.imp;
    const f = input.dataset.field;
    const v = input.type === "checkbox" ? input.checked : input.value;
    if (f.startsWith("target.")) s.targets[f.slice(7)] = v;
    else if (f.startsWith("kind.")) s.kinds[f.slice(5)] = v;
    else if (f === "from" || f === "to") s[f] = v === "" ? "" : Math.max(1, parseInt(v, 10) || 1);
    else s[f] = v;
  }

  #log(msg) {
    this.imp.log.push(msg);
    if (this.imp.log.length > 200) this.imp.log.shift();
  }

  #selectedEntities() {
    const s = this.imp;
    return (s.entities || []).filter((e) => s.kinds[e.kind] && !s.excluded.has(e._key));
  }

  #throttledRender = foundry.utils.throttle(() => this.render(), 250);

  static async #onAnalyze() {
    const s = this.imp;
    if (s.busy) return;
    if (!this.file) return ui.notifications.warn("Choose a PDF (or page-model JSON) first.");
    s.busy = true;
    s.entities = null;
    s.excluded = new Set();
    s.log = [];
    this.signal = { cancelled: false };
    s.progress = { label: "Reading PDF", done: 0, total: 1 };
    this.render();
    try {
      const model = await readFileToModel(this.file, {
        from: Number(s.from) || 1,
        to: s.to ? Number(s.to) : Infinity,
        detectFonts: s.detectFonts,
        signal: this.signal,
        onProgress: (done, total) => {
          s.progress = { label: `Reading page ${done} of ${total}`, done, total };
          this.#throttledRender();
        },
      });
      if (!s.bookTitle) s.bookTitle = model.title || "Untitled book";
      if (!s.bookKey) s.bookKey = s.bookTitle;
      s.progress = { label: "Analysing layout", done: 0, total: 1 };
      this.render();
      const doc = buildDocument(model);
      const entities = parseBook(doc, { includeChapters: true });
      entities.forEach((e, n) => (e._key = `${e.kind}:${n}`));
      s.entities = entities;
      this._lastModel = model;
      const counts = KIND_ORDER.map((k) => `${KIND_INFO[k].label}: ${entities.filter((e) => e.kind === k).length}`).join(", ");
      this.#log(`Read ${model.pages.length} pages (body font ${doc.stats.bodyFamily || "?"} ${doc.stats.bodySize}pt). Found ${counts}.`);
      if (!doc.stats.bodyFamily) this.#log("Fonts could not be identified; bold lead-ins (gear, stat block labels) may be missed.");
    } catch (err) {
      console.error(err);
      this.#log(`Error: ${err.message}`);
      ui.notifications.error(`RQG Importer: ${err.message}`);
    } finally {
      s.busy = false;
      s.progress = null;
      this.render();
    }
  }

  static async #onImport() {
    const s = this.imp;
    if (s.busy) return;
    const list = this.#selectedEntities();
    if (!list.length) return ui.notifications.warn("Nothing selected to import.");
    if (!game.user.isGM) return ui.notifications.error("Only a GM can import into compendiums.");
    s.busy = true;
    s.progress = { label: "Importing", done: 0, total: list.length };
    this.render();
    try {
      const writer = new BookWriter(
        { title: s.bookTitle || "Untitled book", key: s.bookKey || s.bookTitle },
        {
          targets: s.targets,
          overwrite: s.overwrite,
          useCompendium: s.useCompendium,
          log: (m) => {
            this.#log(m);
            s.progress = { ...(s.progress || {}), label: m };
            this.#throttledRender();
          },
          onProgress: (phase, done, total, label) => {
            s.progress = { label: `Writing ${label ?? ""} ${done}/${total}`, done, total };
            this.#throttledRender();
          },
        },
      );
      const sum = await writer.write(list);
      const where = sum.packs.size ? `, in ${[...sum.packs].join("; ")}` : "";
      this.#log(`Done: ${sum.created} created, ${sum.updated} replaced, ${sum.skipped} skipped, ${sum.linked} already in the RuneQuest Compendium${where}.`);
      if (sum.linked) console.log(`${MODULE_ID} | linked to the RuneQuest Compendium:\n${sum.linkedNames.join("\n")}`);
      for (const w of sum.warnings) this.#log(`Warning: ${w}`);
      ui.notifications.info(`RQG Importer: imported ${sum.created + sum.updated} documents from ${s.bookTitle}${sum.linked ? `, linked ${sum.linked} to the RuneQuest Compendium` : ""}.`);
    } catch (err) {
      console.error(err);
      this.#log(`Error: ${err.message}`);
      ui.notifications.error(`RQG Importer: ${err.message}`);
    } finally {
      s.busy = false;
      s.progress = null;
      this.render();
    }
  }

  static #onCancel() {
    this.signal.cancelled = true;
  }

  static #onToggleKind(event, target) {
    const k = target.dataset.kind;
    const list = (this.imp.entities || []).filter((e) => e.kind === k);
    const allOn = list.every((e) => !this.imp.excluded.has(e._key));
    for (const e of list) allOn ? this.imp.excluded.add(e._key) : this.imp.excluded.delete(e._key);
    this.render();
  }

  static #onSelectAll() {
    this.imp.excluded.clear();
    this.render();
  }

  static #onDownloadJson() {
    if (!this.imp.entities) return;
    const data = JSON.stringify(this.imp.entities, null, 1);
    foundry.utils.saveDataToFile(data, "application/json", `${(this.imp.bookTitle || "book").replace(/[^\w-]+/g, "_")}-parsed.json`);
  }
}

function summary(e) {
  const d = e.data || {};
  switch (e.kind) {
    case "weapon":
      return Object.entries(d.usages || {})
        .map(([k, u]) => `${u.skill} ${u.base}% ${u.damage}`)
        .join(" · ");
    case "armor":
      return `${d.absorbs} AP, ${d.area}`;
    case "gear":
      return d.priceText || "";
    case "spiritMagic":
    case "runeMagic":
    case "sorcery":
      return `${d.pointsText} — ${d.traits}`;
    case "skill":
      return `${d.category} (${d.baseText})`;
    case "cult":
      return d.tagline || "";
    case "npc":
      return Object.entries(d.characteristics || {})
        .map(([k, v]) => `${k} ${v ?? "—"}`)
        .join(" ") + ` · ${d.attacks?.length ?? 0} attacks · ${d.hitLocations?.length ?? 0} locations`;
    case "chapter":
      return `${d.sections?.length ?? 0} sections`;
    default:
      return "";
  }
}
