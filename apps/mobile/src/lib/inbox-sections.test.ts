import type { InboxItem, Reader } from "@stubwise/shared";
import { hasDecisionAction, isAdminGatedKind, sectionize } from "./inbox-sections";

const MEMBER = { role: "member" as const };
const ADMIN = { role: "admin" as const };

function item(overrides: Partial<Reader<InboxItem>> & Pick<InboxItem, "id" | "kind">): Reader<InboxItem> {
  return {
    status: "open",
    text: "evento di test",
    actions: [],
    projectId: null,
    ticketId: null,
    jobId: null,
    createdAt: "2026-09-02T09:00:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    ...overrides,
  } as Reader<InboxItem>;
}

const QUESTION = item({ id: "q1", kind: "job.awaiting_input", actions: ["answer", "open", "snooze"] });
const PULSE = item({ id: "p1", kind: "project.pulse", actions: ["answer", "open", "snooze", "handled"] });
const PLAN_AS_ADMIN = item({
  id: "pr1",
  kind: "job.plan_review",
  actions: ["approve_plan", "reject_plan", "open", "snooze", "handled"],
});
const PLAN_AS_MEMBER = item({ id: "pr1", kind: "job.plan_review", actions: ["open", "snooze", "handled"] });
const BUDGET_AS_ADMIN = item({ id: "b1", kind: "job.budget_held", actions: ["relaunch", "open", "snooze", "handled"] });
const BUDGET_AS_MEMBER = item({ id: "b1", kind: "job.budget_held", actions: ["open", "snooze", "handled"] });
const FAILED = item({ id: "f1", kind: "job.failed", actions: ["relaunch", "open", "snooze", "handled"] });
const PR_OPENED = item({ id: "pro1", kind: "job.pr_opened", actions: ["open", "snooze", "handled"] });
const TICKET_CREATED = item({ id: "t1", kind: "ticket.created", actions: ["open", "snooze", "handled"] });
const HANDLED_ITEM = item({ id: "h1", kind: "job.failed", status: "handled", actions: [] });
/**
 * Un kind che questa build non conosce (`readerSchema` lo rende `__unknown__`):
 * dalla fase 5 è il caso di `project.brief` su un'app già installata.
 */
const UNKNOWN_KIND = item({
  id: "uk1",
  kind: "__unknown__" as InboxItem["kind"],
  actions: ["open", "snooze", "handled"],
});
/** Lo stesso brief visto da una build che il kind lo CONOSCE (ondata 2). */
const BRIEF = item({ id: "wb1", kind: "project.brief", actions: ["open", "snooze", "handled"] });

