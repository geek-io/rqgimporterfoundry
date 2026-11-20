/**
 * Builders: parsed entities -> Foundry document data for the RuneQuest Glorantha (rqg) system.
 * Pure functions (no Foundry globals) so they can be unit-tested in Node.
 */
import { cleanText, escapeHtml, slugify } from "./layout.js";
import { dehyphen, RUNE_TYPES, skillCategory } from "./parsers.js";

export const MODULE_ID = "rqg-importer";
export const RQID_PRIORITY = 100;

export const KIND_INFO = {
  weapon: { docType: "Item", itemType: "weapon", label: "Weapons", rqidType: "weapon", icon: "icons/weapons/swords/sword-guard-brown.webp" },
  armor: { docType: "Item", itemType: "armor", label: "Armor", rqidType: "armor", icon: "icons/equipment/chest/breastplate-banded-steel-grey.webp" },
  gear: { docType: "Item", itemType: "gear", label: "Equipment", rqidType: "gear", icon: "icons/containers/bags/pack-leather-brown.webp" },
  spiritMagic: { docType: "Item", itemType: "spiritMagic", label: "Spirit Magic", rqidType: "spirit-magic", icon: "icons/magic/light/explosion-star-glow-silhouette.webp" },
  runeMagic: { docType: "Item", itemType: "runeMagic", label: "Rune Magic", rqidType: "rune-magic", icon: "icons/magic/symbols/runes-star-pentagon-orange.webp" },
  sorcery: { docType: "JournalEntry", label: "Sorcery Spells" },
  skill: { docType: "Item", itemType: "skill", label: "Skills", rqidType: "skill", icon: "icons/skills/trades/academics-study-reading-book.webp" },
  cult: { docType: "Item", itemType: "cult", label: "Cults", rqidType: "cult", icon: "icons/environment/settlement/temple.webp" },
  npc: { docType: "Actor", label: "NPCs & Creatures" },
  chapter: { docType: "JournalEntry", label: "Chapters & Adventures" },
};

export function bookSlug(title) {
  return slugify(title).slice(0, 40) || "book";
}

export function itemRqid(kind, name) {
  const t = KIND_INFO[kind]?.rqidType ?? kind;
  return `i.${t}.${slugify(name)}`;
}

export function journalRqid(book, kind, name) {
  return `je..rqgi-${bookSlug(book)}-${slugify(kind)}-${slugify(name)}`.slice(0, 120);
}

function rqidFlags(id, priority = RQID_PRIORITY) {
  return { rqg: { documentRqidFlags: { id, lang: "en", priority } } };
}

function sourceFlags(book, e) {
  return { [MODULE_ID]: { book: book.title, bookKey: book.key, page: e.page ?? null, pdfPage: e.pdfPage ?? null, kind: e.kind, importedAt: book.importedAt ?? null } };
}

function sourceLine(book, e) {
  return `<p class="rqgi-source"><em>Source: ${escapeHtml(book.title)}${e.page ? `, p.${e.page}` : ""}</em></p>`;
}

function merge(...objs) {
  const out = {};
  for (const o of objs) {
    for (const [k, v] of Object.entries(o || {})) {
      out[k] = out[k] && typeof out[k] === "object" && typeof v === "object" ? { ...out[k], ...v } : v;
    }
  }
  return out;
}

/* ------------------------------------------------------------- weapons */

const MANEUVERS = {
  C: [{ name: "Bash", damageType: "crush" }],
  S: [{ name: "Cut", damageType: "slash" }],
  I: [{ name: "Thrust", damageType: "impale" }],
  CT: [
    { name: "Cut", damageType: "slash" },
    { name: "Thrust", damageType: "impale" },
  ],
  H: [{ name: "Hit", damageType: "crush" }],
};

function emptyUsage() {
  return { skillRqidLink: null, combatManeuvers: [], damage: "", minStrength: 0, minDexterity: 0, strikeRank: null };
}

