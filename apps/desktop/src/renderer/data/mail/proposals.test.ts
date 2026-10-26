import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { mail, resetApi, setLatency } from "../api";
import { MAIL_CASES } from "../seed/mail";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import type { MailProposal, ProposedAction } from "../types";
import { can, grantProjectRole, viewerFor } from "../viewer";
import { calendarParticipants, permissionForAction } from "./visibility";

const as = (personId: string) => setSessionPersonId(personId);
const AUD = "prj-aud";
const MKX = "prj-mkx";
const STW = "prj-stw";

const SHARED = "mp-aud-billing-vat"; // Giulia e Matteo, Laura in cc: createTask
const HANDED = "mp-stw-release-notes-date"; // passata da Giulia: updateTask t-stw-11
const REVIEW = "mp-aud-weekly-review"; // 4 createTask, l'ultima per Chiara (fuori da AUD)
const CHOOSE = "mp-video-testimonials"; // incerta fra AUD e MKX

const proposal = (id: string): MailProposal => state.mailProposals.find((p) => p.id === id)!;
const message = (id: string) => state.mailMessages.find((m) => m.id === id)!;
const tasksTitled = (title: string) => state.tasks.filter((t) => t.title === title);
const membersOf = (projectId: string) => state.projectsById.get(projectId)!.memberIds;
const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error & { byId?: string | null };
  }
  throw new Error("expected a rejection");
};

/** Una proposta aggiunta dal test, sull'email condivisa (Giulia, Matteo, Laura). */
function addProposal(actions: ProposedAction[], extra: Partial<MailProposal> = {}): string {
  const id = `mp-test-${state.mailProposals.length}`;
  state.mailProposals.push({
    id,
    source: "email",
    sourceId: message(MAIL_CASES.shared).messageId,
    projectId: AUD,
    actions,
    excerpt: "We need the VAT number column for the close on Monday.",
    createdAt: "2026-10-25T10:00:00Z",
    status: "open",
    decidedById: null,
    decidedAt: null,
    resultCodes: [],
    error: null,
    handedAt: null,
    handedById: null,
    ...extra,
  });
  return id;
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-giulia");
});

describe("Proposte della posta: permessi delle azioni", () => {
  it("la mappa delle Global Constraints; «scegli il progetto» non ha permesso", () => {
    expect(permissionForAction("createTask")).toBe("tickets.create");
    expect(permissionForAction("updateTask")).toBe("tickets.edit");
    expect(permissionForAction("createMilestone")).toBe("tickets.edit");
    expect(permissionForAction("addComment")).toBe("tickets.comment");
    expect(permissionForAction("createRequest")).toBe("backlog.create");
    expect(permissionForAction("recordDecision")).toBe("decisions.record");
    expect(permissionForAction("chooseProject")).toBeNull();
  });
});

