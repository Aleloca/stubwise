import { beforeEach, describe, expect, it } from "vitest";
import { docs, productDocs, resetApi, setLatency } from "./api";
import { PRODUCT_SCRIPTS } from "./seed/productDocs/presence";
import { PRODUCT_FOLLOWS, PRODUCT_REVISIONS } from "./seed/productDocs";
import { setSessionPersonId } from "./session";
import { nextSeq, state, visibleProjectIds } from "./store";
import type { InlineMark, ProductBlock, ProductPage, RichText } from "./types";
import { can, viewerFor, type Permission } from "./viewer";

// Il seme del 11a (area 11a, Task 3): lo spazio Prodotto di ACQ, il progetto
// VRD senza repository, il file del Drive e le due decisioni di ACQ.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const MATTEO = "p-matteo";
const ACQ = "prj-acq";
const VRD = "prj-vrd";

const holds = (personId: string, perm: string, projectId: string) =>
  can(viewerFor(personId), perm as Permission, projectId);

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const acqPages = (): ProductPage[] => state.productPages.filter((p) => p.projectId === ACQ);
const byTitle = (title: string): ProductPage => acqPages().find((p) => p.title === title)!;

/** Ogni id di blocco, di riga e di cella di un blocco. */
const idsOf = (b: ProductBlock): string[] =>
  b.type === "table"
    ? [b.id, ...b.rows.flatMap((r) => [r.id, ...r.cells.map((c) => c.id)])]
    : [b.id];

const richOf = (b: ProductBlock): RichText[] =>
  b.type === "table"
    ? b.rows.flatMap((r) => r.cells.map((c) => c.content))
    : "content" in b
      ? [b.content]
      : [];

describe("lo spazio Prodotto di ACQ", () => {
  it("ha nove pagine: Features con quattro figlie, il resto alla radice", () => {
    const pages = acqPages();
    expect(pages.map((p) => p.title)).toEqual([
      "Overview",
      "Features",
      "Sign-in",
      "Bills",
      "Meter reading",
      "Fault reports",
      "Screens",
      "Client decisions",
      "Phases",
    ]);
    const features = byTitle("Features");
    expect(
      pages
        .filter((p) => p.parentId === features.id)
        .sort((a, b) => a.order - b.order)
        .map((p) => p.title),
    ).toEqual(["Sign-in", "Bills", "Meter reading", "Fault reports"]);
    expect(pages.filter((p) => p.parentId === null).map((p) => p.title)).toEqual([
      "Overview",
      "Features",
      "Screens",
      "Client decisions",
      "Phases",
    ]);
  });

  it("ogni pagina ha una revisione `create`, e nessuna revisione ha via, source, undoOf o groupId", () => {
    for (const page of acqPages()) {
      expect(
        state.productRevisions.filter((r) => r.pageId === page.id && r.kind === "create"),
        page.title,
      ).toHaveLength(1);
    }
    for (const r of PRODUCT_REVISIONS) {
      expect(r.via).toBeUndefined();
      expect(r.source).toBeUndefined();
      expect(r.undoOf).toBeUndefined();
      expect(r.groupId).toBeUndefined();
    }
  });

  it("le modifiche sono di Laura, Marco e Matteo, e i `seq` sono distinti e crescono con la data", () => {
    const edits = PRODUCT_REVISIONS.filter((r) => r.kind === "edit");
    expect(new Set(edits.map((r) => r.actorId))).toEqual(new Set([LAURA, MARCO, MATTEO]));
    const seqs = PRODUCT_REVISIONS.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    const byTime = [...PRODUCT_REVISIONS].sort((a, b) => a.at.localeCompare(b.at));
    expect(byTime.map((r) => r.seq)).toEqual([...seqs].sort((a, b) => a - b));
    for (const r of PRODUCT_REVISIONS) expect(r.lastSeq).toBe(r.seq);
  });

  it("ogni cambio dell'ultima revisione di una pagina riporta lo stato di adesso", () => {
    for (const page of acqPages()) {
      const rows = PRODUCT_REVISIONS.filter((r) => r.pageId === page.id && r.kind === "edit");
      for (const r of rows)
        for (const c of r.changes) {
          const now = page.blocks.find((b) => b.id === c.blockId) ?? null;
          expect(c.after, `${page.title} ${c.blockId}`).toEqual(now);
        }
    }
  });

  it("Laura segue le pagine create da lei, e Marco Sign-in", () => {
    const followers = (title: string) =>
      PRODUCT_FOLLOWS.filter((f) => f.pageId === byTitle(title).id).map((f) => f.personId);
    for (const page of acqPages().filter((p) => p.createdById === LAURA))
      expect(followers(page.title), page.title).toContain(LAURA);
    expect(followers("Sign-in")).toContain(MARCO);
    expect(followers("Bills")).not.toContain(MARCO);
  });
});

