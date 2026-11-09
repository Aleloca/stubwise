import { beforeEach, describe, expect, it } from "vitest";
import { drive, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";

// La ricerca nei file del Drive (Task 8, shape drive-search.md): nome e
// contenuto, il passaggio trovato, l'ordine, i file Google fuori dai
// progetti in coda. Review Focus 1: un file che chi cerca non vede (progetto
// invisibile, nascosto) è un file che non c'è; uno non disponibile o non
// pronto si trova solo per nome. Cercare non conta un'apertura.

const as = (personId: string) => setSessionPersonId(personId);
const codes = async (q: string, scope = {}) =>
  (await drive.searchDrive(q, scope)).files.map((h) => h.file.code);

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-laura");
});

describe("searchDrive", () => {
  it("trova per contenuto, col passaggio che contiene la parola e il riassunto", async () => {
    const { files } = await drive.searchDrive("penalty");
    expect(files[0]!.file.code).toBe("AUD-F7");
    expect(files[0]!.passage).toMatch(/penalty/);
    expect(files[0]!.passage!.length).toBeLessThanOrEqual(182);
    expect(files[0]!.file.summary).toBeTruthy();
    expect(files[0]!.file.opens90d).toBe(23);
  });

  it("senza maiuscole né accenti, tutte le parole; sotto i 2 caratteri niente", async () => {
    expect(await codes("PENALTY week")).toContain("AUD-F7");
    expect(await codes("penalty zzqx")).not.toContain("AUD-F7");
    expect(await codes("p")).toEqual([]);
  });

  it("per nome: il passaggio è null («Matched the name»)", async () => {
    const hit = (await drive.searchDrive("Contratto quadro")).files.find(
      (h) => h.file.code === "AUD-F7",
    );
    expect(hit?.passage).toBeNull();
  });

  it("un codice esatto porta quel file in testa", async () => {
    expect((await codes("aud-f2"))[0]).toBe("AUD-F2");
  });

  it("Review Focus 1: un progetto invisibile è identico a un codice inesistente", async () => {
    as("p-sara"); // non vede AUD
    expect(await codes("penalty")).not.toContain("AUD-F7");
    expect(await drive.searchDrive("AUD-F7")).toEqual(await drive.searchDrive("AUD-F999"));
    expect((await drive.searchDrive("AUD-F7")).files).toEqual([]);
  });

  it("Review Focus 1: un nascosto non si trova, neanche da chi gestisce", async () => {
    expect(await codes("replaced by the final")).not.toContain("AUD-F8");
    expect(await codes("bozza superata")).not.toContain("AUD-F8");
    expect(await codes("AUD-F8")).toEqual([]);
  });

  it("Review Focus 1: non disponibile o non pronto si trova solo per nome", async () => {
    // AUD-F11 cancellato su Google, AUD-F15 accesso perso: il testo non c'è più.
    expect(await codes("contacts sync")).not.toContain("AUD-F11");
    expect(await codes("partner price")).not.toContain("AUD-F15");
    const byName = (await drive.searchDrive("Requisiti integrazione")).files;
    expect(byName.map((h) => h.file.code)).toContain("AUD-F11");
    expect(byName.find((h) => h.file.code === "AUD-F11")!.passage).toBeNull();
    // AUD-F14 è ancora in lettura: il nome sì.
    expect(await codes("Calendario consegne")).toContain("AUD-F14");
  });

  it("a parità di pertinenza pesano le aperture degli ultimi 90 giorni", async () => {
    // Tre mockup trovati solo per nome: stesso punteggio.
    const before = await codes("mockup", { projectId: "prj-aud" });
    expect(before.indexOf("AUD-F3")).toBeLessThan(before.indexOf("AUD-F12"));
    for (let i = 0; i < 9; i++) {
      state.driveOpens.push({
        fileId: "drv-aud-12",
        personId: "p-marco",
        at: `2026-10-${String(10 + i).padStart(2, "0")}T09:00:00Z`,
        via: "preview",
      });
    }
    const after = await codes("mockup", { projectId: "prj-aud" });
    expect(after.indexOf("AUD-F12")).toBeLessThan(after.indexOf("AUD-F3"));
  });

  it("cercare (e mostrare il riassunto) non conta un'apertura", async () => {
    const before = state.driveOpens.length;
    await drive.searchDrive("penalty");
    await drive.searchDrive("Contratto");
    expect(state.driveOpens.length).toBe(before);
  });

  it("i filtri restano: progetto e tipo", async () => {
    const pdfs = (await drive.searchDrive("audin", { type: "pdf" })).files;
    expect(pdfs.length).toBeGreaterThan(0);
    expect(pdfs.every((h) => h.file.type === "pdf")).toBe(true);
    const mkx = (await drive.searchDrive("audin", { projectId: "prj-mkx" })).files;
    expect(mkx.every((h) => h.file.projectId === "prj-mkx")).toBe(true);
  });

  it("i file Google fuori dai progetti: solo con l'account collegato, in un gruppo a parte", async () => {
    as("p-giulia");
    const { outside } = await drive.searchDrive("wine club");
    expect(outside.map((o) => o.name)).toContain("Offerta Cantina Bellavista – bozza");
    const offer = outside.find((o) => o.name.startsWith("Offerta"))!;
    expect(offer.passage).toMatch(/wine club/);
    expect(offer.owner).toBeTruthy();
    // Caricati e «aggiunto da» non riguardano un file che non è in un progetto.
    expect((await drive.searchDrive("wine club", { source: "upload" })).outside).toEqual([]);
    as("p-laura"); // scaduto
    expect((await drive.searchDrive("wine club")).outside).toEqual([]);
    as("p-marco"); // nessun account
    expect((await drive.searchDrive("wine club")).outside).toEqual([]);
  });
});
