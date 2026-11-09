import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyActions,
  mail,
  recordDecision,
  releases,
  resetApi,
  setLatency,
  updateTask,
} from "../api";
import type { MailMessage, ProductRevision } from "../model";
import { CLAUDE_ID } from "../seed/people";
import {
  ACQ_11B,
  INCOMING_EMAIL_FACT,
  PREPARED_DECISION,
  PRODUCT_SOURCE_FACTS,
} from "../seed/productDocs/facts";
import { ext, mail as mailOf, person } from "../seed/mail/helpers";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { whenProductClaudeIdle } from "./claude";
import { noteProductSource } from "./sourceEvents";

// I punti in cui una fonte arriva (11b, Task 5) chiamano il motore con i
// fatti del seme: la classificazione di un'email (o dell'email di Gemini di
// una riunione) e l'attribuzione a mano, la registrazione di una decisione,
// la chiusura di una task, il merge di una PR che diventa un rilascio.
// Nessuno passa da `applyProductSource` con fatti suoi: i fatti li sa il
// seme (`PRODUCT_SOURCE_FACTS`), e `noteProductSource` li porta ai progetti
// della fonte che hanno lo spazio Prodotto.

const LAURA = "p-laura";
const MATTEO = "p-matteo";
const ACQ = "prj-acq";
const AUD = "prj-aud";
const MATTEO_BOX = "matteo.conti@example.com";

const as = (personId: string) => setSessionPersonId(personId);
const pageOf = (id: string) => state.productPages.find((p) => p.id === id)!;
const textOf = (pageId: string, blockId: string): string | null => {
  const b = pageOf(pageId).blocks.find((x) => x.id === blockId);
  return b && "content" in b ? b.content.text : null;
};

/** Le revisioni di Claude nate nel test (quelle del seme restano fuori). */
let seeded = new Set<string>();
const newClaudeRevisions = (pageId?: string): ProductRevision[] =>
  state.productRevisions.filter(
    (r) => r.via === "claude" && !seeded.has(r.id) && (pageId === undefined || r.pageId === pageId),
  );
let seededComments = new Set<string>();
const newQuestions = (pageId?: string) =>
  state.productComments.filter(
    (c) =>
      c.question !== undefined &&
      !seededComments.has(c.id) &&
      (pageId === undefined || c.pageId === pageId),
  );

beforeEach(() => {
  resetApi();
  setLatency(0);
  seeded = new Set(state.productRevisions.map((r) => r.id));
  seededComments = new Set(state.productComments.map((c) => c.id));
});
afterEach(async () => {
  await mail.whenMailIdle();
  await whenProductClaudeIdle();
  resetApi();
});