describe("Proposte della posta: chi la vede", () => {
  it("i destinatari membri del progetto; un destinatario non membro no, né l'admin", async () => {
    // Laura è in cc: tolta da AUD, vede ancora l'email ma non la proposta.
    const aud = state.projectsById.get(AUD)!;
    aud.memberIds = aud.memberIds.filter((id) => id !== "p-laura");
    const sourceId = proposal(SHARED).sourceId;

    as("p-giulia");
    expect((await mail.listMailProposals({ sourceId })).map((v) => v.proposal.id)).toEqual([
      SHARED,
    ]);
    as("p-laura");
    await expect(mail.getMailThread(message(MAIL_CASES.shared).threadId)).resolves.toBeDefined();
    expect(await mail.listMailProposals({ sourceId })).toEqual([]);
    await expect(mail.getMailProposal(SHARED)).rejects.toThrow("not_found");
    expect(
      (await mail.listMailThreads()).find((r) => r.threadId === "th-aud-billing-vat"),
    ).toMatchObject({ openProposals: 0 });
    // L'admin vede AUD, ma non è destinatario: la proposta per lui non esiste.
    as("p-roberta");
    expect(visibleProjectIds("p-roberta").has(AUD)).toBe(true);
    await expect(mail.getMailProposal(SHARED)).rejects.toThrow("not_found");
    // Un collega di AUD non destinatario (Marco): nemmeno.
    as("p-marco");
    await expect(mail.getMailProposal(SHARED)).rejects.toThrow("not_found");
  });

  it("un admin destinatario ma non membro non la vede: conta `memberIds`, non i progetti visibili", async () => {
    const m = message(MAIL_CASES.shared);
    m.cc = [
      ...(m.cc ?? []),
      { name: "Roberta Fontana", email: "r@example.com", personId: "p-roberta" },
    ];
    expect(membersOf(AUD)).not.toContain("p-roberta");
    as("p-roberta");
    await expect(mail.getMailThread(m.threadId)).resolves.toBeDefined();
    await expect(mail.getMailProposal(SHARED)).rejects.toThrow("not_found");
    expect(await mail.listMailDecisions()).not.toContainEqual(
      expect.objectContaining({ proposal: expect.objectContaining({ id: SHARED }) }),
    );
  });

  it("un Viewer la vede: non può confermarla, può passarla al progetto", async () => {
    grantProjectRole("p-giulia", AUD, "viewer");
    const view = await mail.getMailProposal(SHARED);
    expect(view).toMatchObject({ canConfirm: false, canHand: true, decidedBy: null });
    expect(await errorOf(mail.confirmMailProposal(SHARED))).toMatchObject({
      message: "forbidden",
    });
    expect(tasksTitled("Add the VAT number column to the billing export")).toHaveLength(0);
    expect(proposal(SHARED).status).toBe("open");

    await mail.handMailProposal(SHARED);
    expect(proposal(SHARED)).toMatchObject({
      status: "handed",
      decidedById: "p-giulia",
      handedById: "p-giulia",
    });
    expect(proposal(SHARED).handedAt).not.toBeNull();
    // Chi può confermare non la passa: la conferma.
    as("p-matteo");
    expect(await mail.getMailProposal(SHARED)).toMatchObject({ canConfirm: true, canHand: false });
  });

  it("passata al progetto: la vede un Project Lead non destinatario, con l'estratto e non il messaggio", async () => {
    as("p-laura"); // Project Lead in STW, non destinataria dell'email di Ivo
    const view = await mail.getMailProposal(HANDED);
    expect(view.proposal.excerpt).toMatch(/release notes is approved/);
    expect(view).toMatchObject({
      canConfirm: true,
      canHand: false,
      decidedBy: { personId: "p-giulia", name: "Giulia Ferri" },
    });
    await expect(mail.getMailThread(message(MAIL_CASES.handed).threadId)).rejects.toThrow(
      "not_found",
    );
    expect((await mail.listMailDecisions()).map((v) => v.proposal.id)).toContain(HANDED);
    // Sara (Contributor in STW, niente `tickets.edit`): non la vede.
    as("p-sara");
    await expect(mail.getMailProposal(HANDED)).rejects.toThrow("not_found");
    // Giulia l'ha passata: la vede, ma non è più lei a decidere.
    as("p-giulia");
    expect(await mail.getMailProposal(HANDED)).toMatchObject({ canConfirm: false, canHand: false });
    expect((await mail.listMailDecisions()).map((v) => v.proposal.id)).not.toContain(HANDED);
    expect(await errorOf(mail.ignoreMailProposal(HANDED))).toMatchObject({ message: "forbidden" });

    as("p-laura");
    expect(await mail.confirmMailProposal(HANDED)).toEqual({
      status: "confirmed",
      resultCodes: ["STW-11"],
    });
    expect(state.tasksById.get("t-stw-11")!.dueDate).toBe(
      (proposal(HANDED).actions[0]!.args.patch as { dueDate: string }).dueDate,
    );
    // Decisa, resta passata: Laura la rilegge e vede che l'ha decisa lei.
    expect(await mail.getMailProposal(HANDED)).toMatchObject({
      proposal: { status: "confirmed", handedById: "p-giulia" },
      decidedBy: { personId: "p-laura", name: "Laura Costa" },
      canConfirm: false,
    });
    expect(await errorOf(mail.ignoreMailProposal(HANDED))).toMatchObject({
      message: "already_handled",
      byId: "p-laura",
    });
    // Un secondo Project Lead di STW, non destinatario, arriva tardi: già decisa, e da chi.
    grantProjectRole("p-simone", STW, "project_lead");
    as("p-simone");
    expect(await errorOf(mail.confirmMailProposal(HANDED))).toMatchObject({
      message: "already_handled",
      byId: "p-laura",
    });
    as("p-giulia");
    expect(await mail.getMailProposal(HANDED)).toMatchObject({
      proposal: { status: "confirmed", handedAt: expect.any(String), handedById: "p-giulia" },
      decidedBy: { personId: "p-laura" },
    });
  });

  it("passata con azioni miste: la vede chi ha il permesso di TUTTE, non solo della prima", async () => {
    const id = addProposal(
      [
        { fn: "createTask", args: { projectId: AUD, title: "Mixed task" }, summary: "Create" },
        { fn: "recordDecision", args: { projectId: AUD }, summary: "Record" },
      ],
      {
        status: "handed",
        decidedById: "p-giulia",
        decidedAt: "2026-10-25T10:30:00Z",
        handedAt: "2026-10-25T10:30:00Z",
        handedById: "p-giulia",
      },
    );
    // Stefano: Contributor in AUD (crea task, non registra decisioni), non destinatario.
    grantProjectRole("p-stefano", AUD, "contributor");
    as("p-stefano");
    await expect(mail.getMailProposal(id)).rejects.toThrow("not_found");
    // Marco: Developer in AUD, entrambi i permessi.
    as("p-marco");
    expect(await mail.getMailProposal(id)).toMatchObject({ canConfirm: true });
  });

  it("le aperte che vedo entrano in «Da decidere», dalla più vecchia", async () => {
    const ids = (await mail.listMailDecisions()).map((v) => v.proposal.id);
    // Anche le proposte di calendario (Task 5), nella lettura delle 7: la
    // pianificazione di MKX, il promemoria della revisione di AUD e la
    // scadenza dei visual di MKX.
    expect(ids).toEqual([
      SHARED,
      CHOOSE,
      REVIEW,
      "mp-ser-ev-mkx-planning-2026-10-26",
      "mp-ser-ev-aud-review-2026-10-29",
      "mp-cal-ev-mkx-visuals-deadline",
      "mp-stw-copy-freeze",
    ]);
    as("p-roberta");
    // L'admin non vede le aperte (non è destinatario); la passata sì: ha il permesso.
    expect((await mail.listMailDecisions()).map((v) => v.proposal.id)).toEqual([HANDED]);
  });
});

