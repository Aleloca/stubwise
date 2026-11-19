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
  it("ogni voce che il server propone c'è nel prototipo, tranne le due che lì passano da un'altra strada", () => {
    // `pageAction` (le azioni della pagina, D3: le esegue il renderer) e
    // `fillMailBody` (il corpo della bozza Gmail): nel prototipo non sono del
    // catalogo, le fa la pagina o la Posta.
    expect(CLAUDE_PROPOSABLE_FNS.filter((fn) => !isCatalogFn(fn)).sort()).toEqual(
      ["fillMailBody", "pageAction"].sort(),
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
