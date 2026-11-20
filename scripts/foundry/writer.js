/**
 * Writes parsed book content into compendiums, organised Book > Type > alphabetical name.
 *
 * Default target: world compendiums created per book, grouped in a Compendium sidebar folder named after
 * the book (one pack per type). Alternative target: existing packs (e.g. a compendium module); then the
 * book and type become folders inside the chosen pack.
 */
import {
  KIND_INFO,
  MODULE_ID,
  bookSlug,
  buildChapterJournal,
  buildDescriptionJournal,
  buildItem,
  buildNpcPlan,
  fallbackNpcItem,
  needsJournal,
} from "../core/builders.js";
import { slugify } from "../core/layout.js";

const CHUNK = 40;

function CC() {
  return foundry.documents?.collections?.CompendiumCollection ?? globalThis.CompendiumCollection;
}

function docClass(type) {
  return CONFIG[type].documentClass;
}

function norm(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["of", "the", "and"].includes(w))
    .sort()
    .join(" ");
}

function exactNorm(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9()]+/g, " ").trim();
}

/** "Command (Cult Spirit)" and "Command Cult Spirit" look the same. */
function looseNorm(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export class BookWriter {
  /**
   * @param {object} book {title, key}
   * @param {object} options {targets: {Item, Actor, JournalEntry} pack collection ids or "new", overwrite, onProgress, log}
   */
  constructor(book, options = {}) {
    this.book = { ...book, importedAt: new Date().toISOString() };
    this.targets = options.targets || {};
    this.overwrite = options.overwrite ?? true;
    this.onProgress = options.onProgress || (() => {});
    this.log = options.log || ((m) => console.log(`${MODULE_ID} | ${m}`));
    this.packCache = new Map();
    this.summary = { created: 0, updated: 0, skipped: 0, packs: new Set(), warnings: [] };
    this.actorLinks = new Map(); // npc key -> @UUID link
  }

  /* ---------------------------------------------------------- sidebar */

  async bookFolder() {
    if (this._bookFolder) return this._bookFolder;
    let f = game.folders.find((x) => x.type === "Compendium" && x.name === this.book.title);
    f ??= await Folder.create({ name: this.book.title, type: "Compendium", sorting: "a", color: "#5b2a1e" });
    return (this._bookFolder = f);
  }

  /** Pack for a kind: either the shared target pack chosen by the user, or a world pack per book+type. */
  async packFor(kind) {
    const info = KIND_INFO[kind];
    const docType = info.docType;
    const target = this.targets[docType];
    const cacheKey = target && target !== "new" ? target : `${docType}:${kind}`;
    if (this.packCache.has(cacheKey)) return this.packCache.get(cacheKey);
    let entry;
    if (target && target !== "new") {
      const pack = game.packs.get(target);
      if (!pack) throw new Error(`Compendium ${target} not found`);
      if (pack.locked) await pack.configure({ locked: false });
      entry = { pack, shared: true };
    } else {
      // Journals for one book share one pack (type folders inside); items and actors get a pack per type
      const label = docType === "JournalEntry" ? "Journals" : info.label;
      const name = `rqgi-${bookSlug(this.book.key)}-${slugify(label)}`.slice(0, 60);
      let pack = game.packs.get(`world.${name}`);
      if (!pack) {
        pack = await CC().createCompendium({ label: `${this.book.title}: ${label}`, name, type: docType, system: "rqg" });
        this.log(`Created compendium ${pack.metadata.label}`);
      }
      const folder = await this.bookFolder();
      try {
        if (pack.folder?.id !== folder.id) await (pack.setFolder ? pack.setFolder(folder) : pack.configure({ folder: folder.id }));
      } catch (err) {
        console.warn(`${MODULE_ID} | could not move pack into folder`, err);
      }
      entry = { pack, shared: false };
    }
    this.packCache.set(cacheKey, entry);
    this.summary.packs.add(entry.pack.metadata.label);
    return entry;
  }

  /** Folder path inside a pack: shared packs get Book > Type; per-book journal pack gets Type. */
  async folderIn(entry, docType, kind) {
    const path = [];
    if (entry.shared) path.push(this.book.title);
    if (entry.shared || docType === "JournalEntry") path.push(KIND_INFO[kind]?.label ?? kind);
    let parent = null;
    for (const name of path) {
      const coll = entry.pack.folders;
      let f = coll?.find((x) => x.name === name && (x.folder?.id ?? x.folder ?? null) === (parent?.id ?? null));
      f ??= await Folder.create({ name, type: docType, sorting: "a", folder: parent?.id ?? null }, { pack: entry.pack.collection });
      parent = f;
    }
    return parent;
  }

  /* ------------------------------------------------------------ write */

  /**
   * Create or replace documents (matched by type+name within this book) in a pack, alphabetically sorted.
   * @returns {Promise<Document[]>}
   */
  async upsert(entry, docType, datas, folder) {
    const pack = entry.pack;
    const cls = docClass(docType);
    const index = await pack.getIndex({ fields: [`flags.${MODULE_ID}.bookKey`, "type", "folder"] });
    const existing = new Map();
    for (const i of index) {
      if (i.flags?.[MODULE_ID]?.bookKey !== this.book.key) continue;
      existing.set(`${i.type ?? ""}|${i.name}`, i._id);
    }
    datas.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    const toDelete = [];
    const toCreate = [];
    datas.forEach((d, n) => {
      d.sort = (n + 1) * 100;
      if (folder) d.folder = folder.id;
      const key = `${d.type ?? ""}|${d.name}`;
      const id = existing.get(key);
      if (id) {
        if (!this.overwrite) {
          this.summary.skipped++;
          return;
        }
        toDelete.push(id);
        d._id = id;
        this.summary.updated++;
      } else this.summary.created++;
      toCreate.push(d);
    });
    for (let i = 0; i < toDelete.length; i += CHUNK) await cls.deleteDocuments(toDelete.slice(i, i + CHUNK), { pack: pack.collection });
    const created = [];
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const chunk = toCreate.slice(i, i + CHUNK);
      const docs = await cls.createDocuments(chunk, { pack: pack.collection, keepId: true });
      created.push(...docs);
      this.onProgress("write", Math.min(i + CHUNK, toCreate.length), toCreate.length, KIND_INFO[datas[0]?.flags?.[MODULE_ID]?.kind]?.label);
    }
    return created;
  }

  /** Main entry point: entities from parsers.parseBook(). */
  async write(entities) {
    const byKind = new Map();
    for (const e of entities) {
      if (!byKind.has(e.kind)) byKind.set(e.kind, []);
      byKind.get(e.kind).push(e);
    }
    // 1. Items, one pack (or folder) per type
    for (const kind of ["weapon", "armor", "gear", "spiritMagic", "runeMagic", "skill", "cult"]) {
      const list = byKind.get(kind);
      if (!list?.length) continue;
      const entry = await this.packFor(kind);
      const folder = await this.folderIn(entry, "Item", kind);
      const datas = list.map((e) => buildItem(this.book, e)).filter(Boolean);
      this.log(`Writing ${datas.length} ${KIND_INFO[kind].label}`);
      await this.upsert(entry, "Item", datas, folder);
    }
    // 2. Description journals (spells, cults, skills) and sorcery, grouped by type folder
    const journalKinds = new Map();
    for (const e of entities) {
      if (e.kind === "chapter" || !needsJournal(e)) continue;
      if (!journalKinds.has(e.kind)) journalKinds.set(e.kind, []);
      journalKinds.get(e.kind).push(buildDescriptionJournal(this.book, e));
    }
    for (const [kind, datas] of journalKinds) {
      const entry = await this.packFor("chapter"); // the book's journal pack
      const folder = await this.folderIn(entry, "JournalEntry", kind);
      this.log(`Writing ${datas.length} ${KIND_INFO[kind]?.label ?? kind} descriptions`);
      await this.upsert(entry, "JournalEntry", datas, folder);
    }
    // 3. NPCs and creatures (before chapters, so stat blocks in the text can link to them)
    const npcs = byKind.get("npc") || [];
    if (npcs.length) {
      const entry = await this.packFor("npc");
      const folder = await this.folderIn(entry, "Actor", "npc");
      const resolver = await ItemResolver.create(this.book.key);
      const datas = [];
      for (const e of npcs) {
        try {
          datas.push(await this.planActor(e, resolver));
        } catch (err) {
          this.summary.warnings.push(`${e.name}: ${err.message}`);
          console.error(err);
        }
      }
      this.log(`Writing ${datas.length} NPCs`);
      const created = await this.upsert(entry, "Actor", datas, folder);
      for (const actor of created) {
        const key = actor.flags?.[MODULE_ID]?.npcKey;
        if (key) this.actorLinks.set(key, `@UUID[${actor.uuid}]{${actor.name}}`);
        try {
          await finalizeActor(actor);
        } catch (err) {
          this.summary.warnings.push(`${actor.name}: ${err.message}`);
          console.error(err);
        }
      }
    }
    // 4. Chapters / adventure text, with stat blocks linked to the imported actors
    const chapters = byKind.get("chapter") || [];
    if (chapters.length) {
      const entry = await this.packFor("chapter");
      const folder = await this.folderIn(entry, "JournalEntry", "chapter");
      const datas = chapters.map((e) => buildChapterJournal(this.book, e)).filter((d) => d.pages.length);
      for (const d of datas) {
        for (const pg of d.pages) {
          pg.text.content = pg.text.content.replace(/\{\{NPC:([^}]+)\}\}/g, (m, key) => (this.actorLinks.has(key) ? `Actor: ${this.actorLinks.get(key)}` : ""));
        }
      }
      // keep book order for chapters: prefix with a running number
      datas.forEach((d, n) => (d.name = `${String(n + 1).padStart(2, "0")}. ${d.name}`));
      this.log(`Writing ${datas.length} chapter journals`);
      await this.upsert(entry, "JournalEntry", datas, folder);
    }
    return this.summary;
  }

  /** Turn an NPC entity into actor data with embedded items resolved from compendiums. */
  async planActor(e, resolver) {
    const { actor, wanted } = buildNpcPlan(this.book, e);
    const items = [...actor.items];
    const randomID = foundry.utils.randomID;
    const addItem = (data, extraFlags = {}) => {
      data._id ??= randomID();
      data.flags = foundry.utils.mergeObject(data.flags ?? {}, { [MODULE_ID]: extraFlags });
      items.push(data);
      return data;
    };
    const skillsByName = new Map();
    const wantSkill = async (w) => {
      const key = exactNorm(w.name);
      if (skillsByName.has(key)) {
        const s = skillsByName.get(key);
        s.flags[MODULE_ID].targetChance = Math.max(s.flags[MODULE_ID].targetChance ?? 0, w.chance ?? 0);
        return s;
      }
      const found = await resolver.get("skill", w.name, w.base);
      const data = found ? found : fallbackNpcItem({ ...w, type: "skill" });
      if (found && w.spec && !found.system.specialization) {
        data.system.specialization = w.spec;
        data.name = w.name;
      }
      const s = addItem(data, { targetChance: w.chance ?? 0 });
      skillsByName.set(key, s);
      return s;
    };

    // cult first so rune spells can point at it
    let cultId = "";
    for (const w of wanted.filter((x) => x.type === "cult")) {
      const found = await resolver.get("cult", w.name);
      const data = found ?? fallbackNpcItem(w);
      data.system.runePoints = { value: w.runePoints, max: w.runePoints };
      if (data.system.joinedCults?.[0]) data.system.joinedCults[0].rank = "initiate";
      cultId = addItem(data)._id;
    }
    for (const w of wanted) {
      switch (w.type) {
        case "weapon": {
          const found = await resolver.get("weapon", w.name);
          let data;
          if (found) {
            data = found;
            data.system.equippedStatus = "equipped";
            if (w.hp && !data.system.isNatural) data.system.hitPoints = { value: w.hp, max: w.hp };
            const usageKey = w.hands && data.system.usage?.[w.hands]?.skillRqidLink ? w.hands : data.system.defaultUsage || "oneHand";
            data.system.defaultUsage = usageKey;
            const link = data.system.usage?.[usageKey]?.skillRqidLink;
            if (link?.rqid) {
              const skillName = link.name || link.rqid.split(".").pop().replace(/-/g, " ");
              const sk = await wantSkill({ name: skillName, base: skillName, chance: w.chance, weaponSkill: true });
              // make sure the weapon points at the embedded skill's rqid
              const skRqid = sk.flags?.rqg?.documentRqidFlags?.id;
              if (skRqid) data.system.usage[usageKey].skillRqidLink = { rqid: skRqid, name: sk.name };
            }
          } else {
            data = fallbackNpcItem(w);
            const sk = await wantSkill({ name: w.name, base: w.name, chance: w.chance, category: data.system.isNatural ? "naturalWeapons" : "meleeWeapons" });
            data.system.usage.oneHand.skillRqidLink = { rqid: sk.flags.rqg.documentRqidFlags.id, name: sk.name };
          }
          addItem(data, { printedChance: w.chance, printedDamage: w.rawDamage, printedSr: w.sr });
          break;
        }
        case "skill":
          await wantSkill(w);
          break;
        case "passion": {
          const data = fallbackNpcItem(w);
          addItem(data);
          break;
        }
        case "rune": {
          const found = await resolver.get("rune", w.name);
          const data = found ?? fallbackNpcItem(w);
          if (data) {
            data.system.chance = w.chance;
            addItem(data);
          }
          break;
        }
        case "spiritMagic":
        case "runeMagic": {
          const found = await resolver.get(w.type, w.name);
          const data = found ?? fallbackNpcItem(w);
          if (w.points) data.system.points = w.points;
          if (w.type === "runeMagic") data.system.cultId = cultId;
          addItem(data);
          break;
        }
      }
    }
    actor.items = items;
    return actor;
  }
}