describe("Proposte della posta: con chi è condivisa", () => {
  it("sharedWith: i destinatari nelle intestazioni che la vedono, tranne chi guarda", async () => {
    setSessionPersonId("p-giulia");
    const vat = await mail.getMailProposal("mp-aud-billing-vat");
    expect(vat.sharedWith.map((x) => x.name)).toEqual(["Matteo Conti", "Laura Costa"]);
    // Il mittente esterno non c'è; chi non è membro del progetto nemmeno.
    const review = await mail.getMailProposal("mp-aud-weekly-review");
    expect(review.sharedWith.map((x) => x.personId)).toEqual(["p-matteo", "p-laura", "p-marco"]);
  });

  it("una proposta passata letta per il solo estratto non dice a chi era l'email", async () => {
    setSessionPersonId("p-roberta");
    const handed = await mail.getMailProposal("mp-stw-release-notes-date");
    expect(handed.sharedWith).toEqual([]);
  });
});

describe("Proposte della posta: due persone quasi insieme (Review Focus 2)", () => {
  it("la seconda riceve already_handled con chi ha deciso; una sola task", async () => {
    setLatency(20);
    as("p-giulia");
    const first = mail.confirmMailProposal(SHARED);
    as("p-matteo");
    const second = mail.confirmMailProposal(SHARED);
    expect(await first).toMatchObject({ status: "confirmed" });
    expect(await errorOf(second)).toMatchObject({ message: "already_handled", byId: "p-giulia" });
    expect(tasksTitled("Add the VAT number column to the billing export")).toHaveLength(1);
    setLatency(0);
    expect(await mail.getMailProposal(SHARED)).toMatchObject({
      proposal: { status: "confirmed", resultCodes: [expect.stringMatching(/^AUD-/)] },
      decidedBy: { personId: "p-giulia", name: "Giulia Ferri" },
      canConfirm: false,
      canHand: false,
    });
  });

  it("conferma e «Ignora» quasi insieme: un solo esito, l'altro already_handled", async () => {
    setLatency(20);
    as("p-giulia");
    const confirm = mail.confirmMailProposal(SHARED);
    as("p-matteo");
    const ignore = mail.ignoreMailProposal(SHARED);
    const [c, i] = await Promise.allSettled([confirm, ignore]);
    expect(c).toMatchObject({ status: "fulfilled", value: { status: "confirmed" } });
    expect(i).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "already_handled", byId: "p-giulia" }),
    });
    expect(proposal(SHARED)).toMatchObject({ status: "confirmed", decidedById: "p-giulia" });
    expect(tasksTitled("Add the VAT number column to the billing export")).toHaveLength(1);
  });

  it("una ignorata chiude per tutti: chi arriva dopo trova already_handled", async () => {
    as("p-matteo");
    await mail.ignoreMailProposal(SHARED);
    as("p-giulia");
    expect(await errorOf(mail.confirmMailProposal(SHARED))).toMatchObject({
      message: "already_handled",
      byId: "p-matteo",
    });
    expect(await errorOf(mail.handMailProposal(SHARED))).toMatchObject({
      message: "already_handled",
    });
    expect(await mail.getMailProposal(SHARED)).toMatchObject({
      proposal: { status: "ignored" },
      decidedBy: { personId: "p-matteo" },
    });
  });
});

