import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { readsAs } from "../../../data/api-mutations";
import { executeGroup, undoViewOf } from "../../../data/claude/actions";
import { classOfGroup } from "../../../data/claude/classes";
import { whenFirstVersionIdle } from "../../../data/productDocs/firstVersion";
import { whenProductClaudeIdle } from "../../../data/productDocs/claude";
import { writeProductBlocksAs } from "../../../data/productDocs/writes";
import { ACQ_11B } from "../../../data/seed/productDocs/facts";
import { withoutSeed11b } from "../../../data/seed/productDocs/without11b";
import { done as mailDone } from "../../../data/seed/mail/helpers";
import { MAIL_INCOMING } from "../../../data/seed/mail/incoming";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type {
  ContextRef,
  ConversationEvent,
  ProposedAction,
  ScriptStep,
} from "../../../data/types";
import { revokeProjectPermission } from "../../../data/viewer";
import { recognize, respond, type IntentContext } from "../intents";
import { CAPABILITIES } from "./general";

// La doc di prodotto nel riquadro di Claude (11b, Task 8): i cinque gesti
// del catalogo («scrivi la prima versione», «aggiorna da questa email o
// riunione», «proponi le voci di backlog», «disegna questa schermata»,
// «cosa è cambiato questa settimana») e le due frasi che la pagina manda al
// riquadro (P21: «apri una richiesta dalla domanda <id>», «proponi le voci
// da <codice>[ sezione]»). Il motore legge come chi chiede (`readsAs`) e
// propone; le scritture le fa il catalogo, con la classe del livello dati.

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");
const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const ROBERTA = "p-roberta";
const ACQ = "prj-acq";
const VRD = "prj-vrd";
const SIGN_IN = "pp-acq-sign-in";
const SCREENS = "pp-acq-screens";
const SIGN_IN_THREAD = "th-acq-signin-google";

function as(personId: string, t = en, extra: Partial<IntentContext> = {}): IntentContext {
  setSessionPersonId(personId);
  return {
    personId,
    contextProjectId: null,
    read: readsAs(personId),
    t,
    seed: "conv-11b-panel",
    classify: async (actions) => classOfGroup(personId, actions),
    ...extra,
  };
}

const said = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n");
type Draft<T extends ConversationEvent["type"]> = Omit<
  Extract<ConversationEvent, { type: T }>,
  "id" | "at"
>;
function events<T extends ConversationEvent["type"]>(steps: ScriptStep[], type: T): Draft<T>[] {
  return steps.flatMap((s) =>
    s.step === "event" && s.event.type === type ? [s.event as unknown as Draft<T>] : [],
  );
}
const proposalOf = (steps: ScriptStep[]) => events(steps, "proposal")[0];
const executedOf = (steps: ScriptStep[]) => events(steps, "executed")[0];
const refsOf = (steps: ScriptStep[]) => events(steps, "citation").flatMap((e) => e.refs);
const pageBlocks = (pageId: string) => state.productPages.find((p) => p.id === pageId)!.blocks;

/** Esegue come il turno libero: il gruppo col catalogo, nella classe calcolata. */
function run(me: string, actions: ProposedAction[]) {
  return executeGroup(me, "cv-11b-panel", actions, classOfGroup(me, actions).cls);
}

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
});

describe("recognize: le frasi della doc di prodotto, in inglese e in italiano", () => {
  it.each([
    "Write the first version of VRD's docs",
    "Scrivi la prima versione della doc di VRD",
    "Update ACQ-D5 Sign-in from this email",
    "Update Sign-in from this meeting",
    "Aggiorna Sign-in da questa email",
    "Aggiorna ACQ-D6 da questa riunione",
    "Propose backlog items from ACQ-D11 Phases",
    "Proponi le voci di backlog da ACQ-D11 Phases",
    "Propose backlog items from the section “Phase 2” of ACQ-D11",
    "Proponi le voci di backlog dalla sezione «Phase 2» di ACQ-D11",
    "Draw this screen in ACQ-D9",
    "Disegna questa schermata in ACQ-D9",
    "What changed in the docs this week?",
    "Cosa è cambiato nella doc questa settimana?",
    "Open a request from question pc-acq11b-bills-q",
    "Apri una richiesta dalla domanda pc-acq11b-bills-q",
  ])("«%s» → productDoc", (text) => {
    expect(recognize(text, new Set(["ACQ", "VRD"]))).toBe("productDoc");
  });

  it.each([
    ["How does sign-in work in ACQ?", "howto"],
    ["Come funziona la prima versione?", "howto"],
    ["Update ACQ-3", "explain"],
    ["What changed in AUD-3?", "explain"],
  ])("«%s» resta %s", (text, intent) => {
    expect(recognize(text, new Set(["ACQ", "AUD"]))).toBe(intent);
  });
});

