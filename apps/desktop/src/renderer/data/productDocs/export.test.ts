import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productDocs, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { resetViewerGrants, revokeProjectPermission } from "../viewer";

// La lettura dell'esportazione (area 11a, Task 12, ruling P20): pagine e
// profondità nell'ordine dell'albero, coi file del Drive e le decisioni già
// risolti per chi esporta. Nascosto e inesistente identici (R-G5): un file
// o una decisione che chi esporta non vede è `null`, senza nome né titolo.

const LAURA = "p-laura";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const ACQ = "prj-acq";
const MKX = "prj-mkx";
const AUD = "prj-aud";

const as = (personId: string) => setSessionPersonId(personId);
const pageOf = (title: string) => state.productPages.find((p) => p.projectId === ACQ && p.title === title)!;

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => {
  resetViewerGrants();
  resetApi();
});

describe("getProductExport", () => {
  it("Laura, tutto lo spazio di ACQ: le 9 pagine nell'ordine dell'albero, con la profondità", async () => {
    as(LAURA);
    const read = (await productDocs.getProductExport(ACQ))!;
    expect(read.projectCode).toBe("ACQ");
    expect(read.pages.map((p) => [p.page.title, p.depth])).toEqual([
      ["Overview", 0],
      ["Features", 0],
      ["Sign-in", 1],
      ["Bills", 1],
      ["Meter reading", 1],
      ["Fault reports", 1],
      ["Screens", 0],
      ["Client decisions", 0],
      ["Phases", 0],
    ]);
    expect(read.files).toEqual({ "drv-acq-1": { name: "Client brief.pdf" } });
    // dl-acq-3 l'ha portata Claude in Client decisions (seme 11b).
    expect(Object.keys(read.decisions).sort()).toEqual(["dl-acq-1", "dl-acq-2", "dl-acq-3"]);
    expect(read.decisions["dl-acq-1"]?.title).toBe(state.decisionLog.find((d) => d.id === "dl-acq-1")!.title);
  });

  it("una pagina sola: la pagina a profondità 0; un id d'un altro progetto o inventato è null", async () => {
    as(LAURA);
    const signIn = pageOf("Sign-in");
    const read = (await productDocs.getProductExport(ACQ, { pageId: signIn.id }))!;
    expect(read.pages.map((p) => [p.page.code, p.depth])).toEqual([[signIn.code, 0]]);
    expect(read.files).toEqual({});
    expect(await productDocs.getProductExport(ACQ, { pageId: "pp-nope" })).toBeNull();
    expect(await productDocs.getProductExport(AUD, { pageId: signIn.id })).toBeNull();
  });

  it("Sara: il file nascosto e la decisione di AUD sono null, e nessun loro nome o titolo esce (R-G5)", async () => {
    state.driveFiles.find((f) => f.id === "drv-acq-1")!.hidden = true;
    const decisions = pageOf("Client decisions");
    decisions.blocks = [...decisions.blocks, { id: "blk-aud-decision", type: "decision", decisionId: "dl-aud-1" }];
    as(SARA);
    const read = (await productDocs.getProductExport(ACQ))!;
    expect(read.files).toEqual({ "drv-acq-1": null });
    expect(read.decisions["dl-aud-1"]).toBeNull();
    const text = JSON.stringify(read).toLowerCase();
    // Il nome del file (la prosa di Overview dice «the client brief»: è testo della pagina).
    expect(text).not.toContain("client brief.pdf");
    const audTitle = state.decisionLog.find((d) => d.id === "dl-aud-1")!.title.toLowerCase();
    expect(text).not.toContain(audTitle);
    const aud8 = state.tasks.find((t) => t.code === "AUD-8")!.title.toLowerCase();
    expect(text).not.toContain(aud8);
  });

  it("Laura (gestisce il Drive) non esporta il nome di un file nascosto: come nella pagina", async () => {
    state.driveFiles.find((f) => f.id === "drv-acq-1")!.hidden = true;
    as(LAURA);
    const read = (await productDocs.getProductExport(ACQ))!;
    expect(read.files).toEqual({ "drv-acq-1": null });
  });

  it("modulo spento o progetto invisibile: null; visibile senza docs.view: forbidden", async () => {
    as(GIULIA);
    expect(await productDocs.getProductExport(MKX)).toBeNull();
    as(SARA);
    expect(await productDocs.getProductExport(AUD)).toBeNull();
    revokeProjectPermission(SARA, ACQ, "docs.view" as never);
    await expect(productDocs.getProductExport(ACQ)).rejects.toThrow("forbidden");
  });
});
