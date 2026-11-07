import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { T } from "../../domain/claude/context";
import { noteLine } from "../../domain/claude/intents/archive";
import { backlogCandidatesOf } from "../../domain/productDocs/backlog";
import { createRequestAs } from "../api-mutations";
import { getRequest, getRequestByCode, listRequests, listRequestsToConvert, productDocs, projectSettings, resetApi, setLatency } from "../api";
import { PHASE_HEADINGS } from "../seed/productDocs/acq";
import type { ProductBlock, RichText } from "../model";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import {
  listProductLinkedRequestsAs,
  productOriginOf,
  proposeBacklogFromPageAs,
} from "./backlog";

// Le voci di backlog proposte da una pagina o da una sua sezione (11b, Task
// 7; shape product-claude-backlog.md §3.1–3.4). Pagina: Phases di ACQ (seme
// 11a), cinque passi da spuntare; due richieste del seme nascono già da lì
// (`req-acq-6` dal passo delle rate, `req-acq-7` da quello dei guasti), e
// dalla prima è nata la task ACQ-10. Laura (Project Lead) e Marco
// (Developer) hanno `docs.edit` in ACQ; Sara (Contributor) legge soltanto;
// Giulia non è in ACQ.

const LAURA = "p-laura";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const ACQ = "prj-acq";
const PHASES = "pp-acq-phases";

const plain = (text: string): RichText => ({ text, marks: [] });
const page = () => state.productPages.find((p) => p.id === PHASES)!;
const request = (id: string) => state.requests.find((r) => r.id === id)!;

beforeEach(() => {
  resetApi();
  setLatency(0);
  setSessionPersonId(LAURA);
});
afterEach(() => resetApi());

describe("backlogCandidatesOf (pura)", () => {
  const blocks: ProductBlock[] = [
    { id: "a", type: "paragraph", content: plain("What goes out when.") },
    { id: "h1", type: "heading", level: 2, content: plain("Phase 1") },
    { id: "b", type: "bullet", indent: 0, content: plain("  Customers download bills as PDF  ") },
    { id: "c", type: "paragraph", content: plain("Not a list item.") },
    { id: "h1a", type: "heading", level: 3, content: plain("Later in phase 1") },
    { id: "d", type: "todo", checked: false, content: plain("Meter readings from the app") },
    { id: "h2", type: "heading", level: 2, content: plain("Phase 2") },
    { id: "e", type: "numbered", indent: 1, content: plain("Fault reports with a photo") },
    { id: "f", type: "todo", checked: true, content: plain("   ") },
  ];

  it("voci di elenco e liste di controllo della pagina: titolo e descrizione sono la frase, senza pagina né sezione (R-G5)", () => {
    const out = backlogCandidatesOf(blocks, null);
    expect(out.map((c) => [c.anchorId, c.title, c.description])).toEqual([
      ["b", "Customers download bills as PDF", "Customers download bills as PDF"],
      ["d", "Meter readings from the app", "Meter readings from the app"],
      ["e", "Fault reports with a photo", "Fault reports with a photo"],
    ]);
  });

  it("la sola sezione di un titolo: fino al titolo dello stesso livello, sotto-titoli compresi", () => {
    expect(backlogCandidatesOf(blocks, "h1").map((c) => c.anchorId)).toEqual(["b", "d"]);
    expect(backlogCandidatesOf(blocks, "h1a").map((c) => c.anchorId)).toEqual(["d"]);
    expect(backlogCandidatesOf(blocks, "h2").map((c) => c.anchorId)).toEqual(["e"]);
    // Un'ancora che non è un titolo, o che non c'è: nessuna sezione.
    expect(backlogCandidatesOf(blocks, "b")).toEqual([]);
    expect(backlogCandidatesOf(blocks, "nope")).toEqual([]);
  });

  it("un titolo lungo si taglia a 120 con «…»; la descrizione tiene la frase intera", () => {
    const long = "x".repeat(300);
    const [c] = backlogCandidatesOf([{ id: "l", type: "bullet", indent: 0, content: plain(long) }], null);
    expect(c!.title).toHaveLength(120);
    expect(c!.title.endsWith("…")).toBe(true);
    expect(c!.description).toBe(long);
    expect(c!.sentence).toBe(long);
  });
});