describe("S0: cosa so fare", () => {
  it("elenca le cinque capacità della doc di prodotto, con etichetta e frase in en e it", async () => {
    const five = [
      "productFirstVersion",
      "productUpdate",
      "productBacklog",
      "productWireframe",
      "productChanges",
    ] as const;
    for (const id of five) expect(CAPABILITIES).toContain(id);
    const steps = await respond("write me a poem", as(LAURA));
    expect(events(steps, "capabilities")[0]!.items).toEqual([...CAPABILITIES]);
    for (const t of [en, it_]) {
      for (const id of five) {
        expect(t(`claude.answers.capabilities.label.${id}`)).not.toMatch(/^claude\./);
        expect(t(`claude.answers.capabilities.prompt.${id}`)).not.toMatch(/^claude\./);
      }
    }
  });
});

describe("scrivi la prima versione (A, con «Undo»)", () => {
  it("Laura su VRD vuoto: parte subito, scrive le pagine, e «Undo» le toglie tutte", async () => {
    const steps = await respond("Write the first version of VRD's docs", as(LAURA));
    expect(proposalOf(steps)).toBeUndefined();
    const executed = executedOf(steps)!;
    expect(executed.actions.map((a) => a.fn)).toEqual(["writeFirstVersion"]);
    expect(executed.actions[0]!.args).toMatchObject({ projectId: VRD });
    expect(classOfGroup(LAURA, executed.actions).cls).toBe("A");

    const done = run(LAURA, executed.actions);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    await whenFirstVersionIdle();
    expect(state.productPages.filter((p) => p.projectId === VRD).length).toBeGreaterThan(0);
    expect(undoViewOf(LAURA, done.groupId)).toEqual({ state: "available", needsReauth: false });

    const record = state.claudeActions.find((r) => r.groupId === done.groupId)!;
    expect(record.inverse).toEqual({ fn: "undoFirstVersion", args: { projectId: VRD } });
    const undone = run(LAURA, [
      { fn: record.inverse!.fn, args: record.inverse!.args, summary: "" },
    ]);
    expect(undone.ok).toBe(true);
    expect(state.productPages.filter((p) => p.projectId === VRD)).toEqual([]);
  });

  it("dopo che Marco ha toccato una pagina, «Undo» è spento col suo nome", async () => {
    const steps = await respond("Scrivi la prima versione della doc di VRD", as(LAURA, it_));
    const done = run(LAURA, executedOf(steps)!.actions);
    if (!done.ok) throw new Error("not run");
    await whenFirstVersionIdle();
    const page = state.productPages.find((p) => p.projectId === VRD)!;
    const block = page.blocks.find((b) => b.type === "paragraph")!;
    writeProductBlocksAs(MARCO, page.id, [{ op: "delete", blockId: block.id }], {});
    expect(undoViewOf(LAURA, done.groupId)).toMatchObject({
      state: "changed_after",
      byName: "Marco Bellini",
    });
  });

  it("ACQ ha già le sue pagine: niente da eseguire, e la frase lo dice", async () => {
    const steps = await respond("Write the first version of ACQ's docs", as(LAURA));
    expect(executedOf(steps)).toBeUndefined();
    expect(proposalOf(steps)).toBeUndefined();
    expect(said(steps)).toMatch(/already has pages/i);
  });
});