/** After creation: hit location HP deltas and skill gained chances so the sheet shows the printed values. */
export async function finalizeActor(actor) {
  const totalHp = Number(actor.system?.attributes?.hitPoints?.max) || 0;
  const mods = actor.system?.skillCategoryModifiers ?? {};
  const updates = [];
  for (const item of actor.items) {
    const f = item.flags?.[MODULE_ID] ?? {};
    if (item.type === "hitLocation" && f.targetHp != null && totalHp) {
      const base = Math.max(2, Math.ceil(totalHp / 3));
      updates.push({ _id: item.id, "system.baseHpDelta": f.targetHp - base, "system.hitPoints.value": f.targetHp });
    }
    if (item.type === "skill" && f.targetChance != null) {
      const base = Number(item.system.baseChance) || 0;
      const mod = Number(mods[item.system.category]) || 0;
      updates.push({ _id: item.id, "system.gainedChance": Math.max(0, f.targetChance - base - mod) });
    }
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

/** Looks items up by type and name across all Item compendiums (this book's packs first). */
export class ItemResolver {
  static async create(bookKey) {
    const r = new ItemResolver();
    r.bookKey = bookKey;
    r.index = new Map(); // type -> Map(normName -> [{pack, id, own, exact}])
    for (const pack of game.packs.filter((p) => p.documentName === "Item")) {
      let idx;
      try {
        idx = await pack.getIndex({ fields: ["type", `flags.${MODULE_ID}.bookKey`, "flags.rqg.documentRqidFlags"] });
      } catch {
        continue;
      }
      for (const i of idx) {
        if (!r.index.has(i.type)) r.index.set(i.type, new Map());
        const m = r.index.get(i.type);
        const own = i.flags?.[MODULE_ID]?.bookKey === bookKey;
        const prio = Number(i.flags?.rqg?.documentRqidFlags?.priority) || 0;
        for (const key of new Set([exactNorm(i.name), looseNorm(i.name), norm(i.name)])) {
          if (!m.has(key)) m.set(key, []);
          m.get(key).push({ pack, id: i._id, own, prio, name: i.name });
        }
      }
    }
    return r;
  }

  /** @returns {Promise<object|null>} plain item data without _id */
  async get(type, name, altName) {
    const m = this.index.get(type);
    if (!m) return null;
    let hits =
      m.get(exactNorm(name)) || m.get(looseNorm(name)) || m.get(norm(name)) || (altName ? m.get(exactNorm(altName)) || m.get(looseNorm(altName)) || m.get(norm(altName)) : null);
    if (!hits?.length) return null;
    hits = [...hits].sort((a, b) => Number(b.own) - Number(a.own) || b.prio - a.prio);
    const doc = await hits[0].pack.getDocument(hits[0].id);
    if (!doc) return null;
    const data = doc.toObject();
    delete data._id;
    delete data.folder;
    delete data.sort;
    delete data.ownership;
    delete data._stats;
    return data;
  }
}