describe("proposeBacklogFromPage", () => {
  it("Phases: i tre passi non ancora proposti come `createRequest` con l'origine della doc; i due già proposti sono una nota coi codici", () => {
    const { actions, notes } = proposeBacklogFromPageAs(LAURA, PHASES);
    expect(actions.map((a) => a.args.title)).toEqual([
      "Phase 1: sign-in and bills",
      "Phase 1: meter readings",
      "Phase 3: a dark appearance",
    ]);
    for (const a of actions) {
      expect(a.fn).toBe("createRequest");
      expect(a.args).toMatchObject({
        projectId: ACQ,
        origin: { kind: "product_doc", pageId: PHASES },
      });
      // La descrizione è la frase: niente codice né titolo della pagina (R-G5,
      // ruling del controller sul fix round 1); «Dalla doc» si deriva a lettura.
      expect(a.args.description).toBe(a.args.title);
      // Nessuna urgenza né stima inventata: la pagina non le dice.
      expect(a.args).not.toHaveProperty("urgency");
      expect(a.why).toEqual({ key: "claude.answers.productDocs.backlog.why", params: { sentence: a.args.title } });
      expect(a.summaryText).toEqual({ key: "claude.answers.request.summary", params: { code: "ACQ", title: a.args.title } });
    }
    const anchors = actions.map((a) => (a.args.origin as { anchorId: string }).anchorId);
    expect(anchors).toEqual(["blk-acq-phases-2", "blk-acq-phases-reading", "blk-acq-phases-5"]);
    expect(notes).toEqual([
      {
        kind: "already_proposed",
        codes: [request("req-acq-7").code, request("req-acq-6").code],
        hidden: 0,
      },
    ]);
  });

  it("confermata una voce, la stessa frase non torna: diventa parte della nota", () => {
    const [first] = proposeBacklogFromPageAs(LAURA, PHASES).actions;
    const made = createRequestAs(LAURA, first!.args as never);
    const again = proposeBacklogFromPageAs(LAURA, PHASES);
    expect(again.actions).toHaveLength(2);
    expect(again.notes[0]).toMatchObject({ kind: "already_proposed" });
    expect((again.notes[0] as { codes: string[] }).codes).toContain(made.code);
  });

  it("revisione finale M5: due schede con le stesse voci, confermate entrambe: la seconda è rifiutata (`already_proposed`)", () => {
    const one = proposeBacklogFromPageAs(LAURA, PHASES).actions;
    const two = proposeBacklogFromPageAs(LAURA, PHASES).actions;
    createRequestAs(LAURA, one[0]!.args as never);
    const before = state.requests.length;
    expect(() => createRequestAs(LAURA, two[0]!.args as never)).toThrow("invalid: already_proposed");
    expect(state.requests.length).toBe(before);
    // Una voce nuova della seconda scheda passa.
    expect(() => createRequestAs(LAURA, two[1]!.args as never)).not.toThrow();
  });

  it("dal titolo «Phase 1» del seme: le sue due voci, nessuna nota", () => {
    const { actions, notes } = proposeBacklogFromPageAs(LAURA, PHASES, PHASE_HEADINGS.phase1);
    expect(actions.map((a) => a.args.title)).toEqual(["Phase 1: sign-in and bills", "Phase 1: meter readings"]);
    expect(notes).toEqual([]);
  });

  it("dal titolo «Phase 2» del seme: tutto già proposto, nessuna azione e la nota coi codici", () => {
    const out = proposeBacklogFromPageAs(LAURA, PHASES, PHASE_HEADINGS.phase2);
    expect(out.actions).toEqual([]);
    expect(out.notes).toEqual([
      { kind: "already_proposed", codes: [request("req-acq-7").code, request("req-acq-6").code], hidden: 0 },
    ]);
  });

  it("dal titolo «Phase 3» del seme: il solo passo del tema scuro", () => {
    const { actions } = proposeBacklogFromPageAs(LAURA, PHASES, PHASE_HEADINGS.phase3);
    expect(actions.map((a) => a.args.title)).toEqual(["Phase 3: a dark appearance"]);
  });

  it("R-G5: una richiesta CREATA da qui, letta da chi non vede la pagina, non nomina né il codice né il titolo della pagina", async () => {
    const [first] = proposeBacklogFromPageAs(LAURA, PHASES, PHASE_HEADINGS.phase3).actions;
    const made = createRequestAs(LAURA, first!.args as never);
    const code = page().code.toLowerCase();
    expect(await projectSettings.setDocsModule(ACQ, false)).toEqual({ ok: true });
    for (const who of [LAURA, SARA]) {
      setSessionPersonId(who);
      const reads = [
        await getRequest(made.id),
        await getRequestByCode(made.code),
        (await listRequests(ACQ)).find((r) => r.id === made.id),
        ...(who === LAURA ? [(await listRequestsToConvert()).find((r) => r.id === made.id)] : []),
      ];
      for (const read of reads) {
        expect(read, who).toBeDefined();
        const text = JSON.stringify(read).toLowerCase();
        expect(text, who).not.toContain(code);
        expect(text, who).not.toContain("phases");
      }
    }
  });

  it("un'ancora che non è un titolo della pagina: `invalid: anchor`; Sara (senza `docs.edit`): `forbidden`; Giulia: `not_found`", () => {
    expect(() => proposeBacklogFromPageAs(LAURA, PHASES, "blk-acq-phases-2")).toThrow("invalid: anchor");
    expect(() => proposeBacklogFromPageAs(LAURA, PHASES, "blk-nope")).toThrow("invalid: anchor");
    expect(() => proposeBacklogFromPageAs(SARA, PHASES)).toThrow("forbidden");
    expect(() => proposeBacklogFromPageAs(GIULIA, PHASES)).toThrow("not_found");
  });

  it("dal cancello: `productDocs.proposeBacklogFromPage` come chi è in sessione", async () => {
    const out = await productDocs.proposeBacklogFromPage(PHASES);
    expect(out.actions).toHaveLength(3);
  });
});