describe("Proposte della posta: conferma", () => {
  it("conferma parziale: solo le azioni scelte, gli indici ricordati", async () => {
    as("p-matteo");
    const out = await mail.confirmMailProposal(REVIEW, { actionIndexes: [2, 0] });
    expect(out).toMatchObject({ status: "confirmed" });
    expect(out.status === "confirmed" && out.resultCodes).toHaveLength(2);
    expect(tasksTitled("Send Sofia the revised go-live plan in writing")).toHaveLength(1);
    expect(
      tasksTitled("Measure the dashboard load time of the three largest accounts"),
    ).toHaveLength(1);
    expect(tasksTitled("Share the dialer acceptance checklist with the client")).toHaveLength(0);
    expect(tasksTitled("Visuals for the launch announcement")).toHaveLength(0);
    expect(proposal(REVIEW).confirmedActions).toEqual([0, 2]);
    expect(await errorOf(mail.confirmMailProposal(REVIEW, { actionIndexes: [] }))).toBeDefined();
  });

  it("i campi modificati si applicano; progetto e oggetto no", async () => {
    await expect(
      mail.confirmMailProposal(SHARED, { edits: { 0: { projectId: MKX } } }),
    ).rejects.toThrow("invalid: edits");
    expect(proposal(SHARED).status).toBe("open");
    await mail.confirmMailProposal(SHARED, {
      edits: { 0: { title: "VAT column in the billing export", assigneeId: "p-alessia" } },
    });
    const [task] = tasksTitled("VAT column in the billing export");
    expect(task).toMatchObject({
      projectId: AUD,
      assigneeId: "p-alessia",
      createdById: "p-giulia",
    });
    expect(tasksTitled("Add the VAT number column to the billing export")).toHaveLength(0);
  });

  it("tutto o niente: un'azione che fallisce non lascia nulla, e la proposta è fallita", async () => {
    const id = addProposal([
      {
        fn: "createTask",
        args: { projectId: AUD, title: "Half of a proposal" },
        summary: "Create in AUD",
      },
      // Un titolo vuoto: la mutazione la rifiuta a metà esecuzione.
      { fn: "createTask", args: { projectId: AUD, title: "  " }, summary: "Create in AUD" },
    ]);
    expect(await mail.confirmMailProposal(id)).toEqual({ status: "failed", error: "invalid" });
    expect(tasksTitled("Half of a proposal")).toHaveLength(0);
    expect(proposal(id)).toMatchObject({ status: "failed", error: "invalid" });
  });

  it("ciò che nasce, nasce nel progetto della proposta; ciò che si tocca dev'essere suo", async () => {
    as("p-matteo"); // in AUD e MKX, Project Lead
    const create = addProposal([
      { fn: "createTask", args: { projectId: MKX, title: "Elsewhere?" }, summary: "Create" },
    ]);
    await mail.confirmMailProposal(create);
    expect(tasksTitled("Elsewhere?")).toEqual([expect.objectContaining({ projectId: AUD })]);
    // Una task di un altro progetto (STW-11) non si aggiorna né si commenta da qui.
    const update = addProposal([
      { fn: "updateTask", args: { id: "t-stw-11", patch: { dueDate: null } }, summary: "Update" },
    ]);
    const comment = addProposal([
      { fn: "addComment", args: { taskId: "t-stw-11", body: "Hi" }, summary: "Comment" },
    ]);
    const missing = addProposal([
      { fn: "addComment", args: { taskId: "t-nope", body: "Hi" }, summary: "Comment" },
    ]);
    const due = state.tasksById.get("t-stw-11")!.dueDate;
    for (const id of [update, comment, missing]) {
      await expect(mail.confirmMailProposal(id)).rejects.toThrow("invalid: target");
      expect(proposal(id).status).toBe("open");
    }
    expect(state.tasksById.get("t-stw-11")!.dueDate).toBe(due);
  });

  it("persone sconosciute: invalid: assignee, nulla creato né concesso", async () => {
    as("p-matteo");
    await expect(
      mail.confirmMailProposal(REVIEW, { addOutsiders: ["p-chiara", "p-ghost"] }),
    ).rejects.toThrow("invalid: assignee");
    await expect(
      mail.confirmMailProposal(REVIEW, {
        addOutsiders: ["p-chiara"],
        edits: { 0: { assigneeId: "p-ghost" } },
      }),
    ).rejects.toThrow("invalid: assignee");
    expect(tasksTitled("Visuals for the launch announcement")).toHaveLength(0);
    expect(membersOf(AUD)).not.toContain("p-chiara");
    expect(membersOf(AUD)).not.toContain("p-ghost");
    expect(can(viewerFor("p-chiara"), "tickets.create", AUD)).toBe(false);
    expect(proposal(REVIEW).status).toBe("open");
  });

  it("modifiche che non sono oggetti: invalid: edits, senza eccezioni di tipo", async () => {
    const bad = [
      "title",
      { 0: "title" },
      { 0: null },
      { 0: ["title"] },
      { 0: { patch: 5 } },
    ] as unknown as Record<number, Record<string, unknown>>[];
    for (const edits of bad) {
      await expect(mail.confirmMailProposal(SHARED, { edits })).rejects.toThrow("invalid: edits");
    }
    expect(proposal(SHARED).status).toBe("open");
    expect(tasksTitled("Add the VAT number column to the billing export")).toHaveLength(0);
  });

  it("«scegli il progetto» non si conferma: si sceglie", async () => {
    expect(await mail.getMailProposal(CHOOSE)).toMatchObject({ canConfirm: false, canHand: false });
    await expect(mail.confirmMailProposal(CHOOSE)).rejects.toThrow("invalid_action");
    await expect(mail.handMailProposal(CHOOSE)).rejects.toThrow("invalid_action");
  });
});

