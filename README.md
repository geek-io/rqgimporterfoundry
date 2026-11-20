# RQG Book Importer for Foundry VTT

A Foundry VTT v14 module for the *RuneQuest: Roleplaying in Glorantha* (rqg) system. It reads your RuneQuest PDFs and builds compendiums from them: weapons, armor, equipment, spirit magic, Rune magic, sorcery, skills, cults, NPCs and creatures, and whole chapters for adventures. Everything is organised **Book > Type > alphabetical name**.

- Module by: Geek IO Dev Team

[Official Geek IO Discord Link](https://www.geek-io.net/discord)  

All my work is always free, but a little bit of help is always appreciated!  
<a href="https://patreon.com/geekioshow"><img src="assets/Patreon-Logo.png" alt="All my work is always free, but a little bit of help is always appreciated" width="240"></a>

The module contains no book text. Content is read from the PDF you load, in your own Foundry.

## Installation

In Foundry VTT v14, go to **Add-on Modules → Install Module**, paste this manifest URL into **Manifest URL**, and click **Install**:

```
https://github.com/geek-io/rqgimporterfoundry/releases/latest/download/module.json
```

Foundry checks the same URL for updates. Enable **RQG Book Importer** in a RuneQuest Glorantha (rqg) world under **Manage Modules**, then open it from the **RQG Book Importer** button in the Compendium sidebar.

# v 0.1.4

- First public release. The module can now be installed and updated from its manifest URL (see Installation above).
- Added the MIT license and a notice for the bundled PDF.js.

# v 0.1.3

**Pregenerated character sheets.** Tested on the *A Darkness at Runegate* and *Stealing the Eye* pregens.

- **Character sheets are read.** None of the Darkness at Runegate characters came through, because the sheets are mostly tables and the importer took the table font for the body text. The body font is now worked out from running prose only. All four pregens of each adventure now import: Agata of the Ernaldori, Hross Oddbuy, Garan Greatsword and Jess Red-Hair; Ormarl Light-Fingers, Margarot Ernaldestdaughter, Vandarl Humaktson and Swen Heartpiercer.
- **Bold labels in more fonts.** Chaosium's newer PDFs name their fonts "-Bd" and "-It", which weren't recognised as bold or italic, so "Cults:", "Rune Spells:", "Skills:" and the other labels were missed. They are now read, including when they come after a heading such as *Gear, Treasure & Abilities*.
- **Runes from the Rune diagrams.** Sheets that show the Runes as the Elemental and Power & Form diagrams now give each character its Rune percentages, for example Agata's Earth 90%, Fertility 90% / Death 10% and Harmony 75% / Disorder 25%.
- **Rune items are always added.** When no compendium has the Rune, the NPC gets a Rune item built from the stat block (element, power or form, with its opposed Rune).
- **Spells on NPCs.** "All common Rune spells" now adds the twelve common Rune spells. Ranges such as "Heal 1–2" or "Reflection 1–3" are read; cult names lose trailing punctuation; "Command Cult Spirit" finds "Command (Cult Spirit)" in your compendiums.
- **Spell cards on sheets** (Invisibility on Ormarl's sheet) are imported, skipping the Rune icon between the name and the cost.
- **Sheet names.** When a sheet's stat block heading disagrees with the page banner (Jess Red-Hair's sheet in Darkness at Runegate says "Vandarl Humaktson"), the banner wins and the other name is kept in the biography.
- Characteristics marked with an asterisk ("10*") are read.

Core Rulebook and Starter Set results are unchanged.

# v 0.1.2

**Adventure books.** Tested on the *Starter Set Book 4: Adventures*, where the earlier version found no NPCs and the chapter text was a mess.

- **NPCs from adventure stat blocks.** Stat blocks laid out as a characteristics row over a value row, with an *Attacks* table and a combined *Hit Locations / Attributes* table (Hit Points, Move, Strike Rank, Rune Points, Magic Points), are now imported. All 19 in Book 4 come through with their attacks and hit locations, including the scorpion men, krarshtkid, rubble runners, newtlings and Cha'resk. Names set in small capitals are tidied ("Varina the Seamstress", not "Varina THe seaMsTress"), and the italic line under a name ("Initiate of Issaries. Male, 35…") goes into the biography.
- **NPC magic and cults.** Spirit magic written as "Demoralize (1)" and Rune spells such as "Crush 1+ (+10% to hit…)" are read correctly; *Cults* plus *Rune Points* gives the NPC its cult; Spirit Combat in an attack table becomes the skill rather than a weapon.
- **Headings keep their spaces.** pdf.js turned letter-spaced headings into "Get t ing the" or "GettingStarted". The importer now uses the PDF's real space characters, so chapters and pages read "A Rough Landing", "Opening Scene: At the Market", "Getting the Adventurers Together".
- **Chapter journals are formatted.** One page per main section with sub-headings inside. Bullet lists, read-aloud text and paragraphs that continue across columns are joined properly. Sidebars ("First Time Here?", "Strike Ranks") become boxed quotes placed after the paragraph they interrupt. Tables become real tables. Every stat block appears as a formatted block (characteristics, attacks, hit locations, then its fields) with a link to the imported actor. The table of contents is skipped.
- **Stat block fields stay separate** ("Rune Spells:", "Spirit Magic:", "Passions:" no longer run together), and the narrative after a stat block is no longer swallowed into its last field.
- **Layout fixes:** large bullet glyphs no longer merge the two columns of a page; words in a heading set in two sizes stay on one line; a table row set partly in another font is still read.

The Core Rulebook results are unchanged.

# v 0.1.1

- **The importer opens.** Clicking **RQG Book Importer** in the Compendium sidebar (or in Game Settings) failed with "Cannot set property state of #<ApplicationV2>" and no window appeared. Fixed.

# v 0.1.0

## The first importer

- **RQG Book Importer** window, opened from the **Compendium** sidebar button or **Game Settings → Configure Settings → RQG Book Importer** (GM only). Drop a PDF, set the book title and an optional page range, click **Analyse**, untick anything you don't want, then **Import**.
- **PDF reading in Foundry.** The module bundles pdf.js (Apache 2.0, in `lib/pdfjs`) and reads the text with its position and font, so two-column pages, tables, bold labels and headings are understood. A 450-page book takes about a minute. *Identify fonts* can be turned off for speed, but bold labels (gear entries, stat block fields) need it.
- **Book > Type > alphabetical name.** Each book gets a folder in the Compendium sidebar holding one compendium per type (Weapons, Armor, Equipment, Spirit Magic, Rune Magic, Skills, Cults, NPCs & Creatures) and one Journals compendium with a folder per type. Entries are sorted alphabetically. Under **Destination** you can instead send Items, Actors and Journals into existing compendiums, such as your compendium module; there the entries go into Book > Type folders.
- **Re-importing** the same book (same *book key*) replaces its earlier entries instead of duplicating them. Untick *Replace entries* to keep existing ones.

What it builds, as RQG system documents:

- **Weapons** from the melee, missile and shield tables: one item per weapon with every way it is used (Battle Axe has 1H and 2H use; Short Spear has 1H, 2H and thrown), skill links, damage, STR/DEX minimums, strike rank, HP, ENC, range and rate, and Cut/Thrust/Bash/Parry maneuvers from the damage type. The weapon descriptions and prices from the text are attached.
- **Armor** from the armor table: armor type and material, hit locations covered, absorbs, ENC, price and Move Quietly penalty, plus the description.
- **Equipment**: priced goods and services written as *Name: description. Price: x*, with their prices in lunars (clacks and wheels converted; ranges keep the low price and the high estimate).
- **Spirit magic and Rune magic** items with points, variable/stackable/one-use, range, duration, concentration, ritual/enchantment and resistance. Their full text goes into a description journal linked from the item.
- **Sorcery spells** as journals only, because the RQG system has no sorcery item yet.
- **Skills** with base chance and category, each with a description journal, plus the weapon skills implied by the weapon tables (1H Axe, Broadsword, Bow, Medium Shield and so on).
- **Cults** with deity, tagline, holy days, gifts and geases, and a journal with the full write-up (cult skills, spirit magic, Rune magic and enchantments listed at the top).
- **NPCs and creatures** from stat blocks: characteristics, hit locations (armor and HP set to the printed values), attacks as weapons, and skills, passions, spirit magic, Rune spells and the cult taken from the stat block. Items are copied from your compendiums when a match exists (this book first), otherwise built from the stat block. Skill percentages are set so the sheet shows the printed values. The biography holds the description and the remaining stat block fields.
- **Chapters & Adventures** (off by default): each chapter becomes a journal, one page per heading, for scenarios and adventure books.

Checked against the *RuneQuest Core Rulebook* PDF: 53 spirit magic spells, 166 Rune spells, 58 sorcery spells, 52 weapons and shields, 38 armor pieces, 110 goods and services, 104 skills, all 21 cults and all 11 stat blocks (the pregenerated adventurers and their mounts and companions), each with its attacks and hit locations.

Known limits in this version:

- Rune items on NPCs are added only when a compendium already has them (for example the system's content module); otherwise the Runes are listed in the biography.
- NPC armor is stored as natural armor on each hit location, so the printed totals match without separate armor items.
- Sidebars (such as *Vasana's Saga*) and decorative boxes are left out of descriptions. Tables inside spell or cult text are not reproduced.
- Rune magic items are not tied to specific Runes yet.
- On some books the large letter-spaced titles lose their spaces; NPCs then take the name from their stat block (for example *Vasana* instead of *Vasana Farnan's Daughter*).

For troubleshooting, **Parsed JSON** downloads what the analysis found, and `tools/pdf_to_model.py` can extract a PDF outside Foundry; the importer accepts the resulting JSON in place of the PDF.