describe("«Dalla doc»: l'origine e le voci collegate", () => {
  it("una task nata da una richiesta della doc: la pagina d'origine con codice e titolo", () => {
    const task = state.tasks.find((t) => t.requestId === "req-acq-6")!;
    const origin = { pageId: PHASES, code: page().code, title: "Phases" };
    expect(productOriginOf(LAURA, task)).toEqual(origin);
    expect(productOriginOf(SARA, request("req-acq-6"))).toEqual(origin);
    // Una richiesta che non viene dalla doc, o una task senza richiesta: niente.
    expect(productOriginOf(LAURA, request("req-acq-1"))).toBeNull();
    expect(productOriginOf(LAURA, { ...task, requestId: null })).toBeNull();
  });

  it("in lettura sulla richiesta (`productOrigin`, P38); nascosto per chi non vede la pagina", async () => {
    const r = (await getRequest("req-acq-6"))!;
    expect(r.productOrigin).toEqual({ pageId: PHASES, code: page().code, title: "Phases" });
    expect((await getRequestByCode(r.code))!.productOrigin).toEqual(r.productOrigin);
    expect((await getRequest("req-acq-1"))!).not.toHaveProperty("productOrigin");
    // Con i Docs di ACQ spenti la richiesta si vede ancora, la pagina no.
    expect(await projectSettings.setDocsModule(ACQ, false)).toEqual({ ok: true });
    for (const who of [LAURA, SARA]) {
      setSessionPersonId(who);
      const hidden = (await getRequest("req-acq-6"))!;
      expect(hidden).not.toHaveProperty("productOrigin");
      expect(JSON.stringify(hidden).toLowerCase()).not.toContain("phases");
      expect(productOriginOf(who, request("req-acq-6"))).toBeNull();
    }
  });

  it("le voci collegate in fondo alla pagina: codice, titolo, stato e le task nate", () => {
    const six = request("req-acq-6");
    const seven = request("req-acq-7");
    const task = state.tasks.find((t) => t.requestId === "req-acq-6")!;
    expect(listProductLinkedRequestsAs(SARA, PHASES)).toEqual([
      { id: six.id, code: six.code, title: six.title, status: "converted", taskCodes: [task.code] },
      { id: seven.id, code: seven.code, title: seven.title, status: "new", taskCodes: [] },
    ]);
    expect(listProductLinkedRequestsAs(GIULIA, PHASES)).toEqual([]);
    expect(listProductLinkedRequestsAs(LAURA, "pp-acq-sign-in")).toEqual([]);
  });

  it("una task eliminata non è fra le task nate", () => {
    const task = state.tasks.find((t) => t.requestId === "req-acq-6")!;
    state.deletedTasks.push({ id: task.id, code: task.code } as never);
    expect(listProductLinkedRequestsAs(LAURA, PHASES)[0]!.taskCodes).toEqual([]);
  });

  it("dal cancello: `productDocs.listProductLinkedRequests`", async () => {
    expect((await productDocs.listProductLinkedRequests(PHASES)).map((r) => r.code)).toEqual([
      request("req-acq-6").code,
      request("req-acq-7").code,
    ]);
  });
});

describe("la nota `already_proposed` (P35)", () => {
  const en = i18n.getFixedT("en") as unknown as T;
  const it_ = i18n.getFixedT("it") as unknown as T;

  it("i codici visibili in grassetto, gli altri contati e mai nominati, in en e it", () => {
    expect(noteLine(en, { kind: "already_proposed", codes: ["ACQ-R7", "ACQ-R6"], hidden: 0 })).toBe(
      "Already proposed from this page: **ACQ-R7**, **ACQ-R6**",
    );
    expect(noteLine(it_, { kind: "already_proposed", codes: ["ACQ-R7"], hidden: 1 })).toBe(
      "Già proposte da questa pagina: **ACQ-R7** …e un'altra",
    );
    expect(noteLine(en, { kind: "already_proposed", codes: [], hidden: 2 })).toBe(
      "2 already proposed from this page",
    );
  });
});
