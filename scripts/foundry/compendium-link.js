/**
 * Links an import to the RuneQuest: Glorantha Compendium module (runequestcompendiumfoundry).
 *
 * When that module is active, rules content it already holds (spells, skills, cults, gear, Runes,
 * sorcery journals, NPCs) is not imported a second time: NPCs embed the compendium's items and the
 * adventure text links to its actors instead.
 */
export const COMPENDIUM_ID = "runequestcompendiumfoundry";

const CHARS = ["strength", "constitution", "size", "dexterity", "intelligence", "power", "charisma"];

export function compendiumActive() {
  return !!game.modules.get(COMPENDIUM_ID)?.active;
}

/** Name keys that survive "Air (element)" vs "Air", "Vasana's Bison" vs "Vasana’s Bison", word order. */
export function nameKeys(name) {
  const s = String(name || "").toLowerCase().replace(/[’‘`]/g, "'");
  const loose = s.replace(/[^a-z0-9]+/g, " ").trim();
  const bare = s.replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const sorted = bare
    .split(" ")
    .filter((w) => w && !["of", "the", "and", "s"].includes(w))
    .sort()
    .join(" ");
  return [...new Set([loose, bare, sorted].filter(Boolean))];
}

export class CompendiumLink {
  /** @returns {Promise<CompendiumLink|null>} null when the compendium module isn't active */
  static async create() {
    if (!compendiumActive()) return null;
    const link = new CompendiumLink();
    link.rqids = new Map(); // rqid -> entry
    link.names = new Map(); // `${docType}|${type}|${key}` -> [entry]
    link.actors = [];
    const packs = game.packs.filter((p) => (p.metadata.packageName ?? p.metadata.package) === COMPENDIUM_ID);
    for (const pack of packs) {
      const docType = pack.documentName;
      const fields = ["type", "flags.rqg.documentRqidFlags"];
      if (docType === "Actor") fields.push(...CHARS.map((c) => `system.characteristics.${c}.value`));
      let index;
      try {
        index = await pack.getIndex({ fields });
      } catch (err) {
        console.warn(`rqg-importer | could not index ${pack.collection}`, err);
        continue;
      }
      for (const i of index) {
        const entry = {
          uuid: i.uuid ?? `Compendium.${pack.collection}.${docType}.${i._id}`,
          name: i.name,
          docType,
          type: i.type ?? "",
          pack: pack.collection,
          chars: docType === "Actor" ? CHARS.map((c) => Number(foundry.utils.getProperty(i, `system.characteristics.${c}.value`)) || 0) : null,
        };
        if (docType === "Actor") link.actors.push(entry);
        const rqid = i.flags?.rqg?.documentRqidFlags?.id;
        if (rqid && !link.rqids.has(rqid)) link.rqids.set(rqid, entry);
        for (const k of nameKeys(i.name)) {
          const key = `${docType}|${entry.type}|${k}`;
          if (!link.names.has(key)) link.names.set(key, []);
          link.names.get(key).push(entry);
        }
      }
    }
    link.size = link.rqids.size;
    return link;
  }

  byName(docType, type, name) {
    for (const k of nameKeys(name)) {
      const hit = this.names.get(`${docType}|${type ?? ""}|${k}`);
      if (hit?.length) return hit[0];
    }
    return null;
  }

  /** The compendium's copy of an item, matched by rqid, then by type and name. */
  item(data) {
    const rqid = data.flags?.rqg?.documentRqidFlags?.id;
    return (rqid && this.rqids.get(rqid)?.docType === "Item" ? this.rqids.get(rqid) : null) ?? this.byName("Item", data.type, data.name);
  }

  /** The compendium's journal for a sorcery spell. */
  sorcery(name) {
    for (const k of nameKeys(name)) {
      const hit = this.names.get(`JournalEntry||${k}`)?.find((e) => e.pack === `${COMPENDIUM_ID}.sorcery`);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * The compendium's copy of an NPC: same characteristics, and the same name or the same first name
   * ("Vasana Farnan's Daughter" is the compendium's "Vasana"). An adventure's own version of a
   * creature (other stats) is imported as its own actor.
   */
  actor(data) {
    const mine = CHARS.map((c) => Number(data.system?.characteristics?.[c]?.value) || 0);
    const sameStats = (e) => {
      if (!e.chars) return false;
      let compared = 0;
      for (let n = 0; n < CHARS.length; n++) {
        if (!mine[n] || !e.chars[n]) continue;
        if (mine[n] !== e.chars[n]) return false;
        compared++;
      }
      return compared >= 4;
    };
    const type = data.type ?? "character";
    for (const k of nameKeys(data.name)) {
      const same = (this.names.get(`Actor|${type}|${k}`) ?? []).find(sameStats);
      if (same) return same;
    }
    const first = (n) => nameKeys(n)[0]?.split(" ")[0];
    const f = first(data.name);
    return this.actors.find((e) => e.type === type && first(e.name) === f && sameStats(e)) ?? null;
  }
}