describe("Proposte della posta: incaricato fuori dal progetto", () => {
  it("senza project.members.manage → forbidden e nulla creato; senza scelta → invalid", async () => {
    as("p-marco"); // Developer in AUD, destinatario delle note di Gemini
    const view = await mail.getMailProposal(REVIEW);
    expect(view.outsiders).toEqual([{ personId: "p-chiara", name: "Chiara Lombardi" }]);
    expect(view.canConfirm).toBe(true);
    expect(can(viewerFor("p-marco"), "project.members.manage", AUD)).toBe(false);

    expect(
      await errorOf(mail.confirmMailProposal(REVIEW, { addOutsiders: ["p-chiara"] })),
    ).toMatchObject({ message: "forbidden" });
    await expect(mail.confirmMailProposal(REVIEW)).rejects.toThrow("invalid: assignee");
    expect(tasksTitled("Visuals for the launch announcement")).toHaveLength(0);
    expect(tasksTitled("Send Sofia the revised go-live plan in writing")).toHaveLength(0);
    expect(membersOf(AUD)).not.toContain("p-chiara");
    expect(proposal(REVIEW).status).toBe("open");

    // Sceglie di lasciarla senza incaricato.
    await mail.confirmMailProposal(REVIEW, { edits: { 3: { assigneeId: null } } });
    expect(tasksTitled("Visuals for the launch announcement")[0]!.assigneeId).toBeNull();
    expect(membersOf(AUD)).not.toContain("p-chiara");
  });

  it("con il permesso: Chiara entra in AUD come Contributor ed è incaricata; resetApi lo annulla", async () => {
    as("p-matteo"); // Project Lead in AUD
    expect(visibleProjectIds("p-chiara").has(AUD)).toBe(false);
    const out = await mail.confirmMailProposal(REVIEW, { addOutsiders: ["p-chiara"] });
    expect(out.status === "confirmed" && out.resultCodes).toHaveLength(4);
    const [task] = tasksTitled("Visuals for the launch announcement");
    expect(task).toMatchObject({ projectId: AUD, assigneeId: "p-chiara" });
    expect(membersOf(AUD)).toContain("p-chiara");
    expect(visibleProjectIds("p-chiara").has(AUD)).toBe(true);
    const chiara = viewerFor("p-chiara");
    expect(can(chiara, "tickets.create", AUD)).toBe(true);
    expect(can(chiara, "tickets.edit", AUD)).toBe(false); // Contributor, non di più

    resetApi();
    expect(membersOf(AUD)).not.toContain("p-chiara");
    expect(visibleProjectIds("p-chiara").has(AUD)).toBe(false);
    expect(can(viewerFor("p-chiara"), "tickets.create", AUD)).toBe(false);
  });

  it("un'azione che fallisce non aggiunge nessuno", async () => {
    as("p-matteo");
    const id = addProposal([
      {
        fn: "createTask",
        args: { projectId: AUD, title: "Brief for Chiara", assigneeId: "p-chiara" },
        summary: "Create in AUD",
      },
      { fn: "createTask", args: { projectId: AUD, title: "" }, summary: "Create in AUD" },
    ]);
    expect(await mail.confirmMailProposal(id, { addOutsiders: ["p-chiara"] })).toMatchObject({
      status: "failed",
    });
    expect(membersOf(AUD)).not.toContain("p-chiara");
    expect(can(viewerFor("p-chiara"), "tickets.create", AUD)).toBe(false);
  });
});