describe("la posta che arriva", () => {
  it("l'email in arrivo di ACQ, classificata in ACQ, porta il suo fatto chiaro: UNA revisione per conto del titolare", async () => {
    as(MATTEO);
    await mail.syncMailbox(MATTEO_BOX);
    await mail.whenMailIdle();
    const m = state.mailMessages.find((x) => x.id === ACQ_11B.incomingEmailId)!;
    expect(m.classification).toMatchObject({ state: "done", projectIds: [ACQ] });
    const revs = newClaudeRevisions(INCOMING_EMAIL_FACT.pageId);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({
      actorId: MATTEO,
      via: "claude",
      kind: "edit",
      source: { kind: "email", id: ACQ_11B.incomingEmailId },
    });
    expect(textOf(INCOMING_EMAIL_FACT.pageId, "blk-acq-features-5")).toBe(
      "Fault reports, with up to three photos",
    );
  });

  it("l'email di Gemini di una riunione di ACQ, letta, porta la sua domanda vaga e il fatto senza ancora non fa niente", async () => {
    as(MATTEO);
    await mail.syncMailbox(MATTEO_BOX);
    await mail.whenMailIdle();
    const phases = "pp-acq-phases";
    const asked = newQuestions(phases);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.anchorId).toBe("blk-acq-phases-5");
    expect(asked[0]!.question).toMatchObject({
      reason: "vague",
      sourceRef: { kind: "meeting", id: ACQ_11B.incomingMeetingId },
    });
    // Il passo tolto da Matteo non torna, e la frase vaga non entra.
    expect(newClaudeRevisions(phases)).toEqual([]);
    expect(textOf(phases, "blk-acq-phases-5")).toBe("Phase 3: a dark appearance");
  });

  it("l'email di Gemini col documento non ancora letto non è ancora una fonte", async () => {
    state.meetingTranscripts.find((t) => t.messageId === ACQ_11B.incomingMeetingId)!.doc =
      "reading";
    as(MATTEO);
    await mail.syncMailbox(MATTEO_BOX);
    await mail.whenMailIdle();
    expect(newQuestions("pp-acq-phases")).toEqual([]);
  });

  it("la stessa email riproposta non scrive una seconda volta", async () => {
    as(MATTEO);
    await mail.syncMailbox(MATTEO_BOX);
    await mail.whenMailIdle();
    noteProductSource({ kind: "email", id: ACQ_11B.incomingEmailId }, [ACQ]);
    noteProductSource({ kind: "meeting", id: ACQ_11B.incomingMeetingId }, [ACQ]);
    expect(newClaudeRevisions(INCOMING_EMAIL_FACT.pageId)).toHaveLength(1);
    expect(newQuestions("pp-acq-phases")).toHaveLength(1);
  });

  it("l'attribuzione a mano di un'email incerta passa dal motore una volta sola", async () => {
    // Un'email che parla di AUD e di ACQ: il modello finto non sceglie.
    const id = "mm-test-uncertain-acq";
    const incoming: MailMessage = mailOf({
      id,
      threadId: `th-${id}`,
      from: ext("Elisa Ferraro", "elisa.ferraro@acquedottocolline.example"),
      to: [person(MATTEO)],
      subject: "The dialer and the Acquedotto portal",
      at: "2026-10-23T11:59:00Z",
      text: "Hi Matteo,\n\nquestions on the dialer and on the Acquedotto portal.\n\nElisa",
      mailboxPersonIds: [MATTEO],
      classification: { state: "pending" },
    });
    state.mailIncoming.push(incoming);
    const key = `email:${id}`;
    // Su un'altra frase: quella del fatto dell'email in arrivo la scrive già lei.
    PRODUCT_SOURCE_FACTS[key] = [
      {
        ...INCOMING_EMAIL_FACT,
        id: "fact-test-uncertain",
        anchorId: "blk-acq-features-4",
        change: {
          kind: "replace",
          text: { text: "Meter readings, sent every month by the customer", marks: [] },
        },
      },
    ];
    try {
      as(MATTEO);
      await mail.syncMailbox(MATTEO_BOX);
      await mail.whenMailIdle();
      const m = state.mailMessages.find((x) => x.id === id)!;
      expect(m.classification).toMatchObject({ projectIds: [], uncertainProjectIds: [AUD, ACQ] });
      const choose = state.mailProposals.find((p) => p.id === `mp-${id}-choose`)!;
      const fromIt = () =>
        newClaudeRevisions().filter((r) => r.source?.kind === "email" && r.source.id === id);
      // Incerta: nessun progetto, quindi niente alla doc.
      expect(fromIt()).toEqual([]);
      await mail.chooseProjectFor(choose.id, ACQ);
      expect(fromIt()).toHaveLength(1);
      // Spostata altrove e riportata in ACQ: la fonte è già passata.
      await mail.reassignMailProposal(choose.id, AUD);
      await mail.reassignMailProposal(choose.id, ACQ);
      expect(fromIt()).toHaveLength(1);
    } finally {
      delete PRODUCT_SOURCE_FACTS[key];
    }
  });
});