describe("i blocchi del seme", () => {
  it("gli id di blocco, riga e cella sono tutti diversi e tutti in `productBlockIds`", () => {
    const all = acqPages().flatMap((p) => p.blocks.flatMap(idsOf));
    expect(all.length).toBeGreaterThan(40);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(state.productBlockIds.has(id), id).toBe(true);
  });

  it("nessun blocco ha testo Markdown", () => {
    for (const page of acqPages())
      for (const block of page.blocks)
        for (const rt of richOf(block)) {
          expect(rt.text, page.title).not.toMatch(/^#|\*\*|^- /);
        }
  });

  it("ogni segno passa la validazione di `writeProductBlocksAs`, e ogni link è https", () => {
    const marks: InlineMark[] = acqPages().flatMap((p) =>
      p.blocks.flatMap((b) => richOf(b).flatMap((rt) => rt.marks)),
    );
    expect(marks.some((m) => m.type === "bold")).toBe(true);
    expect(marks.some((m) => m.type === "italic")).toBe(true);
    for (const m of marks) if (m.type === "link") expect(m.href.startsWith("https:")).toBe(true);

    // Si riscrive ogni blocco, con id nuovi, in una pagina nuova: se un segno
    // non passasse, la scrittura lancerebbe `invalid: marks`.
    const copyBlock = (b: ProductBlock, n: string): ProductBlock =>
      b.type === "table"
        ? {
            ...b,
            id: `${n}${b.id}`,
            rows: b.rows.map((r) => ({
              id: `${n}${r.id}`,
              cells: r.cells.map((c) => ({ ...c, id: `${n}${c.id}` })),
            })),
          }
        : { ...b, id: `${n}${b.id}` };
    for (const page of acqPages()) {
      const scratch = productDocs.createProductPageAs(LAURA, ACQ, { title: `copy ${page.title}` });
      let after: string | null = scratch.blocks[0]!.id;
      page.blocks.forEach((b, i) => {
        const block = copyBlock(b, `x${i}-${page.id}-`);
        expect(() =>
          productDocs.writeProductBlocksAs(
            LAURA,
            scratch.id,
            [{ op: "insert", afterId: after, block }],
            {},
          ),
        ).not.toThrow();
        after = block.id;
      });
    }
  });

  it("le immagini di Screens sono PNG in `data:` e hanno la didascalia", () => {
    const images = byTitle("Screens").blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    for (const img of images) {
      if (img.type !== "image") continue;
      expect(img.src.startsWith("data:image/png")).toBe(true);
      expect(img.caption.length).toBeGreaterThan(0);
      expect(img.alt.length).toBeGreaterThan(0);
    }
  });

  it("Meter reading ha «Rules» (H2) con la sua frase, «Edge cases» (H3) e una tabella", () => {
    const blocks = byTitle("Meter reading").blocks;
    const rules = blocks.find((b) => b.type === "heading" && b.content.text === "Rules");
    const edge = blocks.find((b) => b.type === "heading" && b.content.text === "Edge cases");
    expect(rules && rules.type === "heading" && rules.level).toBe(2);
    expect(edge && edge.type === "heading" && edge.level).toBe(3);
    expect(
      blocks.some(
        (b) => "content" in b && b.content.text === "Readings close on the 25th of each month.",
      ),
    ).toBe(true);
    expect(blocks.some((b) => b.type === "table")).toBe(true);
  });

  it("Phases ha una lista di controllo, Client decisions tre blocchi decisione di ACQ", () => {
    expect(byTitle("Phases").blocks.filter((b) => b.type === "todo").length).toBeGreaterThan(2);
    const decisions = byTitle("Client decisions").blocks.filter((b) => b.type === "decision");
    // Due del 11a, la terza l'ha portata Claude dal registro (seme 11b).
    expect(decisions).toHaveLength(3);
    for (const d of decisions) {
      if (d.type !== "decision") continue;
      expect(state.decisionLog.find((e) => e.id === d.decisionId)?.projectId).toBe(ACQ);
    }
  });
});

describe("codici e Drive", () => {
  it("Overview ha il blocco Drive su ACQ-F1 (Laura e Sara lo vedono) e un codice di richiesta di ACQ", () => {
    const overview = byTitle("Overview");
    const drive = overview.blocks.find((b) => b.type === "drive");
    expect(drive && drive.type === "drive" && drive.code).toBe("ACQ-F1");
    const file = state.driveFiles.find((f) => f.code === "ACQ-F1")!;
    expect(file.projectId).toBe(ACQ);
    expect(file.name).toBe("Client brief.pdf");
    expect(file.addedById).toBe(LAURA);
    expect(drive && drive.type === "drive" && drive.fileId).toBe(file.id);
    for (const p of [LAURA, SARA]) expect(visibleProjectIds(p).has(file.projectId)).toBe(true);
    const text = overview.blocks
      .flatMap((b) => richOf(b))
      .map((r) => r.text)
      .join("\n");
    expect(text).toMatch(/\bACQ-R\d+\b/);
    expect(state.requests.some((r) => r.code === text.match(/\bACQ-R\d+\b/)![0])).toBe(true);
  });

  it("Overview ha una frase con grassetto, corsivo e un link https", () => {
    const rich = byTitle("Overview").blocks.flatMap((b) => richOf(b));
    expect(
      rich.some(
        (r) =>
          r.marks.some((m) => m.type === "bold") &&
          r.marks.some((m) => m.type === "italic") &&
          r.marks.some((m) => m.type === "link"),
      ),
    ).toBe(true);
  });

  it("Bills cita una task di ACQ e un codice di un progetto che Sara non vede (AUD)", () => {
    const text = byTitle("Bills")
      .blocks.flatMap((b) => richOf(b))
      .map((r) => r.text)
      .join("\n");
    const codes = text.match(/\b[A-Z]{3}-\d+\b/g) ?? [];
    const acq = codes.find((c) => c.startsWith("ACQ-"))!;
    const hidden = codes.find((c) => c.startsWith("AUD-"))!;
    expect(state.tasks.some((t) => t.code === acq)).toBe(true);
    const task = state.tasks.find((t) => t.code === hidden)!;
    expect(task).toBeDefined();
    expect(visibleProjectIds(SARA).has(task.projectId)).toBe(false);
    for (const p of [LAURA, MARCO]) expect(visibleProjectIds(p).has(task.projectId)).toBe(true);
  });

  it("i codici di prodotto seguono l'ultimo ACQ-D dei Docs e non ne riusano nessuno", () => {
    const docNumbers = state.docPages
      .filter((p) => p.projectId === ACQ)
      .map((p) => Number(p.code.split("-D")[1]));
    expect(docNumbers.length).toBeGreaterThan(0);
    const last = Math.max(...docNumbers);
    const productNumbers = acqPages().map((p) => Number(p.code.split("-D")[1]));
    expect(productNumbers).toEqual(acqPages().map((_, i) => last + 1 + i));
    const docCodes = new Set(state.docPages.map((p) => p.code));
    for (const p of acqPages()) expect(docCodes.has(p.code)).toBe(false);
  });

  it("la prima pagina nuova (di prodotto o manuale) non riprende un codice esistente (P3)", async () => {
    const used = new Set([
      ...state.docPages.map((p) => p.code),
      ...state.productPages.map((p) => p.code),
    ]);
    expect(used.size).toBe(state.docPages.length + state.productPages.length);
    setSessionPersonId(LAURA);
    const fresh = productDocs.createProductPageAs(LAURA, ACQ, { title: "New one" });
    expect(used.has(fresh.code)).toBe(false);
    used.add(fresh.code);
    const manual = await docs.createManualPage("repo-acq", { title: "Another", body: "x" });
    expect(used.has(manual.code)).toBe(false);
  });
});

describe("ACQ ha anche lo spazio Codice (P2)", () => {
  it("repo-acq ha uno spazio e due pagine manuali, ACQ-D1 e ACQ-D2", () => {
    expect(state.docSpaces.some((s) => s.repositoryId === "repo-acq")).toBe(true);
    expect(
      state.docPages.filter((p) => p.repositoryId === "repo-acq").map((p) => [p.code, p.kind]),
    ).toEqual([
      ["ACQ-D1", "manual"],
      ["ACQ-D2", "manual"],
    ]);
  });
});

describe("`seq` della sessione (P4)", () => {
  it("il primo `nextSeq()` viene dopo ogni `seq` del seme", () => {
    const max = Math.max(...PRODUCT_REVISIONS.map((r) => r.lastSeq));
    expect(nextSeq()).toBeGreaterThan(max);
  });
});

describe("le decisioni di ACQ", () => {
  it("sono tre, di ACQ, scritte a mano (la terza è del seme 11b)", () => {
    const rows = state.decisionLog.filter((d) => d.projectId === ACQ);
    expect(rows.map((d) => d.title).sort()).toEqual([
      "Fault photos up to 10 MB",
      "Readings close on the 25th",
      "Sign-in only with Google",
    ]);
    for (const d of rows) expect(d.source).toBe("manual");
  });
});

describe("VRD, il progetto nuovo", () => {
  it("è in fondo, senza repository, col modulo Docs e lo spazio Prodotto vuoto", () => {
    const project = state.projects.at(-1)!;
    expect(project.code).toBe("VRD");
    expect(project.name).toBe("App prenotazioni Palestra Verde Città");
    expect(project.clientName).toBe("Palestra Verde Città Srl");
    expect(project.template).toBe("client");
    expect(project.modules).toContain("docs");
    expect(state.repositories.filter((r) => r.projectId === VRD)).toHaveLength(0);
    expect(state.productPages.filter((p) => p.projectId === VRD)).toHaveLength(0);
  });

  it("Laura ha docs.edit, Sara solo docs.view", () => {
    expect(holds(LAURA, "docs.view", VRD)).toBe(true);
    expect(holds(LAURA, "docs.edit", VRD)).toBe(true);
    expect(holds(SARA, "docs.view", VRD)).toBe(true);
    expect(holds(SARA, "docs.edit", VRD)).toBe(false);
    expect(state.projectsById.get(VRD)!.memberIds).toEqual(
      expect.arrayContaining([LAURA, MARCO, SARA]),
    );
  });
});

describe("i permessi in ACQ", () => {
  it("Sara legge, Marco e Laura scrivono; Sara non vede AUD", () => {
    expect(holds(SARA, "docs.view", ACQ)).toBe(true);
    expect(holds(SARA, "docs.edit", ACQ)).toBe(false);
    expect(holds(MARCO, "docs.edit", ACQ)).toBe(true);
    expect(holds(LAURA, "docs.edit", ACQ)).toBe(true);
    expect(visibleProjectIds(SARA).has("prj-aud")).toBe(false);
  });
});

describe("il copione della pagina Meter reading", () => {
  it("Marco entra in «Rules», scrive in 8 pezzi, se ne va; Matteo c'è e non scrive", () => {
    const page = byTitle("Meter reading");
    const steps = PRODUCT_SCRIPTS[page.id]!;
    expect(steps).toBeDefined();
    const rules = page.blocks.find((b) => b.type === "heading" && b.content.text === "Rules")!;
    const marco = steps.filter((s) => s.personId === MARCO);
    expect(marco[0]).toMatchObject({ step: "enter", anchorId: rules.id });
    const insert = marco.find((s) => s.step === "insert")!;
    expect(insert.step === "insert" && page.blocks.some((b) => b.id === insert.afterId)).toBe(true);
    const typed = marco.filter((s) => s.step === "type");
    expect(typed).toHaveLength(8);
    expect(typed.map((s) => (s.step === "type" ? s.text : "")).join("")).toBe(
      "Readings sent after the 25th count for the next bill.",
    );
    expect(marco.at(-1)).toMatchObject({ step: "leave" });
    const matteo = steps.filter((s) => s.personId === MATTEO);
    expect(matteo).toEqual([{ step: "enter", personId: MATTEO, anchorId: null }]);
  });

  it("l'id del blocco che il copione inserisce NON è fra quelli dati", () => {
    const page = byTitle("Meter reading");
    const insert = PRODUCT_SCRIPTS[page.id]!.find((s) => s.step === "insert")!;
    if (insert.step !== "insert") throw new Error("no insert");
    expect(state.productBlockIds.has(insert.blockId)).toBe(false);
    expect(page.blocks.some((b) => b.id === insert.blockId)).toBe(false);
  });
});
