import { CLAUDE_INSTANCE_PERMISSION, CLAUDE_PROPOSABLE_FNS } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { actionById } from "../../domain/access/actions";
import { CLAUDE_CATALOG, isCatalogFn } from "./catalog";

// F7 (72, Task 6): il catalogo del prototipo e quello del server dicono le
// stesse cose sulle voci in comune. Il server è la verità di ciò che Claude
// può proporre (`CLAUDE_PROPOSABLE_FNS`) e del permesso d'istanza di una voce
// (`CLAUDE_INSTANCE_PERMISSION`, la stessa mappa che toglie al modello le voci
// che chi chiede non può proporre). Il prototipo ha anche voci che il server
// non ha ancora (aree 10 e 11), e tre dell'area 9 che il server non esegue
// (registro dei rimandi: `setAttachments`, `setDefaultReviewer`; e
// `saveStorage`, dalla review di F7: endpoint e bucket decidono dove vanno gli
// allegati, come l'URL di un webhook).

describe("il catalogo di Claude: prototipo e server", () => {
  it("ogni voce che il server propone c'è nel prototipo, tranne le tre che lì passano da un'altra strada", () => {
    // `pageAction` (le azioni della pagina, D3: le esegue il renderer),
    // `fillMailBody` (il corpo della bozza Gmail) e, dall'area 10 F6,
    // `fillField` (la bozza nel campo: nel prototipo è l'evento `draft`): nel
    // prototipo non sono del catalogo, le fa la pagina o la Posta.
    expect(CLAUDE_PROPOSABLE_FNS.filter((fn) => !isCatalogFn(fn)).sort()).toEqual(
      ["fillField", "fillMailBody", "pageAction"].sort(),
    );
  });

  it("le tre voci dell'area 9 che il server non esegue sono solo del prototipo", () => {
    for (const fn of ["setAttachments", "setDefaultReviewer", "saveStorage"]) {
      expect(isCatalogFn(fn), fn).toBe(true);
      expect((CLAUDE_PROPOSABLE_FNS as readonly string[]).includes(fn), fn).toBe(false);
    }
  });

  it("il permesso d'istanza di una voce è quello del server («Who?» del prototipo)", () => {
    for (const [fn, permission] of Object.entries(CLAUDE_INSTANCE_PERMISSION)) {
      const entry = CLAUDE_CATALOG[fn as keyof typeof CLAUDE_CATALOG];
      expect(entry, fn).toBeDefined();
      const action = actionById(entry.whoAction!);
      expect(action?.scope, fn).toBe("instance");
      expect(action?.permission, fn).toBe(permission);
    }
  });
});

// Area 11, F6 (piano, «Per 94»): le sei voci della doc di prodotto che il
// server porta in F6, con le classi del prototipo e F6-1 = a («Write the
// first version» e «Draw this screen» chiedono conferma col motivo
// `startsWork`). Quando il server le aggiunge a `CLAUDE_PROPOSABLE_FNS`, il
// primo test qui sopra le trova già nel prototipo.
describe("il catalogo di Claude: le sei voci della doc di prodotto (F6)", () => {
  const SIX = [
    "writeFirstVersion",
    "undoFirstVersion",
    "updateProductPage",
    "undoProductUpdate",
    "drawWireframe",
    "deleteWireframe",
  ] as const;

  it("ci sono tutte nel prototipo, nessuna è di classe A dichiarata", () => {
    for (const fn of SIX) {
      expect(isCatalogFn(fn), fn).toBe(true);
      expect(CLAUDE_CATALOG[fn].baseClass, fn).not.toBe("A");
    }
  });

  it("F6-1 = a: la prima versione e il disegno partono solo alla conferma (`startsWork`)", () => {
    expect(SIX.filter((fn) => CLAUDE_CATALOG[fn].startsWork === true)).toEqual([
      "writeFirstVersion",
      "drawWireframe",
    ]);
  });
});
