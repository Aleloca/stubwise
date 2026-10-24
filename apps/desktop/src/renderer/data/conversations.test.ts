import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addComment,
  answerQuestion,
  archiveConversation,
  cancelProposal,
  closeRefine,
  confirmProposal,
  continueConversation,
  createConversation,
  createRequest,
  decidePlan,
  deleteConversation,
  editProposal,
  getConversation,
  listCommands,
  listConversations,
  listPeopleActivity,
  onConversationChange,
  preApprovePlan,
  relaunchWithInstructions,
  renameConversation,
  requestChanges,
  resetApi,
  resumeCorrection,
  revokePlanApproval,
  runScript,
  sendMessage,
  setLatency,
  setVisibility,
  startRefineConversation,
  startRun,
  stop,
  stopAndSend,
  updateTask,
  subscribe,
  whenIdle,
} from "./api";
import { TODAY } from "./seed/dates";
import { setSessionPersonId } from "./session";
import { state } from "./store";
import type { ConversationEvent, ConversationFilter, ProposedAction } from "./types";
import { grantInstancePermission, grantProjectRole, revokeInstancePermission } from "./viewer";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const as = (personId: string) => setSessionPersonId(personId);

/** Aspetta che Claude abbia finito: anche il seguito accodato dopo uno script. */
async function settle(id: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await whenIdle(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const eventsOf = (id: string) => structuredClone(state.conversationEvents.get(id) ?? []);
const conv = (id: string) => state.conversations.find((c) => c.id === id)!;
const task = (id: string) => state.tasksById.get(id)!;

async function ids(filter: ConversationFilter): Promise<string[]> {
  return (await listConversations(filter)).map((c) => c.id);
}

async function allVisible(): Promise<string[]> {
  const scopes: ConversationFilter["scope"][] = ["live", "mine", "public", "finished"];
  const lists = await Promise.all(scopes.map((scope) => ids({ scope, includeOlder: true })));
  return lists.flat();
}

/** Mette una proposta nel flusso, come farebbe Claude. */
async function propose(
  conversationId: string,
  requesterId: string,
  actions: ProposedAction[],
  proposalId = "prop-test",
): Promise<void> {
  await runScript(conversationId, [
    {
      step: "event",
      event: { type: "proposal", proposalId, requesterId, actions, status: "open" },
    },
  ]);
}

const proposalOf = (conversationId: string, proposalId: string) =>
  eventsOf(conversationId).find(
    (e): e is Extract<ConversationEvent, { type: "proposal" }> =>
      e.type === "proposal" && e.proposalId === proposalId,
  )!;

describe("visibilità (canSeeConversation)", () => {
  it("una libera privata la vede solo l'autore", async () => {
    as("p-giulia");
    expect(await getConversation("cv-giulia-week")).not.toBeNull();
    expect(await ids({ scope: "mine" })).toContain("cv-giulia-week");
    as("p-sara");
    expect(await getConversation("cv-giulia-week")).toBeNull();
    expect(await allVisible()).not.toContain("cv-giulia-week");
    as("p-roberta");
    expect(await getConversation("cv-giulia-week")).toBeNull();
  });

  it("una pubblica la vede chi ha claude.public.view; senza il permesso no", async () => {
    as("p-sara");
    const row = (await listConversations({ scope: "public" })).find(
      (c) => c.id === "cv-giulia-callbacks",
    );
    expect(row).toBeDefined();
    // AUD lo ha toccato Claude, ma Sara non lo vede: non si nomina.
    expect(row!.touchedProjectIds).not.toContain("prj-aud");
    expect(conv("cv-giulia-callbacks").touchedProjectIds).toContain("prj-aud");

    revokeInstancePermission("p-sara", "claude.public.view");
    expect(await getConversation("cv-giulia-callbacks")).toBeNull();
    expect(await allVisible()).not.toContain("cv-giulia-callbacks");
  });

  it("la posta la vede solo il titolare, nemmeno il full admin", async () => {
    as("p-giulia");
    expect(await getConversation("cv-mail-giulia")).not.toBeNull();
    as("p-roberta");
    expect(await getConversation("cv-mail-giulia")).toBeNull();
    expect(await allVisible()).not.toContain("cv-mail-giulia");
  });

  it("una sessione di lavoro chiede repos.view nel progetto, il refine backlog.edit", async () => {
    as("p-marco");
    expect(await getConversation("cv-run-aud-3")).not.toBeNull();
    as("p-giulia"); // contributor in AUD: niente repos.view
    expect(await getConversation("cv-run-aud-3")).toBeNull();
    expect(await ids({ scope: "live" })).not.toContain("cv-run-aud-3");
    as("p-laura");
    expect(await getConversation("cv-refine-stw-4")).not.toBeNull();
    as("p-giulia"); // contributor in STW: niente backlog.edit
    expect(await getConversation("cv-refine-stw-4")).toBeNull();
  });

  it("le sezioni: al lavoro, mie, pubbliche, concluse", async () => {
    as("p-giulia");
    const live = await ids({ scope: "live" });
    expect(live).toContain("cv-run-mkx-11");
    expect(live.every((id) => conv(id).kind !== "free" && conv(id).state !== "finished")).toBe(
      true,
    );
    const mine = await ids({ scope: "mine" });
    expect(mine.every((id) => conv(id).ownerId === "p-giulia" && conv(id).kind === "free")).toBe(
      true,
    );
    expect(await ids({ scope: "public" })).not.toContain("cv-giulia-callbacks"); // è sua
    const finished = await listConversations({ scope: "finished", kind: "brief" });
    expect(finished.map((c) => c.id)).toEqual(["cv-brief-mkx"]);
    expect(await ids({ scope: "live", taskId: "t-mkx-11" })).toEqual(["cv-run-mkx-11"]);
  });
});

describe("permessi calcolati nel dettaglio", () => {
  it("la domanda: risponde il richiedente o chi ha plans.approve", async () => {
    as("p-marco");
    const marco = (await getConversation("cv-run-aud-3"))!;
    expect(marco.canAnswer).toBe(true);
    expect(marco.canWrite).toBe(false);
    expect(marco.readOnlyReason).toBe("not_interactive");
    as("p-laura");
    expect((await getConversation("cv-run-aud-3"))!.canAnswer).toBe(true);
  });

  it("il piano: solo chi ha plans.approve", async () => {
    as("p-marco");
    expect((await getConversation("cv-run-stw-13"))!.canDecidePlan).toBe(false);
    as("p-laura");
    expect((await getConversation("cv-run-stw-13"))!.canDecidePlan).toBe(true);
  });

  it("le sessioni automatiche si guardano soltanto", async () => {
    as("p-marco");
    const review = (await getConversation("cv-review-stw-405"))!;
    expect(review.canWrite).toBe(false);
    expect(review.readOnlyReason).toBe("automatic");
  });

  it("una pubblica altrui non si scrive: si continua", async () => {
    as("p-sara");
    const detail = (await getConversation("cv-giulia-callbacks"))!;
    expect(detail).toMatchObject({
      canWrite: false,
      canContinue: true,
      canManage: false,
      readOnlyReason: "not_owner",
    });
  });
});

describe("conversazione libera", () => {
  it("crea, scrive e Claude risponde come chi scrive; il titolo viene dalla prima domanda", async () => {
    as("p-giulia");
    const c = await createConversation({ contextProjectId: "prj-mkx" });
    await sendMessage(c.id, { text: "Explain MKX-7" });
    const detail = (await getConversation(c.id))!;
    expect(detail.title).toBe("Explain MKX-7");
    expect(detail.state).toBe("idle");
    expect(detail.touchedProjectIds).toContain("prj-mkx");
    const user = detail.events.find((e) => e.type === "user");
    expect(user).toMatchObject({ authorId: "p-giulia", delivery: "delivered" });
    const refs = detail.events.flatMap((e) => (e.type === "citation" ? e.refs : []));
    expect(refs).toContainEqual({ kind: "task", id: "t-mkx-7" });
  });

  it("Claude legge come chi ha scritto anche se nel frattempo si cambia persona", async () => {
    as("p-giulia");
    const c = await createConversation();
    const sending = sendMessage(c.id, { text: "Explain AUD-3" });
    as("p-sara"); // «vedi come» cambia mentre Claude risponde; Sara AUD non lo vede
    await sending;
    const refs = eventsOf(c.id).flatMap((e) => (e.type === "citation" ? e.refs : []));
    expect(refs).toContainEqual({ kind: "task", id: "t-aud-3" });
  });

  it("un contesto di progetto invisibile è not_found; nessuna conversazione nasce", async () => {
    as("p-sara");
    const before = state.conversations.length;
    await expect(createConversation({ contextProjectId: "prj-aud" })).rejects.toThrow("not_found");
    expect(state.conversations).toHaveLength(before);
  });

  it("chi non è l'autore non scrive (forbidden) e il flusso resta com'era", async () => {
    as("p-sara");
    const before = eventsOf("cv-giulia-callbacks");
    await expect(sendMessage("cv-giulia-callbacks", { text: "Hello" })).rejects.toThrow(
      "forbidden",
    );
    expect(eventsOf("cv-giulia-callbacks")).toEqual(before);
  });

  it("rinomina, archivia ed elimina solo l'autore", async () => {
    as("p-sara");
    await expect(renameConversation("cv-giulia-callbacks", "Mine now")).rejects.toThrow(
      "forbidden",
    );
    await expect(deleteConversation("cv-giulia-callbacks")).rejects.toThrow("forbidden");
    expect(conv("cv-giulia-callbacks").title).not.toBe("Mine now");

    as("p-giulia");
    await renameConversation("cv-giulia-week", "This week");
    expect(conv("cv-giulia-week").title).toBe("This week");
    await archiveConversation("cv-giulia-week");
    expect(await ids({ scope: "mine" })).not.toContain("cv-giulia-week");
    expect((await getConversation("cv-giulia-week"))!.readOnlyReason).toBe("archived");
    await deleteConversation("cv-giulia-week");
    expect(await getConversation("cv-giulia-week")).toBeNull();
    expect(state.conversationEvents.has("cv-giulia-week")).toBe(false);
  });
});

describe("proposte", () => {
  it("la proposta aperta del seed resta aperta (orologio del prototipo) e si conferma", async () => {
    as("p-giulia");
    const detail = (await getConversation("cv-giulia-week"))!;
    const proposal = detail.events.find((e) => e.type === "proposal");
    expect(proposal).toMatchObject({ status: "open" });

    const outcome = await confirmProposal("cv-giulia-week", "prop-giulia-week-1");
    expect(outcome).toEqual({
      status: "confirmed",
      resultCodes: ["MKX-7"],
      runConversationIds: [],
    });
    expect(task("t-mkx-7").plannedWeek).toBe("2026-W45");
    expect(proposalOf("cv-giulia-week", "prop-giulia-week-1")).toMatchObject({
      status: "confirmed",
      resultCodes: ["MKX-7"],
    });
    // Una seconda conferma non riesegue nulla.
    await expect(confirmProposal("cv-giulia-week", "prop-giulia-week-1")).rejects.toThrow(
      "invalid",
    );
  });

  it("chi non l'ha chiesta non la conferma, non la annulla, non la modifica (forbidden)", async () => {
    as("p-giulia");
    await setVisibility("cv-giulia-week", "public", {
      confirmedProjectIds: conv("cv-giulia-week").touchedProjectIds,
    });
    as("p-marco"); // la vede (pubblica), ma la proposta è di Giulia
    const before = structuredClone(task("t-mkx-7"));
    await expect(confirmProposal("cv-giulia-week", "prop-giulia-week-1")).rejects.toThrow(
      "forbidden",
    );
    await expect(cancelProposal("cv-giulia-week", "prop-giulia-week-1")).rejects.toThrow(
      "forbidden",
    );
    await expect(editProposal("cv-giulia-week", "prop-giulia-week-1")).rejects.toThrow("forbidden");
    expect(task("t-mkx-7")).toEqual(before);
    expect(proposalOf("cv-giulia-week", "prop-giulia-week-1").status).toBe("open");
  });

  it("confermata dopo aver perso il permesso: failed con il motivo, nessuna scrittura (RF3)", async () => {
    as("p-giulia");
    grantProjectRole("p-giulia", "prj-mkx", "contributor"); // non è più Project Lead in MKX
    const tasksBefore = structuredClone(state.tasks);
    const activityBefore = state.activity.length;
    const notificationsBefore = state.notifications.length;

    const outcome = await confirmProposal("cv-giulia-week", "prop-giulia-week-1");
    expect(outcome.status).toBe("failed");
    const proposal = proposalOf("cv-giulia-week", "prop-giulia-week-1");
    expect(proposal.status).toBe("failed");
    expect(proposal.error).toContain("Plan MKX-7");
    expect(proposal.error).toMatch(/Nothing was changed/);
    expect(state.tasks).toEqual(tasksBefore);
    expect(state.activity).toHaveLength(activityBefore);
    expect(state.notifications).toHaveLength(notificationsBefore);
  });

  it("tutto o niente: la seconda azione fallisce e la prima non resta", async () => {
    as("p-giulia");
    const tasksBefore = structuredClone(state.tasks);
    const counterBefore = state.counter;
    await propose("cv-giulia-week", "p-giulia", [
      {
        fn: "createTask",
        args: { projectId: "prj-mkx", title: "Brief for the fair" },
        summary: "Create in MKX: Brief for the fair",
      },
      // In AUD Giulia è contributor: niente tickets.edit.
      {
        fn: "updateTask",
        args: { id: "t-aud-2", patch: { size: "S" } },
        summary: "Change AUD-2",
      },
    ]);
    const outcome = await confirmProposal("cv-giulia-week", "prop-test");
    expect(outcome).toMatchObject({ status: "failed" });
    expect((outcome as { error: string }).error).toContain("Change AUD-2");
    expect(state.tasks).toEqual(tasksBefore);
    expect(state.tasksById.size).toBe(tasksBefore.length);
    expect(state.counter).toBe(counterBefore);
  });

  it("converte una richiesta e avvia Claude sulla task nata (taskFromAction)", async () => {
    as("p-giulia");
    const request = await createRequest({ projectId: "prj-mkx", title: "Leaflet for the fair" });
    await propose("cv-giulia-week", "p-giulia", [
      {
        fn: "convertRequest",
        args: { id: request.id, input: { title: "Leaflet for the fair" } },
        summary: "Convert",
      },
      { fn: "startRun", args: { taskFromAction: 0 }, summary: "Start Claude" },
    ]);
    const outcome = await confirmProposal("cv-giulia-week", "prop-test");
    expect(outcome.status).toBe("confirmed");
    const { resultCodes, runConversationIds } = outcome as Extract<
      typeof outcome,
      { status: "confirmed" }
    >;
    expect(resultCodes).toHaveLength(1);
    expect(runConversationIds).toHaveLength(1);
    const run = conv(runConversationIds[0]!);
    expect(run).toMatchObject({ kind: "task_run", ownerId: "p-giulia", projectId: "prj-mkx" });
    expect(state.tasksById.get(run.taskId!)!.code).toBe(resultCodes[0]);
    await settle(run.id);
    // Giulia ha plans.approve in MKX: niente gate, Claude arriva alla PR.
    expect(conv(run.id)).toMatchObject({ state: "finished", outcome: "ok" });
    expect(state.tasksById.get(run.taskId!)!.claude).toBe("done");
  });

  it("annullata resta leggibile; editProposal restituisce gli argomenti del dialogo", async () => {
    as("p-giulia");
    expect(await editProposal("cv-giulia-week", "prop-giulia-week-1")).toEqual({
      fn: "planTask",
      args: { id: "t-mkx-7", plan: { assigneeId: "p-chiara", week: "2026-W45" } },
    });
    await cancelProposal("cv-giulia-week", "prop-giulia-week-1");
    expect(proposalOf("cv-giulia-week", "prop-giulia-week-1").status).toBe("cancelled");
    expect(task("t-mkx-7").plannedWeek).not.toBe("2026-W45");
  });

  it("scade dopo 20 eventi successivi: letta `expired`, non si conferma", async () => {
    as("p-giulia");
    const received: ConversationEvent[] = [];
    const unsubscribe = subscribe("cv-giulia-week", (e) => received.push(e));
    await runScript(
      "cv-giulia-week",
      Array.from({ length: 19 }, (_, i) => ({
        step: "action" as const,
        tool: "noop",
        label: `Step ${i}`,
      })),
    );
    let detail = (await getConversation("cv-giulia-week"))!;
    expect(detail.events.find((e) => e.type === "proposal")).toMatchObject({ status: "open" });

    await runScript("cv-giulia-week", [{ step: "action", tool: "noop", label: "Step 20" }]);
    detail = (await getConversation("cv-giulia-week"))!;
    expect(detail.events.find((e) => e.type === "proposal")).toMatchObject({ status: "expired" });
    // Chi guarda la riceve aggiornata, senza ricaricare.
    const last = received.filter((e) => e.type === "proposal").at(-1);
    expect(last).toMatchObject({ status: "expired" });
    unsubscribe();

    await expect(confirmProposal("cv-giulia-week", "prop-giulia-week-1")).rejects.toThrow(
      "expired",
    );
    expect(task("t-mkx-7").plannedWeek).not.toBe("2026-W45");
    // Il dato salvato non cambia: la scadenza si calcola a lettura.
    expect(proposalOf("cv-giulia-week", "prop-giulia-week-1").status).toBe("open");
  });

  it("scade dopo 24 ore", async () => {
    as("p-giulia");
    const stored = state.conversationEvents
      .get("cv-giulia-week")!
      .find((e) => e.type === "proposal")!;
    stored.at = "2026-10-22T11:59:00Z"; // più di 24 ore prima di adesso (TODAY 12:00)
    const detail = (await getConversation("cv-giulia-week"))!;
    expect(detail.events.find((e) => e.type === "proposal")).toMatchObject({ status: "expired" });
    await expect(confirmProposal("cv-giulia-week", "prop-giulia-week-1")).rejects.toThrow(
      "expired",
    );
  });
});

describe("pubbliche e continuazioni", () => {
  it("rendere pubblica elenca i progetti toccati e chiede di confermarli", async () => {
    as("p-giulia");
    const first = await setVisibility("cv-giulia-week", "public");
    expect(first.status).toBe("needs_confirmation");
    expect(
      (first as Extract<typeof first, { status: "needs_confirmation" }>).touchedProjects.map(
        (p) => p.code,
      ),
    ).toEqual(["MKX", "OLV", "STW"]);
    expect(conv("cv-giulia-week").visibility).toBe("private");

    const partial = await setVisibility("cv-giulia-week", "public", {
      confirmedProjectIds: ["prj-mkx"],
    });
    expect(partial.status).toBe("needs_confirmation");
    expect(conv("cv-giulia-week").visibility).toBe("private");

    const done = await setVisibility("cv-giulia-week", "public", {
      confirmedProjectIds: ["prj-stw", "prj-olv", "prj-mkx"],
    });
    expect(done.status).toBe("done");
    expect(conv("cv-giulia-week")).toMatchObject({
      visibility: "public",
      publishedById: "p-giulia",
      publishedAt: `${TODAY}T12:00:00Z`,
    });
    as("p-sara");
    expect(await ids({ scope: "public" })).toContain("cv-giulia-week");

    as("p-giulia");
    await setVisibility("cv-giulia-week", "private");
    as("p-sara");
    expect(await getConversation("cv-giulia-week")).toBeNull();
  });

  it("solo l'autore cambia la visibilità", async () => {
    as("p-sara");
    await expect(
      setVisibility("cv-giulia-callbacks", "private", { confirmedProjectIds: [] }),
    ).rejects.toThrow("forbidden");
    expect(conv("cv-giulia-callbacks").visibility).toBe("public");
  });

  it("continuare una pubblica altrui crea una privata di chi scrive; Claude legge come lui (RF2)", async () => {
    const originalEvents = eventsOf("cv-giulia-callbacks");
    const original = structuredClone(conv("cv-giulia-callbacks"));
    as("p-sara");
    const mine = await continueConversation("cv-giulia-callbacks");
    expect(mine).toMatchObject({
      kind: "free",
      ownerId: "p-sara",
      visibility: "private",
      continuesFromId: "cv-giulia-callbacks",
    });
    const detail = (await getConversation(mine.id))!;
    expect(detail.continuesFrom).toEqual({ id: "cv-giulia-callbacks", title: original.title });
    expect(detail.canWrite).toBe(true);

    // AUD-9 è citata nella pubblica di Giulia; Sara AUD non lo vede.
    await sendMessage(mine.id, { text: "Explain AUD-9" });
    const reply = eventsOf(mine.id);
    const refs = reply.flatMap((e) => (e.type === "citation" ? e.refs : []));
    expect(refs).toEqual([]);
    const text = reply.flatMap((e) => (e.type === "assistant" ? [e.text] : [])).join("\n");
    expect(text).toContain("AUD-9");
    expect(text).not.toContain(task("t-aud-9").title);
    expect(conv(mine.id).touchedProjectIds).not.toContain("prj-aud");

    // L'originale non cambia, e Giulia non vede la continuazione.
    expect(eventsOf("cv-giulia-callbacks")).toEqual(originalEvents);
    expect(conv("cv-giulia-callbacks")).toEqual(original);
    as("p-giulia");
    expect(await getConversation(mine.id)).toBeNull();
    expect(await allVisible()).not.toContain(mine.id);
  });

  it("l'autore non continua la propria; una privata altrui non si continua", async () => {
    as("p-giulia");
    await expect(continueConversation("cv-giulia-callbacks")).rejects.toThrow("invalid");
    as("p-sara");
    const before = state.conversations.length;
    await expect(continueConversation("cv-giulia-week")).rejects.toThrow("not_found");
    expect(state.conversations).toHaveLength(before);
  });

  it("una pubblica che tocca un progetto nuovo torna privata", async () => {
    as("p-giulia");
    expect(conv("cv-giulia-callbacks").touchedProjectIds).not.toContain("prj-mkx");
    await sendMessage("cv-giulia-callbacks", { text: "Explain MKX-7" });
    expect(conv("cv-giulia-callbacks")).toMatchObject({ visibility: "private", publishedAt: null });
    expect(conv("cv-giulia-callbacks").touchedProjectIds).toContain("prj-mkx");
  });
});

describe("domande", () => {
  it("risponde il richiedente; la seconda risposta è already_answered con chi ha risposto", async () => {
    as("p-giulia");
    await expect(
      answerQuestion("cv-run-aud-3", "q-aud-3-1", { optionIndex: 0, text: null }),
    ).rejects.toThrow("not_found");

    as("p-marco");
    await answerQuestion("cv-run-aud-3", "q-aud-3-1", { optionIndex: 0, text: null });
    const question = eventsOf("cv-run-aud-3").find((e) => e.type === "question")!;
    expect(question).toMatchObject({ answer: { optionIndex: 0, byId: "p-marco" } });
    // Claude riprende dal piano: Marco (developer) aspetta l'approvazione.
    await settle("cv-run-aud-3");
    expect(conv("cv-run-aud-3").state).toBe("awaiting_approval");
    expect(task("t-aud-3").claude).toBe("awaiting_approval");
    expect(eventsOf("cv-run-aud-3").find((e) => e.type === "plan")).toMatchObject({
      status: "pending",
    });
    // Nel registro decisioni, con un testo fisso.
    expect(state.decisionLog.at(-1)).toMatchObject({
      source: "ask_user",
      decision: "Create a new contact",
      decidedById: "p-marco",
    });

    as("p-laura");
    const second = answerQuestion("cv-run-aud-3", "q-aud-3-1", { optionIndex: 1, text: null });
    await expect(second).rejects.toThrow("already_answered");
    await expect(second).rejects.toMatchObject({ byId: "p-marco" });
    expect(eventsOf("cv-run-aud-3").find((e) => e.type === "question")).toEqual(question);
  });

  it("due risposte insieme: una passa, l'altra è already_answered", async () => {
    as("p-marco");
    const a = answerQuestion("cv-run-aud-3", "q-aud-3-1", { optionIndex: 0, text: null });
    as("p-laura");
    const b = answerQuestion("cv-run-aud-3", "q-aud-3-1", { optionIndex: 2, text: null });
    const results = await Promise.allSettled([a, b]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as Error).message).toBe("already_answered");
  });

  it("la sessione dal vivo di MKX arriva a una domanda per Giulia (R-E4)", async () => {
    as("p-giulia");
    const unsubscribe = subscribe("cv-run-mkx-11", () => {});
    await settle("cv-run-mkx-11");
    unsubscribe();
    const detail = (await getConversation("cv-run-mkx-11"))!;
    expect(detail.state).toBe("awaiting_answer");
    expect(detail.canAnswer).toBe(true);
    expect(task("t-mkx-11").claude).toBe("awaiting_answer");
    await answerQuestion("cv-run-mkx-11", "q-mkx-11-1", { optionIndex: null, text: "Print only" });
    await settle("cv-run-mkx-11");
    expect(conv("cv-run-mkx-11")).toMatchObject({ state: "finished", outcome: "ok" });
    expect(task("t-mkx-11").claude).toBe("done");
  });
});

describe("piano", () => {
  it("senza plans.approve non si decide (forbidden) e il piano resta in attesa", async () => {
    as("p-marco");
    const before = eventsOf("cv-run-stw-13");
    await expect(decidePlan("cv-run-stw-13", "approve")).rejects.toThrow("forbidden");
    expect(eventsOf("cv-run-stw-13")).toEqual(before);
    expect(conv("cv-run-stw-13").state).toBe("awaiting_approval");
  });

  it("approvato, Claude esegue fino alla PR; nel registro c'è la decisione", async () => {
    as("p-laura");
    await decidePlan("cv-run-stw-13", "approve");
    expect(eventsOf("cv-run-stw-13").find((e) => e.type === "plan")).toMatchObject({
      status: "approved",
      decidedById: "p-laura",
    });
    await settle("cv-run-stw-13");
    expect(conv("cv-run-stw-13")).toMatchObject({ state: "finished", outcome: "ok" });
    expect(task("t-stw-13").claude).toBe("done");
    expect(state.decisionLog.at(-1)).toMatchObject({ source: "plan_review", decision: "Approved" });
    await expect(decidePlan("cv-run-stw-13", "approve")).rejects.toThrow("invalid");
  });

  it("rifiutato con indicazioni, Claude lo riscrive e torna al gate", async () => {
    as("p-laura");
    await decidePlan("cv-run-stw-13", "reject", "Also cover 800 × 600.");
    await settle("cv-run-stw-13");
    const plans = eventsOf("cv-run-stw-13").filter((e) => e.type === "plan");
    expect(plans.map((p) => p.type === "plan" && p.status)).toEqual(["rejected", "pending"]);
    expect(conv("cv-run-stw-13").state).toBe("awaiting_approval");
  });

  it("approvazione in anticipo e revoca: solo con plans.approve, mentre Claude pianifica", async () => {
    // Il tempo lo muove il test: ogni chiamata e ogni passo di Claude costano
    // 10 ms, e il piano arriva solo dopo la lettura della task (~100 ms).
    vi.useFakeTimers();
    setLatency(10);
    const step = async <R>(...calls: Promise<R>[]) => {
      const settled = Promise.allSettled(calls);
      await vi.advanceTimersByTimeAsync(10);
      return settled;
    };
    try {
      as("p-marco"); // developer: niente plans.approve
      const starting = startRun("t-aud-2");
      await vi.advanceTimersByTimeAsync(30);
      const run = await starting;

      as("p-marco");
      const refused = preApprovePlan(run.id);
      const marcoView = getConversation(run.id);
      as("p-laura");
      const lauraView = getConversation(run.id);
      const [r1, r2, r3] = await step<unknown>(refused, marcoView, lauraView);
      expect(r1).toMatchObject({ status: "rejected", reason: new Error("forbidden") });
      expect(r2).toMatchObject({ value: { canPreApprovePlan: false } });
      expect(r3).toMatchObject({ value: { canPreApprovePlan: true } });

      as("p-laura");
      await step(preApprovePlan(run.id));
      expect(state.preApprovedPlans.get(run.id)).toBe("p-laura");
      await step(revokePlanApproval(run.id));
      const [again] = await step(revokePlanApproval(run.id));
      expect(again).toMatchObject({ status: "rejected" });
      await step(preApprovePlan(run.id));
      expect(eventsOf(run.id).some((e) => e.type === "plan")).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(eventsOf(run.id).find((e) => e.type === "plan")).toMatchObject({
        status: "pre_approved",
        decidedById: "p-laura",
      });
      expect(conv(run.id)).toMatchObject({ state: "finished", outcome: "ok" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dopo il piano non si approva più in anticipo", async () => {
    as("p-marco");
    const run = await startRun("t-aud-2");
    await settle(run.id);
    as("p-laura");
    expect((await getConversation(run.id))!.canPreApprovePlan).toBe(false);
    await expect(preApprovePlan(run.id)).rejects.toThrow("invalid");
    expect(state.preApprovedPlans.has(run.id)).toBe(false);
  });
});

describe("sessioni di lavoro", () => {
  it("avvia: con runs.start; un developer passa dal gate del piano", async () => {
    as("p-giulia"); // contributor in AUD
    const before = state.conversations.length;
    await expect(startRun("t-aud-2")).rejects.toThrow("forbidden");
    expect(state.conversations).toHaveLength(before);
    expect(task("t-aud-2").claude).toBe("none");

    as("p-marco");
    const run = await startRun("t-aud-2");
    expect(run).toMatchObject({ kind: "task_run", ownerId: "p-marco", state: "working" });
    expect(task("t-aud-2").claude).toBe("working");
    await expect(startRun("t-aud-2")).rejects.toThrow("conflict");
    await settle(run.id);
    expect(conv(run.id).state).toBe("awaiting_approval");
    expect(task("t-aud-2").claude).toBe("awaiting_approval");
  });

  it("ferma: con agent_sessions.intervene; la task si ferma con la sessione", async () => {
    as("p-giulia");
    await expect(stop("cv-run-aud-5")).rejects.toThrow("not_found");

    grantProjectRole("p-marco", "prj-aud", "viewer"); // vede (repos.view) ma non interviene
    as("p-marco");
    expect((await getConversation("cv-run-aud-5"))!.canInterrupt).toBe(false);
    const before = eventsOf("cv-run-aud-5");
    await expect(stop("cv-run-aud-5")).rejects.toThrow("forbidden");
    expect(eventsOf("cv-run-aud-5")).toEqual(before);
    expect(conv("cv-run-aud-5").state).toBe("working");

    as("p-laura");
    await stop("cv-run-aud-5");
    expect(conv("cv-run-aud-5").state).toBe("paused");
    expect(task("t-aud-5").claude).toBe("stopped");
    const phase = eventsOf("cv-run-aud-5").at(-1);
    expect(phase).toMatchObject({ type: "phase", outcome: "stopped", stoppedById: "p-laura" });
    // Lo script del seed non riparte dopo il «Ferma».
    const unsubscribe = subscribe("cv-run-aud-5", () => {});
    await settle("cv-run-aud-5");
    unsubscribe();
    expect(conv("cv-run-aud-5").state).toBe("paused");
  });

  it("ferma e scrivi: il messaggio arriva consegnato e Claude riparte", async () => {
    as("p-laura");
    await stopAndSend("cv-run-aud-5", "Use the existing email template.");
    const user = eventsOf("cv-run-aud-5")
      .filter((e) => e.type === "user")
      .at(-1);
    expect(user).toMatchObject({ authorId: "p-laura", delivery: "delivered" });
    expect(conv("cv-run-aud-5").state).toBe("working");
  });

  it("un messaggio in una sessione al lavoro entra nel turno; senza canWrite no", async () => {
    as("p-laura");
    await sendMessage("cv-run-aud-5", { text: "Keep the old columns too." });
    const user = eventsOf("cv-run-aud-5")
      .filter((e) => e.type === "user")
      .at(-1);
    expect(user).toMatchObject({ text: "Keep the old columns too.", delivery: "delivered" });

    as("p-marco"); // aspetta una risposta: non è un passo interattivo
    await expect(sendMessage("cv-run-aud-3", { text: "Hi" })).rejects.toThrow("forbidden");
  });

  it("rilancia con indicazioni: la pausa si chiude, nasce un lavoro con il messaggio", async () => {
    as("p-giulia");
    await expect(relaunchWithInstructions("t-aud-4", "Go")).rejects.toThrow("forbidden");
    as("p-marco");
    const run = await relaunchWithInstructions("t-aud-4", "Use the new invoice design.");
    expect(conv("cv-run-aud-4")).toMatchObject({ state: "finished", outcome: "stopped" });
    expect(eventsOf(run.id).find((e) => e.type === "user")).toMatchObject({
      text: "Use the new invoice design.",
    });
    await expect(relaunchWithInstructions("t-aud-4", "Again")).rejects.toThrow("conflict");
  });

  it("chiedi modifiche: con corrections.request, solo se c'è una PR", async () => {
    as("p-giulia"); // contributor in STW
    await expect(requestChanges("t-stw-1", "Rename the button")).rejects.toThrow("forbidden");
    as("p-marco");
    await expect(requestChanges("t-stw-13", "Rename it")).rejects.toThrow("invalid");
    const run = await requestChanges("t-stw-1", "Rename the button");
    expect(eventsOf(run.id)[0]).toMatchObject({ type: "phase", phase: "correction" });
    await settle(run.id);
    expect(conv(run.id)).toMatchObject({ state: "finished", outcome: "ok" });
    expect(eventsOf(run.id).some((e) => e.type === "work_result" && e.kind === "correction")).toBe(
      true,
    );
  });

  it("riprendi la correzione: solo una correzione in pausa", async () => {
    as("p-marco");
    await expect(resumeCorrection("t-aud-4")).rejects.toThrow("invalid"); // in pausa, ma in esecuzione
    as("p-laura");
    await stop("cv-run-stw-3"); // in correzione
    as("p-giulia");
    await expect(resumeCorrection("t-stw-3")).rejects.toThrow("forbidden");
    as("p-laura");
    await resumeCorrection("t-stw-3");
    await settle("cv-run-stw-3");
    expect(conv("cv-run-stw-3")).toMatchObject({ state: "finished", outcome: "ok" });
    expect(task("t-stw-3").claude).toBe("done");
  });

  it("refine: apre e chiude chi ha backlog.edit; scrive solo lui", async () => {
    as("p-giulia");
    await expect(startRefineConversation("req-stw-1")).rejects.toThrow("forbidden");
    expect(state.requests.find((r) => r.id === "req-stw-1")!.status).toBe("new");

    as("p-laura");
    const refine = await startRefineConversation("req-stw-1");
    expect(state.requests.find((r) => r.id === "req-stw-1")!.status).toBe("refining");
    expect(await startRefineConversation("req-stw-1")).toMatchObject({ id: refine.id });
    expect(conv(refine.id).state).toBe("idle");
    await sendMessage(refine.id, { text: "Show the old week too." });
    expect(eventsOf(refine.id).some((e) => e.type === "work_result")).toBe(true);

    grantProjectRole("p-marco", "prj-stw", "viewer");
    as("p-marco");
    await expect(closeRefine(refine.id)).rejects.toThrow("not_found");

    as("p-laura");
    await closeRefine(refine.id);
    expect(conv(refine.id)).toMatchObject({ state: "finished", outcome: "ok" });
    expect(state.requests.find((r) => r.id === "req-stw-1")!.status).toBe("ready");
  });
});

describe("stream: stato e patch", () => {
  it("un cambio di stato si annuncia (R-E5)", async () => {
    const changed: string[] = [];
    const off = onConversationChange((id) => changed.push(id));
    await runScript("cv-run-aud-5", [{ step: "state", state: "paused" }]);
    off();
    expect(changed).toContain("cv-run-aud-5");
    expect(task("t-aud-5").claude).toBe("stopped");
  });

  it("un patch cambia solo un evento del suo tipo", async () => {
    const before = eventsOf("cv-run-aud-3");
    const question = before.find((e) => e.type === "question")!;
    await expect(
      runScript("cv-run-aud-3", [
        { step: "patch", eventId: question.id, patch: { type: "plan", status: "approved" } },
      ]),
    ).rejects.toThrow("invalid");
    expect(eventsOf("cv-run-aud-3")).toEqual(before);
  });
});

describe("comandi «/»", () => {
  it("le skill dei plugin solo per un contesto di progetto che chi guarda vede", async () => {
    as("p-marco");
    const aud = await listCommands("prj-aud");
    expect(aud.some((c) => c.label === "/superpowers:brainstorming")).toBe(true);
    expect(aud.some((c) => c.label === "/superpowers:test-driven-development")).toBe(false);
    as("p-sara");
    const hidden = await listCommands("prj-aud");
    expect(hidden.every((c) => c.source === "stubwise")).toBe(true);
    expect(await listCommands(null)).toEqual(hidden);
  });
});

describe("rassegna del giorno per persona", () => {
  it("senza people.activity.view è forbidden", async () => {
    as("p-sara");
    await expect(listPeopleActivity(TODAY)).rejects.toThrow("forbidden");
  });

  it("con il permesso mostra solo i progetti che chi guarda vede", async () => {
    grantInstancePermission("p-sara", "people.activity.view");
    as("p-sara"); // non vede AUD
    const sara = await listPeopleActivity(TODAY);
    const commits = sara.flatMap((p) => p.commits);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((c) => c.projectId !== "prj-aud")).toBe(true);
    expect(sara.some((p) => p.personId === null)).toBe(false); // il non collegato è su AUD

    as("p-roberta");
    const all = await listPeopleActivity(TODAY);
    expect(all.flatMap((p) => p.commits).some((c) => c.projectId === "prj-aud")).toBe(true);
    const unlinked = all.find((p) => p.personId === null);
    expect(unlinked).toMatchObject({ name: "kevin.ortega" });
    const simone = all.find((p) => p.personId === "p-simone")!;
    expect(simone.commits).toHaveLength(2);
  });

  it("i fatti di Stubwise del giorno: task chiuse e spostate, commenti, decisioni, richieste", async () => {
    as("p-roberta");
    await createRequest({ projectId: "prj-stw", title: "Export the planning" });
    await answerQuestion("cv-run-aud-3", "q-aud-3-1", { optionIndex: 0, text: null });
    await addComment("t-stw-13", "Seen it at 1024 × 680 too.");
    const closed = state.statuses.find((s) => s.projectId === "prj-stw" && s.family === "closed")!;
    await updateTask("t-stw-13", { statusId: closed.id, plannedWeek: "2026-W45" });

    const roberta = (await listPeopleActivity(TODAY)).find((p) => p.personId === "p-roberta")!;
    expect(roberta.requestsCreated.map((r) => r.title)).toEqual(["Export the planning"]);
    expect(roberta.decisions.map((d) => d.source)).toEqual(["log"]);
    expect(roberta.comments.map((c) => c.code)).toEqual(["STW-13"]);
    expect(roberta.tasksMoved.map((m) => m.field).sort()).toEqual(["status", "week"]);
    // Chiusa: conta per l'assegnatario.
    const marco = (await listPeopleActivity(TODAY)).find((p) => p.personId === "p-marco")!;
    expect(marco.tasksClosed.map((t) => t.code)).toContain("STW-13");

    const yesterday = await listPeopleActivity("2026-10-22");
    const commits = yesterday.flatMap((p) => p.commits);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((c) => c.at.startsWith("2026-10-22"))).toBe(true);
    const requestsYesterday = yesterday.flatMap((p) => p.requestsCreated);
    expect(requestsYesterday.every((r) => r.at.startsWith("2026-10-22"))).toBe(true);
    expect(requestsYesterday.map((r) => r.title)).not.toContain("Export the planning");

    const byDept = await listPeopleActivity(TODAY, "dep-development");
    expect(byDept.length).toBeGreaterThan(0);
    expect(byDept.every((p) => p.departmentIds.includes("dep-development"))).toBe(true);
  });
});