describe("il resto delle fonti", () => {
  it("registrare la decisione preparata porta una modifica di Claude con la decisione come fonte", async () => {
    as(LAURA);
    const entry = await recordDecision(ACQ, { ...PREPARED_DECISION });
    const revs = newClaudeRevisions("pp-acq-bills");
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({
      actorId: CLAUDE_ID,
      via: "claude",
      source: { kind: "decision", id: entry.id },
    });
    const bills = pageOf("pp-acq-bills").blocks;
    const after = bills[bills.findIndex((b) => b.id === "blk-acq-bills-3") + 1]!;
    expect("content" in after && after.content.text).toBe(PREPARED_DECISION.decision);
  });

  it("dentro un gruppo di azioni la fonte aspetta l'esito: fallito non tocca la doc, riuscito sì", () => {
    const record = {
      fn: "recordDecision" as const,
      args: { projectId: ACQ, ...PREPARED_DECISION, source: "manual" },
      summary: "",
    };
    const failed = applyActions(LAURA, [record, { fn: "nope" as never, args: {}, summary: "" }]);
    expect(failed.ok).toBe(false);
    expect(state.decisionLog.some((d) => d.title === PREPARED_DECISION.title)).toBe(false);
    expect(newClaudeRevisions()).toEqual([]);
    expect(applyActions(LAURA, [record]).ok).toBe(true);
    expect(newClaudeRevisions("pp-acq-bills")).toHaveLength(1);
  });

  it("un'altra decisione di ACQ, senza fatti nel seme, non tocca la doc", async () => {
    as(LAURA);
    await recordDecision(ACQ, { title: "Something else", decision: "Unrelated to the portal." });
    expect(newClaudeRevisions()).toEqual([]);
    expect(newQuestions()).toEqual([]);
  });

  it("chiudere la task preparata, costruita diversa, porta una domanda `diverges`", async () => {
    as(LAURA);
    const closed = state.statuses.find((s) => s.projectId === ACQ && s.family === "closed")!;
    await updateTask(ACQ_11B.openTaskId, { statusId: closed.id });
    const asked = newQuestions("pp-acq-meter-reading");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ anchorId: "blk-acq-meter-1", authorId: CLAUDE_ID });
    expect(asked[0]!.question).toMatchObject({
      reason: "diverges",
      sourceRef: { kind: "task", id: ACQ_11B.openTaskId },
      recommended: "apply",
    });
    expect(newClaudeRevisions()).toEqual([]);
    // Riaperta e richiusa: la stessa task non chiede due volte.
    const open = state.statuses.find((s) => s.projectId === ACQ && s.family === "active")!;
    await updateTask(ACQ_11B.openTaskId, { statusId: open.id });
    await updateTask(ACQ_11B.openTaskId, { statusId: closed.id });
    expect(newQuestions("pp-acq-meter-reading")).toHaveLength(1);
  });

  it("il merge della PR #77, un rilascio di ACQ, porta un `link_task`", async () => {
    as(LAURA);
    const out = await releases.mergePr(ACQ_11B.releasePrId);
    expect(out).toMatchObject({ ok: true });
    const release = state.releases.find((r) => r.projectId === ACQ)!;
    const revs = newClaudeRevisions("pp-acq-features");
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({
      actorId: CLAUDE_ID,
      source: { kind: "release", id: release.id },
    });
    expect(textOf("pp-acq-features", "blk-acq-features-3")).toBe("Bills, open and paid ACQ-7");
  });
});

describe("noteProductSource", () => {
  it("la stessa fonte arrivata due volte non scrive due volte", () => {
    const ref = { kind: "task" as const, id: ACQ_11B.openTaskId };
    noteProductSource(ref, [ACQ]);
    noteProductSource(ref, [ACQ, ACQ]);
    expect(newQuestions()).toHaveLength(1);
  });

  it("un progetto senza spazio Prodotto, o una fonte senza fatti, non fa niente", () => {
    noteProductSource({ kind: "task", id: ACQ_11B.openTaskId }, [AUD]);
    noteProductSource({ kind: "email", id: "mm-aud-billing-vat" }, [AUD, ACQ]);
    expect(newQuestions()).toEqual([]);
    expect(newClaudeRevisions()).toEqual([]);
    // Il motore non la vede nemmeno: in AUD la fonte non è passata.
    expect(state.productSourcesSeen.has(`task:${ACQ_11B.openTaskId}:${AUD}`)).toBe(false);
  });

  it("una fonte già arrivata nel seme non riscrive niente", () => {
    for (const ref of [
      { kind: "email" as const, id: ACQ_11B.signInEmailId },
      { kind: "meeting" as const, id: ACQ_11B.meetingId },
      { kind: "task" as const, id: ACQ_11B.closedTaskId },
      { kind: "decision" as const, id: ACQ_11B.decisionId },
    ])
      noteProductSource(ref, [ACQ]);
    expect(newQuestions()).toEqual([]);
    expect(newClaudeRevisions()).toEqual([]);
  });
});