describe("aggiorna la pagina da questa email (B, avvisa chi segue)", () => {
  beforeEach(() => withoutSeed11b());

  it("Laura sull'email di Sign-in: una scheda B coi blocchi che cambiano e chi viene avvisato", async () => {
    const steps = await respond(
      "Update ACQ-D5 Sign-in from this email",
      as(LAURA, en, { context: { kind: "mail", threadId: SIGN_IN_THREAD } }),
    );
    expect(executedOf(steps)).toBeUndefined();
    const card = proposalOf(steps)!;
    expect(card.actions.map((a) => a.fn)).toEqual(["updateProductPage"]);
    expect(card.actions[0]!.args).toEqual({
      pageId: SIGN_IN,
      source: { kind: "email", id: ACQ_11B.signInEmailId },
    });
    // I blocchi: la frase nuova, parola per parola, nel DATO dell'azione (la
    // riga della scheda la compone la lettura per chi legge); mai nel testo
    // di Claude, che una pubblica fa leggere ad altri (fix round 1).
    const sentence =
      "Google is the only way in: there is no password of our own and no other kind of account.";
    expect(card.actions[0]!.productPreview).toEqual({
      changes: [{ kind: "insert", before: null, after: sentence }],
      questions: 0,
      waiting: 0,
    });
    expect(said(steps)).not.toContain(sentence);
    expect(said(steps)).toContain("1 sentence would change");
    // Chi viene avvisato: chi segue la pagina, meno chi chiede.
    const cls = classOfGroup(LAURA, card.actions);
    expect(cls.cls).toBe("B");
    expect(cls.reasons).toEqual([{ kind: "notifies", personIds: [MARCO], more: false }]);
    expect(said(steps)).toContain("Marco Bellini");

    // Confermata: la modifica di Claude per conto della titolare, e la card a Marco.
    const before = state.notifications.length;
    const done = run(LAURA, card.actions);
    expect(done.ok).toBe(true);
    await whenProductClaudeIdle();
    const revision = state.productRevisions.at(-1)!;
    expect(revision).toMatchObject({ pageId: SIGN_IN, via: "claude", actorId: LAURA });
    expect(state.notifications.slice(before).map((n) => n.kind)).toEqual(["product_doc.updated"]);
    // «Undo» del riquadro rimette la pagina.
    if (!done.ok) return;
    const record = state.claudeActions.find((r) => r.groupId === done.groupId)!;
    expect(record.inverse).toEqual({
      fn: "undoProductUpdate",
      args: { revisionId: revision.id },
    });
  });

  it("Marco non ha ricevuto l'email: rifiutato, senza nominarla, come un'email che non c'è", async () => {
    const hidden = await respond(
      "Aggiorna Sign-in da questa email",
      as(MARCO, it_, { context: { kind: "mail", threadId: SIGN_IN_THREAD } }),
    );
    const missing = await respond(
      "Aggiorna Sign-in da questa email",
      as(MARCO, it_, { context: { kind: "mail", threadId: "th-does-not-exist" } }),
    );
    expect(proposalOf(hidden)).toBeUndefined();
    expect(executedOf(hidden)).toBeUndefined();
    expect(said(hidden)).toBe(said(missing));
    const json = JSON.stringify(hidden).toLowerCase();
    for (const word of ["google accounts only", "portal sign-in", SIGN_IN_THREAD, ACQ_11B.signInEmailId, "#/mail"])
      expect(json).not.toContain(word.toLowerCase());
  });

  it("Laura ha il cursore nella sezione: non aspetta sé stessa, la scheda e la conferma scrivono subito", async () => {
    setSessionPersonId(LAURA);
    await api.productDocs.setProductPresence(SIGN_IN, { anchorId: "blk-acq-signin-2", offset: 0 });
    const steps = await respond(
      "Update ACQ-D5 Sign-in from this email",
      as(LAURA, en, { context: { kind: "mail", threadId: SIGN_IN_THREAD } }),
    );
    expect(said(steps)).not.toMatch(/will wait/);
    const done = run(LAURA, proposalOf(steps)!.actions);
    expect(done.ok).toBe(true);
    expect(state.productPending).toEqual([]);
    expect(state.productRevisions.at(-1)).toMatchObject({ pageId: SIGN_IN, via: "claude" });
  });

  it("confermata da chi non può aprire l'email: `not_found`, e la pagina non cambia", () => {
    setSessionPersonId(MARCO);
    const before = JSON.stringify(pageBlocks(SIGN_IN));
    const done = run(MARCO, [
      {
        fn: "updateProductPage",
        args: { pageId: SIGN_IN, source: { kind: "email", id: ACQ_11B.signInEmailId } },
        summary: "",
      },
    ]);
    expect(done).toMatchObject({ ok: false, code: "not_found" });
    expect(JSON.stringify(pageBlocks(SIGN_IN))).toBe(before);
  });

  it("fix round 1 (Minor 4): l'anteprima è una lettura, non consuma id", async () => {
    const counter = structuredClone(state.counter);
    const ids = state.productBlockIds.size;
    await respond(
      "Update ACQ-D5 Sign-in from this email",
      as(LAURA, en, { context: { kind: "mail", threadId: SIGN_IN_THREAD } }),
    );
    expect(state.counter).toEqual(counter);
    expect(state.productBlockIds.size).toBe(ids);
  });

  it("senza un'email aperta chiede di aprirla, senza scheda", async () => {
    const steps = await respond("Update Sign-in from this email", as(LAURA));
    expect(proposalOf(steps)).toBeUndefined();
    expect(said(steps)).toMatch(/open the email/i);
  });

  it("la scheda è B anche quando chi chiede è l'unico a seguire la pagina", () => {
    state.productFollows = state.productFollows.filter((f) => f.pageId !== SIGN_IN);
    state.productFollows.push({ pageId: SIGN_IN, personId: LAURA, since: "2026-11-01T00:00:00Z" });
    const action = {
      fn: "updateProductPage" as const,
      args: { pageId: SIGN_IN, source: { kind: "email", id: ACQ_11B.signInEmailId } },
      summary: "",
    };
    expect(classOfGroup(LAURA, [action])).toEqual({ cls: "B", reasons: [] });
  });
});