describe("Proposte della posta: registro decisioni e traguardi", () => {
  it("recordDecision scrive con origine email e testo da template, mai quello del modello", async () => {
    const id = addProposal([
      {
        fn: "recordDecision",
        args: { projectId: AUD, title: "MODEL TITLE", decision: "MODEL DECISION" },
        summary: "Record the decision",
      },
    ]);
    // Giulia è Contributor in AUD: niente `decisions.record`.
    expect(await errorOf(mail.confirmMailProposal(id))).toMatchObject({ message: "forbidden" });
    as("p-matteo");
    const before = state.decisionLog.length;
    await mail.confirmMailProposal(id);
    expect(state.decisionLog).toHaveLength(before + 1);
    const entry = state.decisionLog.at(-1)!;
    const m = message(MAIL_CASES.shared);
    expect(entry).toMatchObject({
      projectId: AUD,
      source: "email",
      decidedById: "p-matteo",
      title: i18n.t("claude.decisionLog.emailTitle", { subject: m.subject }),
      decision: i18n.t("claude.decisionLog.emailDecision", {
        sender: m.from.name,
        excerpt: proposal(id).excerpt,
      }),
    });
    expect(JSON.stringify(entry)).not.toMatch(/MODEL/);
  });

  it("createMilestone crea il traguardo con tickets.edit", async () => {
    const id = addProposal([
      {
        fn: "createMilestone",
        args: { projectId: AUD, name: "Billing close", dueDate: "2026-10-26" },
        summary: "Milestone",
      },
    ]);
    expect(await errorOf(mail.confirmMailProposal(id))).toMatchObject({ message: "forbidden" });
    as("p-matteo");
    await mail.confirmMailProposal(id);
    expect(state.milestones.filter((m) => m.name === "Billing close")).toEqual([
      expect.objectContaining({ projectId: AUD, dueDate: "2026-10-26" }),
    ]);
  });
});