function usageFrom(u, { missile = false, thrown = false, natural = false, name = "" } = {}) {
  const type = (u.type || "").toUpperCase().replace(/[^A-Z]/g, "");
  let maneuvers = (MANEUVERS[type] || MANEUVERS.C).map((m) => ({ ...m, description: "" }));
  if (/grapple/i.test(name)) maneuvers = [{ name: "Grapple", damageType: "special", description: "" }];
  if (/^fist$|cestus|claw/i.test(name)) maneuvers = maneuvers.map((m) => (m.name === "Hit" ? { ...m, name: "Punch" } : m));
  if (/^kick$/i.test(name)) maneuvers = [{ name: "Kick", damageType: "crush", description: "" }];
  if (missile) maneuvers = maneuvers.map((m) => ({ ...m, name: thrown ? "Throw" : "Shoot" }));
  if (u.shield) maneuvers = [{ name: "Bash", damageType: "crush", description: "" }];
  if (!missile && !natural && !/grapple|lasso/i.test(name)) maneuvers.push({ name: "Parry", damageType: "parry", description: "" });
  const damage = /^[—–-]?\*?$|special/i.test(u.damage || "") ? "" : String(u.damage || "").replace(/[—*]/g, "").trim();
  return {
    skillRqidLink: u.skill ? { rqid: `i.skill.${slugify(u.skill)}`, name: u.skill } : null,
    combatManeuvers: maneuvers,
    damage,
    minStrength: u.minStrength || 0,
    minDexterity: u.minDexterity || 0,
    strikeRank: u.sr == null ? null : u.sr,
  };
}

export function buildWeapon(book, e) {
  const w = e.data;
  const usage = { oneHand: emptyUsage(), offHand: emptyUsage(), twoHand: emptyUsage(), missile: emptyUsage() };
  const thrown = w.missileKind === "thrown";
  for (const [k, u] of Object.entries(w.usages || {})) {
    usage[k] = usageFrom(u, { missile: k === "missile", thrown, natural: w.isNatural, name: w.name || e.name });
  }
  const defaultUsage = ["oneHand", "twoHand", "missile"].find((k) => w.usages?.[k]) ?? null;
  const hp = typeof w.hp === "number" ? w.hp : null;
  const facts = [];
  if (w.length) facts.push(`Length ${escapeHtml(w.length)} m`);
  if (w.range) facts.push(`Range ${w.range} m`);
  if (w.material) facts.push(`Material: ${escapeHtml(w.material)}`);
  const html = (e.html || "") + (facts.length ? `<p>${facts.join(" · ")}</p>` : "") + sourceLine(book, e);
  return {
    name: e.name,
    type: "weapon",
    img: KIND_INFO.weapon.icon,
    system: {
      description: html,
      physicalItemType: "unique",
      quantity: 1,
      encumbrance: w.enc ?? 0,
      equippedStatus: "carried",
      price: { real: w.price ?? 0, estimated: w.priceEstimated ?? w.price ?? 0 },
      usage,
      defaultUsage,
      hitPoints: w.isNatural ? { value: null, max: null } : { value: hp ?? 0, max: hp ?? 0 },
      hitPointLocation: w.isNatural ? (/kick/i.test(e.name) ? "Leg" : "Arm") : "",
      isNatural: !!w.isNatural,
      rate: w.rate ?? 0,
      range: w.range ?? 0,
      isProjectile: false,
      isProjectileWeapon: w.missileKind === "projectileWeapon",
      isThrownWeapon: thrown,
      isRangedWeapon: !!w.usages?.missile,
    },
    flags: merge(rqidFlags(itemRqid("weapon", e.name)), sourceFlags(book, e)),
  };
}

/* --------------------------------------------------------------- armor */