describe("proponi le voci di backlog (la scheda in blocco)", () => {
  it("dalla sezione «Phase 1» di Phases: una createRequest per passo, con l'origine della doc", async () => {
    const steps = await respond(
      "Propose backlog items from the section “Phase 1” of ACQ-D11",
      as(LAURA),
    );
    const card = proposalOf(steps)!;
    expect(card.actions.length).toBe(2);
    for (const a of card.actions) {
      expect(a.fn).toBe("createRequest");
      expect(a.args.origin).toMatchObject({ kind: "product_doc", pageId: "pp-acq-phases" });
    }
    expect(classOfGroup(LAURA, card.actions).cls).toBe("B");
  });

  it("dalla sezione «Phase 2», già proposta: nessuna scheda, e i codici già nel backlog", async () => {
    const steps = await respond(
      "Proponi le voci di backlog dalla sezione «Phase 2» di ACQ-D11",
      as(LAURA, it_),
    );
    expect(proposalOf(steps)).toBeUndefined();
    expect(said(steps)).toContain("ACQ-R7");
  });

  it("Sara non scrive la doc: nessuna scheda, la frase del permesso col «Who?»", async () => {
    const steps = await respond("Propose backlog items from ACQ-D11 Phases", as(SARA));
    expect(proposalOf(steps)).toBeUndefined();
    expect(said(steps)).toContain("who:editDocs/ACQ");
  });
});