describe("sectionize", () => {
  test("una domanda dell'agente e una proposta del pulse bloccano il viewer, per qualunque ruolo", () => {
    for (const viewer of [MEMBER, ADMIN]) {
      const result = sectionize([QUESTION, PULSE], viewer);
      expect(result.blocksYou.map((i) => i.id)).toEqual(["q1", "p1"]);
      expect(result.onlyYouMaintainer).toEqual([]);
      expect(result.waitingOthers).toEqual([]);
      expect(result.fromProjects).toEqual([]);
    }
  });

  test("un kind SCONOSCIUTO (es. project.brief da un server più nuovo) finisce in 'Dai progetti'", () => {
    for (const viewer of [MEMBER, ADMIN]) {
      const result = sectionize([UNKNOWN_KIND], viewer);
      expect(result.fromProjects.map((i) => i.id)).toEqual(["uk1"]);
      expect(result.blocksYou).toEqual([]);
      expect(result.onlyYouMaintainer).toEqual([]);
      // NON "in attesa di altri": non è una decisione riservata a un maintainer,
      // e mostrarla lì suggerirebbe che qualcuno debba fare qualcosa.
      expect(result.waitingOthers).toEqual([]);
    }
  });

  test("il brief settimanale è un aggiornamento 'dai progetti', per qualunque ruolo", () => {
    for (const viewer of [MEMBER, ADMIN]) {
      const result = sectionize([BRIEF], viewer);
      expect(result.fromProjects.map((i) => i.id)).toEqual(["wb1"]);
      expect(result.blocksYou).toEqual([]);
      expect(result.onlyYouMaintainer).toEqual([]);
      expect(result.waitingOthers).toEqual([]);
    }
  });

  test("un piano da approvare va da 'solo tu' per l'admin che lo può approvare", () => {
    const result = sectionize([PLAN_AS_ADMIN], ADMIN);
    expect(result.onlyYouMaintainer.map((i) => i.id)).toEqual(["pr1"]);
    expect(result.blocksYou).toEqual([]);
    expect(result.waitingOthers).toEqual([]);
  });

  test("lo STESSO piano, per l'operatore che l'ha chiesto (nessun approve_plan nelle sue actions), va in 'in attesa di altri'", () => {
    const result = sectionize([PLAN_AS_MEMBER], MEMBER);
    expect(result.waitingOthers.map((i) => i.id)).toEqual(["pr1"]);
    expect(result.blocksYou).toEqual([]);
    expect(result.onlyYouMaintainer).toEqual([]);
  });

  test("job.budget_held: stessa dualità admin/operatore di job.plan_review", () => {
    expect(sectionize([BUDGET_AS_ADMIN], ADMIN).onlyYouMaintainer.map((i) => i.id)).toEqual(["b1"]);
    expect(sectionize([BUDGET_AS_MEMBER], MEMBER).waitingOthers.map((i) => i.id)).toEqual(["b1"]);
  });

  test("un lavoro fallito con relaunch disponibile blocca il viewer (non è admin-gated)", () => {
    const result = sectionize([FAILED], MEMBER);
    expect(result.blocksYou.map((i) => i.id)).toEqual(["f1"]);
  });

  test("PR aperta e nuovo ticket, senza nessuna decisione, finiscono fra gli aggiornamenti dai progetti", () => {
    const result = sectionize([PR_OPENED, TICKET_CREATED], MEMBER);
    expect(result.fromProjects.map((i) => i.id)).toEqual(["pro1", "t1"]);
  });

  test("le righe non aperte (già gestite) sono escluse da ogni sezione", () => {
    const result = sectionize([HANDLED_ITEM], MEMBER);
    expect(result.blocksYou).toEqual([]);
    expect(result.onlyYouMaintainer).toEqual([]);
    expect(result.waitingOthers).toEqual([]);
    expect(result.fromProjects).toEqual([]);
  });

  test("l'ordine dentro ciascuna sezione rispecchia l'ordine di arrivo", () => {
    const second = item({ id: "f2", kind: "job.failed", actions: ["relaunch", "open", "snooze"] });
    const result = sectionize([FAILED, second], MEMBER);
    expect(result.blocksYou.map((i) => i.id)).toEqual(["f1", "f2"]);
  });

  // Mutazione da rompere apposta: se `hasDecisionAction` guardasse `includes("open")`
  // invece delle azioni decisionali, OGNI riga (che ha sempre `open`) finirebbe
  // per essere considerata "decisionale" e la sezione "Dai progetti" resterebbe
  // vuota per sempre.
  test("hasDecisionAction è vera SOLO per le azioni decisionali, non per l'igiene (open/snooze/handled)", () => {
    expect(hasDecisionAction(item({ id: "x", kind: "ticket.created", actions: ["open", "snooze", "handled"] }))).toBe(
      false,
    );
    expect(hasDecisionAction(item({ id: "x", kind: "job.failed", actions: ["relaunch"] }))).toBe(true);
  });

  // Mutazione da rompere apposta: se `ADMIN_GATED_KINDS` includesse anche
  // "job.failed" (o un kind qualunque non riservato al maintainer), un lavoro
  // fallito visto da un operatore finirebbe silenziosamente in "in attesa di
  // altri" invece che in "dai progetti" — la card sparirebbe dalla sezione
  // giusta senza che nessun test lo notasse se questo caso non fosse esplicito.
  test("isAdminGatedKind è vera solo per job.plan_review e job.budget_held", () => {
    expect(isAdminGatedKind("job.plan_review")).toBe(true);
    expect(isAdminGatedKind("job.budget_held")).toBe(true);
    expect(isAdminGatedKind("job.failed")).toBe(false);
    expect(isAdminGatedKind("job.held")).toBe(false);
  });
});
