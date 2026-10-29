import { describe, expect, it } from "vitest";
import { fixCommandsBeforeApproval } from "../domain/servers/fixGate";
import { eventsOf, state } from "./store";

// Anti-obiettivo 2 (area 8b), come architettura: un comando di correzione
// (`tool: "server.fix"`) lo scrivono SOLO la correzione dei server
// (`data/servers/`) e le sue regole pure (`domain/servers/`). Nessun altro
// percorso — «Avvia», automazioni, «Fai sistemare a Claude», conversazione
// libera, l'analisi — può nominarlo, quindi nemmeno produrlo.
//
// Che nessun comando preceda un piano approvato da una persona lo verifica
// `data/servers/fix.test.ts` dopo OGNI suo scenario, su ogni sessione dello
// store; qui sul seme.

const SOURCES = import.meta.glob(["../**/*.{ts,tsx}", "!**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("comandi di correzione dei server", () => {
  it("trova i sorgenti", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it('"server.fix" compare solo in data/servers/ e domain/servers/', () => {
    // Vite scrive i file di `data/` come `./…`: tutti relativi a `src/renderer`.
    const where = Object.entries(SOURCES)
      .filter(([, source]) => source.includes("server.fix"))
      .map(([path]) => (path.startsWith("./") ? `../data/${path.slice(2)}` : path));
    expect(where.length).toBeGreaterThan(0);
    expect(
      where.filter((p) => !p.startsWith("../data/servers/") && !p.startsWith("../domain/servers/")),
    ).toEqual([]);
  });

  it("nel seme nessun comando di correzione precede un piano approvato", () => {
    for (const c of state.conversations)
      expect(fixCommandsBeforeApproval(eventsOf(c.id)), c.id).toBe(0);
  });
});