export function buildArmor(book, e) {
  const a = e.data;
  const notes = [];
  if (a.wornUnder) notes.push("Can be worn under other armor with a cumulative encumbrance penalty.");
  const html = (e.html || "") + (notes.length ? `<p>${notes.join(" ")}</p>` : "") + `<p>Covers: ${escapeHtml(a.area || "")} (${escapeHtml(a.hitLocations || "")})</p>` + sourceLine(book, e);
  return {
    name: e.name,
    type: "armor",
    img: KIND_INFO.armor.icon,
    system: {
      description: html,
      physicalItemType: "unique",
      quantity: 1,
      encumbrance: a.enc ?? 0,
      equippedStatus: "carried",
      price: { real: a.price ?? 0, estimated: a.priceEstimated ?? a.price ?? 0 },
      size: 0,
      hitLocationRqidLinks: (a.locations || []).map((l) => ({ rqid: `i.hit-location.${l}`, name: l.replace(/-/g, " ") })),
      namePrefix: "",
      armorType: a.armorType || "",
      material: a.material || "",
      absorbs: a.absorbs || 0,
      moveQuietlyPenalty: a.moveQuietly || 0,
    },
    flags: merge(rqidFlags(itemRqid("armor", e.name)), sourceFlags(book, e)),
  };
}

/* ---------------------------------------------------------------- gear */

export function buildGear(book, e) {
  const g = e.data;
  const html = (e.html || "") + (g.category ? `<p>Category: ${escapeHtml(g.category)}</p>` : "") + sourceLine(book, e);
  return {
    name: e.name,
    type: "gear",
    img: KIND_INFO.gear.icon,
    system: {
      description: html,
      physicalItemType: "unique",
      quantity: 1,
      encumbrance: 0,
      equippedStatus: "carried",
      price: { real: g.price ?? 0, estimated: g.priceEstimated ?? g.price ?? 0 },
    },
    flags: merge(rqidFlags(itemRqid("gear", e.name)), sourceFlags(book, e)),
  };
}

/* -------------------------------------------------------------- spells */

function spellHeaderHtml(e) {
  const d = e.data;
  const bits = [d.pointsText, d.traits].filter(Boolean).map(escapeHtml);
  const rune = d.runeText ? `<p><em>${escapeHtml(d.runeText)}</em></p>` : "";
  return `${rune}<p><strong>${bits.join(" — ")}</strong></p>`;
}

export function buildSpell(book, e) {
  const d = e.data;
  const jr = journalRqid(book.key, e.kind, e.name);
  const base = {
    points: d.points ?? 1,
    castingRange: d.castingRange ?? "ranged",
    duration: d.duration ?? "temporal",
    concentration: d.concentration ?? "passive",
    isRitual: !!d.isRitual,
    isEnchantment: !!d.isEnchantment,
    resistedBy: d.resistedBy || "none",
    descriptionRqidLink: { rqid: jr, name: e.name },
  };
  const system =
    e.kind === "spiritMagic"
      ? { ...base, isVariable: !!d.isVariable, spellFocus: "", isMatrix: false }
      : { ...base, cultId: "", runeRqidLinks: [], isStackable: !!d.isStackable, isOneUse: !!d.isOneUse };
  return {
    name: e.name,
    type: e.kind,
    img: KIND_INFO[e.kind].icon,
    system,
    flags: merge(rqidFlags(itemRqid(e.kind, e.name)), sourceFlags(book, e), { [MODULE_ID]: { journalRqid: jr } }),
  };
}

/* -------------------------------------------------------------- skills */

export function buildSkill(book, e) {
  const d = e.data;
  const jr = e.html ? journalRqid(book.key, "skill", e.name) : "";
  const spec = /^(all|deity|species|type|substance)$/i.test(d.specialization || "") ? "" : d.specialization || "";
  return {
    name: spec ? `${d.skillName} (${spec})` : d.skillName || e.name,
    type: "skill",
    img: KIND_INFO.skill.icon,
    system: {
      category: d.category || "otherSkills",
      skillName: d.skillName || e.name,
      specialization: spec,
      baseChance: d.baseChance || 0,
      gainedChance: 0,
      canGetExperience: true,
      hasExperience: false,
      descriptionRqidLink: jr ? { rqid: jr, name: e.name } : null,
      runeRqidLinks: [],
    },
    flags: merge(rqidFlags(itemRqid("skill", e.name.replace(/\s*\((all|deity|species|type)\)$/i, ""))), sourceFlags(book, e), {
      [MODULE_ID]: { journalRqid: jr || null, baseText: d.baseText },
    }),
  };
}

