import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productDocs, resetApi, setLatency } from "../../data/api";
import type { ProductExportView } from "../../data/model";
import { PEOPLE } from "../../data/seed/people";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { exportModelOf, type ExportBlock, type ExportDoc, type ExportRun } from "./exportModel";

// Il modello dell'esportazione (area 11a, Task 12): puro. Legge ciò che il
// livello dati ha già risolto per chi esporta (`getProductExport`, P20) e le
// frasi composte dalla pagina (qui in inglese, come le compone `t`).

const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";

const pageOf = (title: string) => state.productPages.find((p) => p.projectId === ACQ && p.title === title)!;

function modelFor(read: ProductExportView, title = "ACQ Product"): ExportDoc {
  return exportModelOf(
    { title, pages: read.pages },
    {
      driveLine: (fileId, code) => {
        const file = read.files[fileId];
        return file ? `File: ${file.name} (${code})` : `File: ${code} (not available)`;
      },
      decisionLine: (id) => {
        const d = read.decisions[id];
        return d ? `Decision: ${d.title}` : "Decision: not available";
      },
    },
  );
}

const runsOf = (b: ExportBlock): ExportRun[] =>
  "runs" in b ? b.runs : b.kind === "table" ? b.rows.flat(2) : [];
const allRuns = (doc: ExportDoc) => doc.pages.flatMap((p) => p.blocks.flatMap(runsOf));
const lines = (doc: ExportDoc) =>
  doc.pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === "line" ? [b.line] : [])));
const text = (doc: ExportDoc) => JSON.stringify(doc).toLowerCase();

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("exportModelOf", () => {
  it("lo spazio di ACQ (Laura): 9 pagine nell'ordine dell'albero con la profondità, il Drive e le decisioni come righe", async () => {
    setSessionPersonId(LAURA);
    const doc = modelFor((await productDocs.getProductExport(ACQ))!);
    expect(doc.title).toBe("ACQ Product");
    expect(doc.pages.map((p) => [p.title, p.depth])).toEqual([
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
    expect(doc.pages[0]!.code).toBe(pageOf("Overview").code);
    // dl-acq-3 l'ha portata Claude in Client decisions (seme 11b).
    const ids = ["dl-acq-1", "dl-acq-2", "dl-acq-3"];
    const decisions = state.decisionLog.filter((d) => ids.includes(d.id));
    expect(lines(doc)).toEqual([
      "File: Client brief.pdf (ACQ-F1)",
      ...ids.map((id) => `Decision: ${decisions.find((d) => d.id === id)!.title}`),
    ]);
    // Le forme dei blocchi: tabella, immagini, voci, cose da fare, titoli.
    const meter = doc.pages.find((p) => p.title === "Meter reading")!;
    const table = meter.blocks.find((b) => b.kind === "table");
    expect(table?.kind === "table" && table.rows.map((r) => r.map((c) => c.map((x) => x.text).join("")))).toEqual([
      ["Meter", "Reading", "Closes"],
      ["Household", "Cubic metres", "The 25th"],
      ["Business", "Cubic metres", "The 25th"],
    ]);
    expect(meter.blocks.find((b) => b.kind === "heading")).toMatchObject({ kind: "heading", level: 2 });
    expect(meter.blocks.find((b) => b.kind === "list")).toMatchObject({ kind: "list", ordered: false, indent: 0 });
    const images = doc.pages.find((p) => p.title === "Screens")!.blocks.filter((b) => b.kind === "image");
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ caption: "Sign-in screen: one button, Continue with Google." });
    expect(images[0]!.kind === "image" && images[0]!.src.startsWith("data:image/png;base64,")).toBe(true);
    const phases = doc.pages.find((p) => p.title === "Phases")!.blocks.filter((b) => b.kind === "todo");
    expect(phases.map((b) => b.kind === "todo" && b.checked)).toEqual([true, true, false, false, false]);
  });

  it("nessun commento né nome di chi è presente o segue (R-G5, in minuscolo)", async () => {
    setSessionPersonId(LAURA);
    const doc = text(modelFor((await productDocs.getProductExport(ACQ))!));
    const acqPages = new Set(state.productPages.filter((p) => p.projectId === ACQ).map((p) => p.id));
    // Le domande di Claude (seme 11b) hanno il corpo vuoto: il testo si compone a lettura.
    const comments = state.productComments.filter((c) => acqPages.has(c.pageId) && c.body !== "");
    expect(comments.length).toBeGreaterThan(0);
    for (const c of comments) expect(doc).not.toContain(c.body.toLowerCase());
    for (const person of PEOPLE) expect(doc).not.toContain(person.name.toLowerCase());
    for (const id of ["p-laura", "p-marco", "p-matteo"]) expect(doc).not.toContain(id);
  });

  it("come Sara: AUD-8 resta testo (nessun link, nessun titolo), il file nascosto è «File: ACQ-F1 (not available)»", async () => {
    state.driveFiles.find((f) => f.id === "drv-acq-1")!.hidden = true;
    setSessionPersonId(SARA);
    const doc = modelFor((await productDocs.getProductExport(ACQ))!);
    expect(lines(doc)[0]).toBe("File: ACQ-F1 (not available)");
    const aud = allRuns(doc).find((r) => r.text.includes("AUD-8"))!;
    expect(aud.href).toBeNull();
    const all = text(doc);
    expect(all).not.toContain("client brief.pdf");
    expect(all).not.toContain(state.tasks.find((t) => t.code === "AUD-8")!.title.toLowerCase());
  });

  it("la frase di Overview: un pezzo in grassetto, uno in corsivo, uno con l'https del seme", async () => {
    setSessionPersonId(LAURA);
    const doc = modelFor((await productDocs.getProductExport(ACQ))!);
    const first = doc.pages[0]!.blocks[0]!;
    expect(first.kind).toBe("paragraph");
    const runs = runsOf(first);
    const seed = pageOf("Overview").blocks[0]!;
    expect(runs.map((r) => r.text).join("")).toBe(seed.type === "paragraph" ? seed.content.text : null);
    expect(runs.find((r) => r.bold)).toMatchObject({ text: "pay their bills", italic: false, href: null });
    expect(runs.find((r) => r.italic)).toMatchObject({ text: "service charter", bold: false });
    expect(runs.find((r) => r.href)).toMatchObject({
      text: "the utility's website",
      href: "https://www.acquedottocolline.example/carta-dei-servizi",
    });
  });

  it("un link `javascript:` scritto nello stato (saltando la validazione) esce senza href, col suo testo", () => {
    const doc = exportModelOf(
      {
        title: "x",
        pages: [
          {
            depth: 0,
            page: {
              ...pageOf("Sign-in"),
              blocks: [
                {
                  id: "blk-x",
                  type: "paragraph",
                  content: {
                    text: "Click here now",
                    marks: [{ type: "link", start: 6, end: 10, href: "javascript:alert(1)" }],
                  },
                },
              ],
            },
          },
        ],
      },
      { driveLine: () => "", decisionLine: () => "" },
    );
    const runs = runsOf(doc.pages[0]!.blocks[0]!);
    expect(runs.map((r) => r.text).join("")).toBe("Click here now");
    expect(runs.every((r) => r.href === null)).toBe(true);
    expect(text(doc)).not.toContain("javascript");
  });
});
