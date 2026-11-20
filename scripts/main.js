/**
 * RQG Book Importer: imports items, spells, skills, cults, NPCs and adventure text from
 * RuneQuest: Roleplaying in Glorantha PDFs into compendiums (Book > Type > alphabetical).
 */
import { MODULE_ID } from "./core/builders.js";
import { buildDocument } from "./core/layout.js";
import { parseBook } from "./core/parsers.js";
import { readFileToModel, readPdf } from "./foundry/pdf-reader.js";
import { BookWriter } from "./foundry/writer.js";
import { RqgImporterApp } from "./foundry/importer-app.js";

let app = null;
function openImporter() {
  if (!game.user?.isGM) return ui.notifications.warn("The RQG Book Importer is for GMs.");
  app ??= new RqgImporterApp();
  app.render({ force: true });
  return app;
}

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "importer", {
    name: "RQG Book Importer",
    label: "Open importer",
    hint: "Import items, spells, skills, cults, NPCs and adventures from RuneQuest PDFs into compendiums.",
    icon: "fa-solid fa-book-open",
    type: RqgImporterApp,
    restricted: true,
  });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      open: openImporter,
      readFileToModel,
      readPdf,
      buildDocument,
      parseBook,
      /** Import a File (PDF or model JSON) without the window. */
      async importFile(file, { title, key, kinds, includeChapters = false, targets, overwrite = true } = {}) {
        const model = await readFileToModel(file);
        const ents = parseBook(buildDocument(model), { kinds, includeChapters });
        const bookTitle = title || model.title || file.name;
        return new BookWriter({ title: bookTitle, key: key || bookTitle }, { targets, overwrite }).write(ents);
      },
    };
  }
  if (game.system.id !== "rqg") ui.notifications.warn("RQG Book Importer needs the RuneQuest Glorantha (rqg) system.");
});

function addSidebarButton(html) {
  if (!game.user?.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".rqgi-sidebar-button")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rqgi-sidebar-button";
  btn.innerHTML = `<i class="fa-solid fa-book-open"></i> RQG Book Importer`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    openImporter();
  });
  const header = root.querySelector(".directory-header .header-actions") || root.querySelector(".header-actions") || root.querySelector(".directory-header") || root;
  header.append(btn);
}

Hooks.on("renderCompendiumDirectory", (_app, html) => addSidebarButton(html));