describe("Proposte della posta: scegliere e spostare il progetto", () => {
  it("si sceglie fra i candidati; la seconda scelta è already_handled", async () => {
    // Matteo esce da MKX: della scelta vede solo AUD.
    const mkx = state.projectsById.get(MKX)!;
    mkx.memberIds = mkx.memberIds.filter((id) => id !== "p-matteo");
    as("p-matteo");
    const args = (await mail.getMailProposal(CHOOSE)).proposal.actions[0]!.args;
    expect(args.projectIds).toEqual([AUD]);
    expect(Object.keys(args.actionsByProject as object)).toEqual([AUD]);
    await expect(mail.chooseProjectFor(CHOOSE, MKX)).rejects.toThrow("not_found");
    await expect(mail.chooseProjectFor(CHOOSE, STW)).rejects.toThrow("not_found");

    as("p-giulia");
    await mail.chooseProjectFor(CHOOSE, MKX);
    expect(proposal(CHOOSE)).toMatchObject({ projectId: MKX, projectChosenById: "p-giulia" });
    expect(proposal(CHOOSE).actions.map((a) => [a.fn, a.args.projectId])).toEqual([
      ["createTask", MKX],
    ]);
    expect(message(MAIL_CASES.uncertain).classification).toMatchObject({
      projectIds: [MKX],
      uncertainProjectIds: [],
    });
    as("p-matteo"); // non è più in MKX: la proposta non la vede più
    await expect(mail.getMailProposal(CHOOSE)).rejects.toThrow("not_found");
    mkx.memberIds.push("p-matteo");
    expect(await errorOf(mail.chooseProjectFor(CHOOSE, AUD))).toMatchObject({
      message: "already_handled",
      byId: "p-giulia",
    });

    as("p-giulia"); // Project Lead in MKX
    const out = await mail.confirmMailProposal(CHOOSE);
    expect(out.status === "confirmed" && out.resultCodes[0]).toMatch(/^MKX-/);
  });

  it("spostare: solo un destinatario, su un progetto di cui è membro, solo azioni portabili", async () => {
    await mail.reassignMailProposal(SHARED, MKX);
    expect(proposal(SHARED).projectId).toBe(MKX);
    expect(proposal(SHARED).actions[0]!.args.projectId).toBe(MKX);
    expect(message(MAIL_CASES.shared).classification).toMatchObject({ projectIds: [MKX] });
    // Laura (in cc) non è in MKX: ora non la vede.
    as("p-laura");
    await expect(mail.getMailProposal(SHARED)).rejects.toThrow("not_found");

    as("p-giulia");
    const outside = state.projects.find((p) => !p.memberIds.includes("p-giulia"))!.id;
    await expect(mail.reassignMailProposal("mp-stw-copy-freeze", outside)).rejects.toThrow(
      "not_found",
    );
    await expect(mail.reassignMailProposal(HANDED, AUD)).rejects.toThrow("already_handled");
    const update = addProposal([
      { fn: "updateTask", args: { id: "t-aud-9", patch: { dueDate: null } }, summary: "Update" },
    ]);
    await expect(mail.reassignMailProposal(update, MKX)).rejects.toThrow("invalid_action");
  });
});

describe("Proposte della posta: calendario", () => {
  const original = calendarParticipants.of;
  afterEach(() => {
    calendarParticipants.of = original;
  });

  it("la vede il partecipante membro; non si passa al progetto", async () => {
    calendarParticipants.of = (eventId) => (eventId === "ev-deadline" ? ["p-giulia"] : []);
    grantProjectRole("p-giulia", AUD, "viewer"); // non può confermare: passarla sarebbe la via
    const id = addProposal(
      [
        {
          fn: "createMilestone",
          args: { projectId: AUD, name: "Go-live", dueDate: "2026-11-02" },
          summary: "Milestone",
        },
      ],
      { source: "calendar", sourceId: "ev-deadline" },
    );
    expect(await mail.getMailProposal(id)).toMatchObject({ canConfirm: false, canHand: false });
    await expect(mail.handMailProposal(id)).rejects.toThrow("invalid_action");
    expect(proposal(id).status).toBe("open");
    as("p-marco"); // membro di AUD, non partecipante
    await expect(mail.getMailProposal(id)).rejects.toThrow("not_found");
  });
});