/* --------------------------------------------------------------- cults */

export function buildCult(book, e) {
  const d = e.data;
  const jr = journalRqid(book.key, "cult", e.name);
  return {
    name: e.name,
    type: "cult",
    img: KIND_INFO.cult.icon,
    system: {
      deity: e.name,
      descriptionRqidLink: { rqid: jr, name: e.name },
      runePoints: { value: 0, max: 0 },
      holyDays: d.holyDays || "",
      gifts: d.gifts || "",
      geases: d.geases || "",
      runeRqidLinks: [],
      commonRuneMagicRqidLinks: [],
      joinedCults: [{ cultName: e.name, tagline: d.tagline || "", rank: "layMember" }],
    },
    flags: merge(rqidFlags(itemRqid("cult", e.name)), sourceFlags(book, e), { [MODULE_ID]: { journalRqid: jr, cultData: d } }),
  };
}

/* ------------------------------------------------------------ journals */

export function buildDescriptionJournal(book, e) {
  const kindLabel = KIND_INFO[e.kind]?.label ?? e.kind;
  let content = e.html || "";
  if (["spiritMagic", "runeMagic", "sorcery"].includes(e.kind)) content = spellHeaderHtml(e) + content;
  if (e.kind === "cult") {
    const d = e.data;
    const rows = [
      ["Cult Skills", d.cultSkills],
      ["Spirit Magic", d.spiritMagic],
      ["Common Rune Magic", d.commonRuneMagic],
      ["Special Rune Magic", d.specialRuneMagic],
      ["Enchantments", d.enchantments],
      ["Favored Passions", d.favoredPassions],
    ].filter((r) => r[1]);
    const summary = rows.map(([k, v]) => `<p><strong>${k}:</strong> ${escapeHtml(v)}</p>`).join("");
    content = (d.tagline ? `<p><em>${escapeHtml(d.tagline)}</em></p>` : "") + summary + content;
  }
  if (e.kind === "skill") content = `<p><strong>Base chance:</strong> ${escapeHtml(e.data.baseText ?? e.data.baseChance)}</p>` + content;
  content += sourceLine(book, e);
  const jr = journalRqid(book.key, e.kind, e.name);
  return {
    name: e.name,
    pages: [{ name: e.name, type: "text", text: { content, format: 1 }, flags: rqidFlags(`jp.${jr.split(".").slice(2).join(".")}.page`) }],
    flags: merge(rqidFlags(jr), sourceFlags(book, e), { [MODULE_ID]: { folder: kindLabel } }),
  };
}

export function buildChapterJournal(book, e) {
  const pages = (e.data.sections || []).map((s, n) => ({
    name: s.name || `Section ${n + 1}`,
    type: "text",
    sort: (n + 1) * 1000,
    text: { content: s.html + (s.page ? `<p class="rqgi-source"><em>${escapeHtml(book.title)}, p.${s.page}</em></p>` : ""), format: 1 },
  }));
  return {
    name: e.name,
    pages,
    flags: merge(rqidFlags(journalRqid(book.key, "chapter", e.name)), sourceFlags(book, e), { [MODULE_ID]: { folder: KIND_INFO.chapter.label } }),
  };
}

/* ---------------------------------------------------------------- NPCs */

const CHAR_KEYS = { STR: "strength", CON: "constitution", SIZ: "size", DEX: "dexterity", INT: "intelligence", POW: "power", CHA: "charisma" };