describe("disegna questa schermata (A, con «Undo»)", () => {
  it("Laura su Screens: la bozza in fondo alla pagina; «Undo» la toglie", async () => {
    const steps = await respond("Draw this screen in ACQ-D9", as(LAURA));
    const executed = executedOf(steps)!;
    expect(executed.actions.map((a) => a.fn)).toEqual(["drawWireframe"]);
    expect(classOfGroup(LAURA, executed.actions).cls).toBe("A");
    const count = pageBlocks(SCREENS).length;
    const done = run(LAURA, executed.actions);
    if (!done.ok) throw new Error("not run");
    expect(pageBlocks(SCREENS)).toHaveLength(count + 1);
    expect(pageBlocks(SCREENS).at(-1)!.type).toBe("wireframe");
    const record = state.claudeActions.find((r) => r.groupId === done.groupId)!;
    expect(record.inverse!.fn).toBe("deleteWireframe");
    expect(undoViewOf(LAURA, done.groupId)).toEqual({ state: "available", needsReauth: false });
    const undone = run(LAURA, [{ fn: record.inverse!.fn, args: record.inverse!.args, summary: "" }]);
    expect(undone.ok).toBe(true);
    expect(pageBlocks(SCREENS)).toHaveLength(count);
  });

  it("rifatta da Marco dopo: «Undo» è spento col suo nome", async () => {
    const steps = await respond("Disegna questa schermata in ACQ-D9", as(LAURA, it_));
    const done = run(LAURA, executedOf(steps)!.actions);
    if (!done.ok) throw new Error("not run");
    const block = pageBlocks(SCREENS).at(-1)!;
    api.productDocs.redrawWireframeAs(MARCO, SCREENS, block.id);
    expect(undoViewOf(LAURA, done.groupId)).toMatchObject({
      state: "changed_after",
      byName: "Marco Bellini",
    });
  });

  it("senza una pagina nominata chiede quale, senza azione", async () => {
    const steps = await respond("Draw this screen", as(LAURA));
    expect(executedOf(steps)).toBeUndefined();
    expect(said(steps)).toMatch(/which page/i);
  });

  it("Sara: il gruppo non parte (`forbidden`, il «Who?» di editDocs)", async () => {
    const steps = await respond("Draw this screen in ACQ-D9", as(SARA));
    const actions = executedOf(steps)?.actions ?? proposalOf(steps)?.actions ?? [];
    const done = run(SARA, actions.length > 0 ? actions : [
      { fn: "drawWireframe", args: { pageId: SCREENS, afterId: null }, summary: "" },
    ]);
    expect(done).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("cosa è cambiato nella doc questa settimana (una lettura)", () => {
  it("Laura: le pagine cambiate, con la fonte che lei può aprire", async () => {
    const steps = await respond("What changed in the docs this week?", as(LAURA));
    expect(proposalOf(steps)).toBeUndefined();
    expect(executedOf(steps)).toBeUndefined();
    const text = said(steps);
    expect(text).toContain("ACQ-D5");
    expect(refsOf(steps)).toContainEqual({ kind: "doc", id: SIGN_IN });
    // Le fonti come dato (la frase la compone la lettura per chi legge, fix round 1).
    const say = steps.find((s) => s.step === "say" && s.productWeek);
    const row = say?.step === "say" ? say.productWeek!.rows.find((r) => r.pageId === SIGN_IN) : undefined;
    expect(row?.sourceRefs).toContainEqual({ kind: "email", id: ACQ_11B.signInEmailId });
  });

  it("il testo salvato non ha né fonti né nomi: nessuna parola dell'oggetto", async () => {
    const steps = await respond("What changed in the docs this week?", as(LAURA));
    const text = said(steps).toLowerCase();
    expect(text).toContain("acq-d5");
    expect(text).not.toContain("google accounts only");
    expect(text).not.toContain("laura costa");
  });

  it("Sara senza i Docs di ACQ: niente di ACQ, in nessun campo", async () => {
    revokeProjectPermission(SARA, ACQ, "docs.view" as never);
    const steps = await respond("Cosa è cambiato nella doc questa settimana?", as(SARA, it_));
    const json = JSON.stringify(steps).toLowerCase();
    for (const word of ["acq-d", "sign-in", "laura costa", "pp-acq"]) expect(json).not.toContain(word);
  });
});

describe("apri una richiesta dalla domanda (P21)", () => {
  it("Laura: la scheda B di createRequest con la domanda nell'origine", async () => {
    const steps = await respond("Open a request from question pc-acq11b-bills-q", as(LAURA));
    const card = proposalOf(steps)!;
    expect(card.actions.map((a) => a.fn)).toEqual(["createRequest"]);
    expect(card.actions[0]!.args.origin).toEqual({
      kind: "product_doc",
      pageId: "pp-acq-bills",
      anchorId: "blk-acq-bills-3",
      questionId: "pc-acq11b-bills-q",
    });
    expect(classOfGroup(LAURA, card.actions).cls).toBe("B");
  });

  it("una domanda che chi chiede non legge: la stessa frase di una che non c'è", async () => {
    revokeProjectPermission(SARA, ACQ, "docs.view" as never);
    const hidden = await respond("Open a request from question pc-acq11b-bills-q", as(SARA));
    const missing = await respond("Open a request from question pc-nope", as(SARA));
    expect(proposalOf(hidden)).toBeUndefined();
    expect(said(hidden)).toBe(said(missing));
    expect(JSON.stringify(hidden).toLowerCase()).not.toContain("bills");
  });
});

describe("le risposte del progetto citano anche le pagine di prodotto", () => {
  it("«How does sign-in work in ACQ?» cita Sign-in (ACQ-D5)", async () => {
    const steps = await respond("How does sign-in work in ACQ?", as(LAURA));
    expect(refsOf(steps)).toContainEqual({ kind: "doc", id: SIGN_IN });
    expect(said(steps)).toContain("ACQ-D5");
  });
});

describe("fix round 1: in una conversazione pubblica le frasi dell'email non escono (decisione 1, I1)", () => {
  const SUBJECT_WORDS = ["google accounts only", "portal sign-in"];
  const SENTENCE = "google is the only way in";

  /** Laura chiede nel riquadro, la rende pubblica; la lettura di chi guarda. */
  async function publicAsk(text: string, context: ContextRef | null) {
    setSessionPersonId(LAURA);
    const c = await api.createConversation({ contextProjectId: ACQ });
    await api.sendMessage(c.id, { text }, { context });
    for (let i = 0; i < 10; i++) {
      await api.whenIdle(c.id);
      await new Promise((r) => setTimeout(r, 0));
    }
    await api.setVisibility(c.id, "public", { confirmedProjectIds: [ACQ] });
    return c.id;
  }
  const readAs = async (personId: string, id: string) => {
    setSessionPersonId(personId);
    return JSON.stringify(await api.getConversation(id)).toLowerCase();
  };

  it("la scheda dell'aggiornamento: Laura legge le frasi e l'oggetto; Marco no, nemmeno a scheda rifiutata", async () => {
    withoutSeed11b();
    const id = await publicAsk("Update ACQ-D5 Sign-in from this email", {
      kind: "mail",
      threadId: SIGN_IN_THREAD,
    });
    // Nel dato salvato del testo di Claude: nessuna frase, nessun oggetto.
    const assistant = (state.conversationEvents.get(id) ?? [])
      .flatMap((e) => (e.type === "assistant" ? [e.text] : []))
      .join("\n")
      .toLowerCase();
    expect(assistant).not.toContain(SENTENCE);
    for (const w of SUBJECT_WORDS) expect(assistant).not.toContain(w);

    // Chi può aprire l'email legge le frasi nella riga della scheda.
    const laura = await readAs(LAURA, id);
    expect(laura).toContain(SENTENCE);
    expect(laura).toContain("portal sign-in: google accounts only");

    // Marco segue la pagina ma l'email non l'ha ricevuta: «from an email of Laura Costa».
    const check = async () => {
      const marco = await readAs(MARCO, id);
      expect(marco).toContain("ACQ-D5".toLowerCase());
      expect(marco).toContain("from an email of laura costa");
      expect(marco).not.toContain(SENTENCE);
      for (const w of SUBJECT_WORDS) expect(marco).not.toContain(w);
      expect(marco).not.toContain("productpreview");
    };
    await check();
    // Rifiutata: la riga non c'è più, e comunque niente esce.
    setSessionPersonId(LAURA);
    const proposal = (state.conversationEvents.get(id) ?? []).find((e) => e.type === "proposal")!;
    await api.cancelProposal(id, (proposal as { proposalId: string }).proposalId);
    await check();
  });

  it("«cosa è cambiato questa settimana»: Laura legge l'oggetto, Marco «from an email of Laura Costa»", async () => {
    const id = await publicAsk("What changed in the docs this week?", null);
    const saved = (state.conversationEvents.get(id) ?? [])
      .flatMap((e) => (e.type === "assistant" ? [e.text] : []))
      .join("\n")
      .toLowerCase();
    for (const w of SUBJECT_WORDS) expect(saved).not.toContain(w);
    expect(saved).not.toContain("laura costa");

    expect(await readAs(LAURA, id)).toContain("portal sign-in: google accounts only");
    const marco = await readAs(MARCO, id);
    expect(marco).toContain("from an email of laura costa");
    for (const w of SUBJECT_WORDS) expect(marco).not.toContain(w);
    expect(marco).not.toContain("productweek");
  });

  it("chi non legge i Docs di ACQ: nessuna pagina di ACQ nella risposta della settimana", async () => {
    const id = await publicAsk("What changed in the docs this week?", null);
    revokeProjectPermission(MARCO, ACQ, "docs.view" as never);
    setSessionPersonId(MARCO);
    const detail = await api.getConversation(id);
    const text = (detail?.events ?? [])
      .flatMap((e) => (e.type === "assistant" ? [e.text] : []))
      .join("\n")
      .toLowerCase();
    for (const w of ["sign-in", "laura costa", "portal"]) expect(text).not.toContain(w);
  });
});

describe("fix round 1: il riconoscimento non ruba le richieste degli altri intenti", () => {
  it.each([
    "Aggiorna AUD-4 con la mail di Marco",
    "Suggest which backlog items to tackle in AUD",
  ])("«%s» non è un gesto della doc", (text) => {
    expect(recognize(text, new Set(["AUD", "ACQ"]))).not.toBe("productDoc");
  });
});

describe("col budget del mese finito nessuna azione della doc parte", () => {
  it("prima versione, aggiornamento e bozza: il gruppo fallisce e non scrive niente", async () => {
    withoutSeed11b();
    setSessionPersonId(ROBERTA);
    await api.instance.simulateBudgetReached(true);
    const before = JSON.stringify({
      pages: state.productPages,
      revisions: state.productRevisions,
      versions: state.productFirstVersions,
    });
    for (const action of [
      { fn: "writeFirstVersion", args: { projectId: VRD, sources: [{ kind: "email", id: "mm-vrd-booking-rules" }] } },
      { fn: "updateProductPage", args: { pageId: SIGN_IN, source: { kind: "email", id: ACQ_11B.signInEmailId } } },
      { fn: "drawWireframe", args: { pageId: SCREENS, afterId: null } },
    ] as const) {
      const done = executeGroup(LAURA, "cv-11b-panel", [{ ...action, summary: "" } as ProposedAction], "B");
      expect(done, action.fn).toMatchObject({ ok: false, code: "invalid" });
    }
    await whenFirstVersionIdle();
    expect(
      JSON.stringify({
        pages: state.productPages,
        revisions: state.productRevisions,
        versions: state.productFirstVersions,
      }),
    ).toBe(before);
  });
});

describe("revisione finale I1, I2: l'anteprima non promette quello che la pagina ha già", () => {
  const MATTEO = "p-matteo";

  it("I1: la riunione di Bills, la cui domanda c'è già nel seme: niente da chiedere, nessuna scheda", async () => {
    const asked = () => state.productComments.filter((c) => c.question?.factId === "fact-acq-bills-reminder-email");
    expect(asked()).toHaveLength(1);
    const before = state.notifications.length;
    const steps = await respond(
      "Update ACQ-D6 Bills from this meeting",
      as(MATTEO, en, { context: { kind: "mail", threadId: "th-gemini-acq-review" } }),
    );
    expect(proposalOf(steps)).toBeUndefined();
    expect(said(steps)).toContain("already says this");
    expect(said(steps)).not.toMatch(/ask about it/i);
    expect(asked()).toHaveLength(1);
    expect(state.notifications.length).toBe(before);
  });

  it("I2: l'email delle tre foto, già scritta in Features: «already says this», e la conferma vecchia non scrive", async () => {
    const incoming = MAIL_INCOMING.find((m) => m.id === ACQ_11B.incomingEmailId)!;
    state.mailMessages.push({ ...structuredClone(incoming), classification: mailDone([ACQ], "normal") });
    const features = state.productPages.find((p) => p.id === "pp-acq-features")!;
    const block = features.blocks.find((b) => b.id === "blk-acq-features-5")!;
    if (block.type === "table" || !("content" in block)) throw new Error("not a text block");
    block.content = { text: "Fault reports, with up to three photos", marks: [] };
    const steps = await respond(
      "Update ACQ-D4 Features from this email",
      as(MATTEO, en, { context: { kind: "mail", threadId: incoming.threadId } }),
    );
    expect(proposalOf(steps)).toBeUndefined();
    expect(said(steps)).toContain("already says this");
    expect(said(steps)).not.toContain("would change");
    // M7: una scheda nata prima, confermata ora, non dice «fatto» su niente.
    const revisions = state.productRevisions.length;
    const done = run(MATTEO, [
      {
        fn: "updateProductPage",
        args: { pageId: "pp-acq-features", source: { kind: "email", id: ACQ_11B.incomingEmailId } },
        summary: "",
      },
    ]);
    expect(done).toMatchObject({ ok: false, code: "invalid" });
    expect(state.productRevisions.length).toBe(revisions);
  });
});

describe("revisione finale I3: la sezione con un apostrofo", () => {
  it.each([
    ["en", "Client's phase", en],
    ["en", "Client’s phase", en],
    ["it", "Fase dell'utente", it_],
    ["it", "Fase dell’utente", it_],
  ] as const)("%s, «%s»: la frase della pagina trova il titolo e propone le voci", async (_lang, title, t) => {
    const phases = state.productPages.find((p) => p.id === "pp-acq-phases")!;
    const heading = phases.blocks.find((b) => b.type === "heading" && b.content.text === "Phase 1")!;
    if (heading.type !== "heading") throw new Error("no heading");
    heading.content = { text: title, marks: [] };
    // La frase che manda il ⋮⋮ del titolo (`SectionProposeItem`), nella lingua di chi chiede.
    const sentence = t("claude.answers.productDocs.ask.backlogSection", { section: title, code: phases.code });
    const steps = await respond(sentence, as(LAURA, t));
    const card = proposalOf(steps);
    expect(said(steps)).not.toMatch(/has no heading|non ha il titolo/);
    expect(card?.actions.length).toBe(2);
  });
});

describe("revisione finale: gli id delle fonti negli `args` non escono a chi legge", () => {
  async function publicAsk(text: string, context: ContextRef | null, projectId: string) {
    setSessionPersonId(LAURA);
    const c = await api.createConversation({ contextProjectId: projectId });
    await api.sendMessage(c.id, { text }, { context });
    for (let i = 0; i < 10; i++) {
      await api.whenIdle(c.id);
      await new Promise((r) => setTimeout(r, 0));
    }
    await api.setVisibility(c.id, "public", { confirmedProjectIds: [projectId] });
    return c.id;
  }
  const readAs = async (personId: string, id: string) => {
    setSessionPersonId(personId);
    return JSON.stringify(await api.getConversation(id)).toLowerCase();
  };

  it("`updateProductPage`: né Laura né Marco leggono l'id dell'email; il dato salvato lo tiene per la conferma", async () => {
    withoutSeed11b();
    const id = await publicAsk("Update ACQ-D5 Sign-in from this email", { kind: "mail", threadId: SIGN_IN_THREAD }, ACQ);
    const stored = (state.conversationEvents.get(id) ?? []).find((e) => e.type === "proposal")!;
    expect(JSON.stringify(stored)).toContain(ACQ_11B.signInEmailId);
    for (const who of [LAURA, MARCO]) expect(await readAs(who, id)).not.toContain(ACQ_11B.signInEmailId);
  });

  it("`writeFirstVersion`: le fonti scelte non escono come id", async () => {
    const id = await publicAsk("Write the first version of VRD's docs", null, VRD);
    await whenFirstVersionIdle();
    const executed = (state.conversationEvents.get(id) ?? []).find((e) => e.type === "executed")!;
    const sources = (executed as { actions: ProposedAction[] }).actions[0]!.args.sources as { id?: string; fileId?: string }[];
    const ids = sources.map((s) => s.id ?? s.fileId!).filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    const laura = await readAs(LAURA, id);
    for (const sid of ids) expect(laura).not.toContain(sid.toLowerCase());
  });
});