const HUMANOID_LOCS = {
  "right leg": ["right-leg", "limb"],
  "left leg": ["left-leg", "limb"],
  abdomen: ["abdomen", "abdomen"],
  chest: ["chest", "chest"],
  "right arm": ["right-arm", "limb"],
  "left arm": ["left-arm", "limb"],
  head: ["head", "head"],
  hindquarters: ["hindquarter", "abdomen"],
  hindquarter: ["hindquarter", "abdomen"],
  forequarters: ["forequarter", "chest"],
  forequarter: ["forequarter", "chest"],
  "right hind leg": ["right-hind-leg", "limb"],
  "left hind leg": ["left-hind-leg", "limb"],
  "right fore leg": ["right-foreleg", "limb"],
  "left fore leg": ["left-foreleg", "limb"],
  "right foreleg": ["right-foreleg", "limb"],
  "left foreleg": ["left-foreleg", "limb"],
};

/** "Devotion (Orlanth) 80%, Honor 70%" -> [{name, spec, value}] */
export function parsePercentList(text) {
  const out = [];
  if (!text) return out;
  const re = /([A-Z][A-Za-z'’/\- ]*?(?:\s*\([^)]*\))?)\s+(\d{1,3})%/g;
  for (const m of String(text).matchAll(re)) {
    let name = cleanText(m[1]).replace(/^(and|or)\s+/i, "");
    // drop skill category headers like "Agility +5%:" captured by mistake
    if (/^(Agility|Communication|Knowledge|Magic|Manipulation|Perception|Stealth)$/i.test(name)) continue;
    name = name.replace(/^.*?(?:Agility|Communication|Knowledge|Magic|Manipulation|Perception|Stealth)\s*[+–-]\d+%\s*:?\s*/i, "");
    const spec = name.match(/^(.*?)\s*\((.*)\)$/);
    out.push({ name, base: spec ? spec[1].trim() : name, spec: spec ? spec[2].trim() : "", value: Number(m[2]) });
  }
  return out;
}

/** "Demoralize (2 pts.), Heal 2, Mobility (1 pt.)" -> [{name, points}] */
/** RuneQuest's common Rune spells, available to every initiate ("All common Rune spells"). */
export const COMMON_RUNE_SPELLS = [
  "Command Cult Spirit", "Dismiss Magic", "Divination", "Extension", "Find Enemy", "Heal Wound",
  "Multispell", "Sanctify", "Soul Sight", "Spirit Block", "Summon Cult Spirit", "Warding",
];

export function parseSpellList(text, { expandCommon = false } = {}) {
  if (!text) return [];
  let t = String(text).replace(/\.$/, "");
  if (/^none\b/i.test(t) || /not usable/i.test(t)) return [];
  const common = /^All common (knowledge )?Rune spells/i.test(t);
  t = t.replace(/^All common (knowledge )?Rune spells,?\s*(plus\s*)?/i, "");
  if (common && expandCommon) {
    const own = parseSpellList(t);
    return [...COMMON_RUNE_SPELLS.filter((c) => !own.some((o) => o.name === c)).map((name) => ({ name, points: null, common: true })), ...own];
  }
  // split on commas / "and" outside parentheses
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || (t.slice(i, i + 5) === " and " && i > 0))) {
      parts.push(cur);
      cur = "";
      if (ch !== ",") i += 4;
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts
    .map((s) => s.trim().replace(/^(and|plus)\s+/i, ""))
    .filter((s) => s && !/^(plus|all)$/i.test(s))
    .map((s) => {
      let points = null;
      let name = s;
      const m1 = name.match(/^(.*?)\s*\((\d+)(?:\s*[–-]\s*(\d+))?\+?\s*(?:pts?\.?|points?)?\)/i);
      const m2 = name.match(/^(.*?)\s+(\d+)(?:\s*[–-]\s*(\d+))?\+?(?:\s*\(.*\))?$/);
      if (m1) {
        name = m1[1];
        points = Number(m1[3] ?? m1[2]);
      } else if (m2) {
        name = m2[1];
        points = Number(m2[3] ?? m2[2]);
      }
      name = name.replace(/\s*\(.*\)\s*$/, "");
      return { name: cleanText(name), points };
    })
    .filter((x) => x.name && x.name.length < 40);
}

export function stripDamageBonus(damage, db) {
  const d = String(damage || "").replace(/\s+/g, "");
  const b = String(db || "").replace(/\s+/g, "");
  if (b && /^[+–-]/.test(b) && d.toUpperCase().endsWith(b.toUpperCase().replace("–", "-"))) return d.slice(0, d.length - b.length);
  return d;
}

/**
 * Plan an NPC actor. Returns actor data plus a list of "wanted" items to resolve against
 * compendiums in Foundry (weapons, spells, skills, runes); unresolved ones get built from the stat block.
 */
export function buildNpcPlan(book, e) {
  const d = e.data;
  const f = d.fields || {};
  const characteristics = {};
  for (const [abbr, key] of Object.entries(CHAR_KEYS)) {
    const v = d.characteristics?.[abbr];
    characteristics[key] = v == null ? { value: null, formula: "" } : { value: v, formula: String(v) };
  }
  const db = f["Damage Bonus"] || "";
  const notes = [];
  if (d.subtitle) notes.push(`<p><em>${escapeHtml(d.subtitle)}</em></p>`);
  for (const k of ["Cults", "Runes", "Rune Points", "Rune Spells", "Spirit Magic", "Sorcery Spells", "Sorcery Techniques Mastered", "Magic Points", "Armor", "Combat", "Magic Items", "Treasures", "Treasure", "Ransom", "Reputation", "Spirit Combat Damage", "Healing Rate", "Strike Rank"]) {
    if (f[k]) notes.push(`<p><strong>${escapeHtml(k)}:</strong> ${escapeHtml(f[k])}</p>`);
  }
  const otherFields = Object.entries(f).filter(([k]) => !/^(Hit Points|Move|DEX SR|SIZ SR|Base SR|Damage Bonus|Skills|Languages|Passions|Cults|Runes|Rune Points|Rune Spells|Spirit Magic|Sorcery Spells|Sorcery Techniques Mastered|Magic Points|Armor|Combat|Magic Items|Treasures|Treasure|Ransom|Reputation|Spirit Combat Damage|Healing Rate|Strike Rank)$/.test(k));
  for (const [k, v] of otherFields) notes.push(`<p><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</p>`);
  const biography =
    (e.html || "") +
    (notes.length ? `<h3>Stat block notes</h3>${notes.join("")}` : "") +
    `<p><em>Hit location armor from the stat block is stored as natural armor on each location.</em></p>` +
    sourceLine(book, e);

  // Hit locations
  const hitLocations = (d.hitLocations || []).map((h) => {
    const key = h.name.toLowerCase();
    const [slug, type] = HUMANOID_LOCS[key] || [slugify(h.name), /head/.test(key) ? "head" : /chest|fore/.test(key) ? "chest" : /abdomen|hind/.test(key) && !/leg/.test(key) ? "abdomen" : "limb"];
    return {
      name: h.name,
      type: "hitLocation",
      system: { dieFrom: h.from, dieTo: h.to, naturalAp: h.armor || 0, hitLocationType: type, baseHpDelta: 0, hitPoints: { value: h.hp, max: h.hp }, wounds: [] },
      flags: merge(rqidFlags(`i.hit-location.${slug}`, 0), { [MODULE_ID]: { targetHp: h.hp } }),
    };
  });

  // Wanted items, resolved against compendiums in Foundry
  const wanted = [];
  for (const a of d.attacks || []) {
    if (/^spirit combat$/i.test(a.name)) {
      wanted.push({ type: "skill", name: "Spirit Combat", base: "Spirit Combat", spec: "", chance: a.chance, category: "magic" });
      continue;
    }
    wanted.push({ type: "weapon", name: a.name.replace(/\s*\((1H|2H)\)\s*$/i, ""), hands: /\(2H\)/i.test(a.name) ? "twoHand" : null, chance: a.chance, damage: stripDamageBonus(a.damage, db), rawDamage: a.damage, sr: a.sr, hp: a.hp });
  }
  for (const s of parsePercentList(dehyphen(f.Skills || ""))) wanted.push({ type: "skill", name: s.name, base: s.base, spec: s.spec, chance: s.value });
  for (const s of parsePercentList(dehyphen(f.Languages || ""))) {
    const m = s.name.match(/^(Speak|Read\/Write)\s+(.*)$/i);
    const name = m ? `${m[1]} (${m[2].replace(/[()]/g, "")})` : s.name;
    wanted.push({ type: "skill", name, base: m ? m[1] : s.base, spec: m ? m[2].replace(/[()]/g, "") : s.spec, chance: s.value, category: /read/i.test(name) ? "knowledge" : "communication" });
  }
  for (const s of parsePercentList(dehyphen(f.Passions || ""))) wanted.push({ type: "passion", name: s.name, base: s.base, spec: s.spec, chance: s.value });
  for (const s of parsePercentList(dehyphen(f.Runes || ""))) {
    const rune = s.name.replace(/\s*\(.*\)$/, "").trim();
    wanted.push({ type: "rune", name: rune, chance: s.value, runeType: RUNE_TYPES[rune] ?? "form" });
  }
  for (const s of parseSpellList(f["Spirit Magic"] || "")) wanted.push({ type: "spiritMagic", name: s.name, points: s.points });
  for (const s of parseSpellList(f["Rune Spells"] || "", { expandCommon: true })) wanted.push({ type: "runeMagic", name: s.name, points: s.points });
  const rp = (f["Rune Points"] || "").match(/(\d+)\s*\(([^)]+)\)/);
  const rpNum = parseInt(f["Rune Points"], 10);
  const cultName = (f.Cults || f.Cult || "").split(/,|\band\b/)[0].replace(/[.;]\s*$/, "").trim();
  if (rp) wanted.push({ type: "cult", name: rp[2].trim(), runePoints: Number(rp[1]) });
  else if (cultName && !/^none/i.test(cultName)) wanted.push({ type: "cult", name: cultName, runePoints: Number.isFinite(rpNum) ? rpNum : 0 });

  const walk = parseInt(f.Move, 10);
  return {
    actor: {
      name: e.name,
      type: "character",
      system: {
        characteristics,
        background: { biography, species: /bison|llama|cat|baboon|horse|monkey/i.test(e.name) ? "Creature" : "Human" },
        attributes: Number.isFinite(walk) ? { move: { walk: { value: walk } } } : {},
      },
      prototypeToken: { name: d.shortName || e.name, actorLink: false },
      items: hitLocations,
      flags: merge(sourceFlags(book, e), { [MODULE_ID]: { npcKey: d.key, printedHp: parseInt(f["Hit Points"], 10) || null, damageBonus: db } }),
    },
    wanted,
  };
}

const OPPOSED_RUNES = {
  Fertility: "Death", Death: "Fertility", Harmony: "Disorder", Disorder: "Harmony", Truth: "Illusion", Illusion: "Truth",
  Stasis: "Movement", Movement: "Stasis", Man: "Beast", Beast: "Man",
};

/** Build a fallback embedded item when no compendium match exists. */
export function fallbackNpcItem(w) {
  switch (w.type) {
    case "weapon": {
      const natural = /^(bite|claw|kick|butt|gore|trample|hug|rip|crush|tail|sting|fist|grapple|head ?butt|rear and plunge)/i.test(w.name);
      const maneuver = natural
        ? [{ name: /bite/i.test(w.name) ? "Bite" : /claw|rip/i.test(w.name) ? "Claw" : /kick/i.test(w.name) ? "Kick" : /trample/i.test(w.name) ? "Trample" : /gore|butt/i.test(w.name) ? "Gore" : "Hit", damageType: /bite|claw|rip|gore/i.test(w.name) ? "slash" : "crush", description: "" }]
        : [{ name: "Hit", damageType: "crush", description: "" }];
      const u = { skillRqidLink: { rqid: `i.skill.${slugify(w.name)}`, name: w.name }, combatManeuvers: maneuver, damage: w.damage.replace(/\s*to downed foe/i, ""), minStrength: 0, minDexterity: 0, strikeRank: null };
      return {
        name: w.name,
        type: "weapon",
        system: {
          description: w.rawDamage && w.rawDamage !== w.damage ? `<p>Printed damage: ${escapeHtml(w.rawDamage)}</p>` : "",
          usage: { oneHand: u, offHand: emptyUsage(), twoHand: emptyUsage(), missile: emptyUsage() },
          defaultUsage: "oneHand",
          isNatural: natural,
          hitPoints: natural ? { value: null, max: null } : { value: w.hp || 0, max: w.hp || 0 },
          equippedStatus: "equipped",
          encumbrance: natural ? 0 : 1,
        },
        flags: rqidFlags(`i.weapon.${slugify(w.name)}`, 0),
      };
    }
    case "skill": {
      const cat = w.category || (w.weaponSkill ? "meleeWeapons" : skillCategory(w.base || w.name));
      return {
        name: w.name,
        type: "skill",
        system: { category: cat, skillName: w.base || w.name, specialization: w.spec || "", baseChance: 0, gainedChance: w.chance || 0, runeRqidLinks: [] },
        flags: rqidFlags(`i.skill.${slugify(w.name)}`, 0),
      };
    }
    case "passion":
      return {
        name: w.name,
        type: "passion",
        system: { passion: w.base, subject: w.spec || "", chance: w.chance || 0, description: "" },
        flags: rqidFlags(`i.passion.${slugify(w.name)}`, 0),
      };
    case "cult":
      return {
        name: w.name,
        type: "cult",
        system: { deity: w.name, runePoints: { value: w.runePoints || 0, max: w.runePoints || 0 }, joinedCults: [{ cultName: w.name, tagline: "", rank: "initiate" }], runeRqidLinks: [], commonRuneMagicRqidLinks: [] },
        flags: rqidFlags(`i.cult.${slugify(w.name)}`, 0),
      };
    case "spiritMagic":
      return { name: w.name, type: "spiritMagic", system: { points: w.points || 1, isVariable: false }, flags: rqidFlags(`i.spirit-magic.${slugify(w.name)}`, 0) };
    case "runeMagic":
      return { name: w.name, type: "runeMagic", system: { points: w.points || 1 }, flags: rqidFlags(`i.rune-magic.${slugify(w.name)}`, 0) };
    case "rune": {
      const type = w.runeType || "form";
      const opp = OPPOSED_RUNES[w.name];
      const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
      return {
        name: `${w.name} (${typeLabel})`,
        type: "rune",
        system: {
          rune: w.name,
          runeType: type,
          chance: w.chance || 0,
          opposingRuneRqidLink: opp ? { rqid: `i.rune.${slugify(opp)}-${RUNE_TYPES[opp] ?? type}`, name: opp } : null,
          minorRuneRqidLinks: [],
          isMastered: false,
        },
        flags: rqidFlags(`i.rune.${slugify(w.name)}-${type}`, 0),
      };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------- dispatch */

export function buildItem(book, e) {
  switch (e.kind) {
    case "weapon":
      return buildWeapon(book, e);
    case "armor":
      return buildArmor(book, e);
    case "gear":
      return buildGear(book, e);
    case "spiritMagic":
    case "runeMagic":
      return buildSpell(book, e);
    case "skill":
      return buildSkill(book, e);
    case "cult":
      return buildCult(book, e);
    default:
      return null;
  }
}

/** Entities that also get a description journal (system types without a description field). */
export function needsJournal(e) {
  return ["spiritMagic", "runeMagic", "sorcery", "cult"].includes(e.kind) || (e.kind === "skill" && !!e.html);
}
