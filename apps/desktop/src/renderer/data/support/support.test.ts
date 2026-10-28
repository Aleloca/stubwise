import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  convertRequest,
  createRequest,
  failNext,
  listNotifications,
  resetApi,
  setLatency,
  startRefine,
  support,
} from "../api";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import type { SupportConversation } from "../types";

const ACQ = "prj-acq";
const as = (personId: string) => setSessionPersonId(personId);
const conv = (code: string): SupportConversation =>
  state.supportConversations.find((c) => c.code === code)!;
/** Una persona che non vede ACQ (né admin né membro). */
const outsider = () =>
  PEOPLE.find((p) => !p.isClaude && p.presetRole !== "admin" && !visibleProjectIds(p.id).has(ACQ))!
    .id;

beforeEach(() => {
  resetApi();
  setLatency(0);
});

afterEach(() => resetApi());

describe("l'insieme esportato: nessuna richiesta da un'email", () => {
  it("le funzioni di api.support sono esattamente quelle del piano", () => {
    const fns = Object.entries(support)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(fns).toEqual(
      [
        "listSupportConversations",
        "getSupportConversation",
        "customerPreview",
        "listWaitingCustomers",
        "listWidgets",
        "myRequestStatus",
        "searchSupport",
        "replyToCustomer",
        "draftReply",
        "openRequestFrom",
        "followConversation",
        "emailDraftFor",
        "createWidget",
        "updateWidget",
        "deleteWidget",
        "simulateCustomerMessage",
        "simulateCustomerLeaves",
        "simulateTriageDone",
      ].sort(),
    );
    for (const name of fns) {
      expect(name).not.toMatch(/(mail|email|thread).*request|request.*(mail|email|thread)/i);
      expect(name).not.toMatch(/send.*(mail|email)|(mail|email).*send/i);
    }
  });

  it("una richiesta non accetta un'origine diversa da Support", async () => {
    as("p-matteo");
    await expect(
      createRequest({
        projectId: ACQ,
        title: "Da un'email",
        origin: { kind: "email", conversationId: "x" } as never,
      }),
    ).rejects.toThrow("invalid: origin");
  });

  it("fuori da «Apri la richiesta» un'origine Support vale solo per una non conclusa (mai in triage)", async () => {
    as("p-matteo");
    const id = conv("ACQ-S1").id; // in triage: Claude sta facendo le domande
    await expect(
      createRequest({ projectId: ACQ, title: "Skip the triage", origin: { kind: "support", conversationId: id } }),
    ).rejects.toThrow(/^invalid: origin$/);
    expect(conv("ACQ-S1").requestId).toBeNull();
    // Il triage concluso resta la sua strada.
    expect((await support.simulateTriageDone("ACQ-S1")).request).not.toBeNull();
  });
});

describe("letture e visibilità", () => {
  it("stati derivati del seme", async () => {
    as("p-matteo");
    const list = await support.listSupportConversations(ACQ);
    const byCode = new Map(list.map((c) => [c.code, c.state]));
    expect(Object.fromEntries(byCode)).toEqual({
      "ACQ-S1": "triage",
      "ACQ-S2": "waiting_us",
      "ACQ-S3": "not_concluded",
      "ACQ-S4": "request_open",
    });
    // Ordine dei gruppi: aspetta noi, in triage, non concluse, richiesta aperta, risposte.
    expect(list.map((c) => c.code)).toEqual(["ACQ-S2", "ACQ-S1", "ACQ-S3", "ACQ-S4"]);
    expect(
      (await support.listSupportConversations(ACQ, { state: "triage" })).map((c) => c.code),
    ).toEqual(["ACQ-S1"]);
  });

  it("i membri vedono conversazione e richiesta; la bozza di Claude solo con support.reply", async () => {
    as("p-sara");
    const sara = (await support.getSupportConversation("ACQ-S2"))!;
    expect(sara.request).toMatchObject({ code: expect.stringMatching(/^ACQ-R\d+$/) });
    expect(sara.request!.customerStatus).toBe("received");
    expect(sara.claudeDraft).toBeNull();
    expect(sara.canReply).toBe(false);
    as("p-matteo");
    const matteo = (await support.getSupportConversation("ACQ-S2"))!;
    expect(matteo.claudeDraft).toMatch(/^Hi Lucia/);
    expect(matteo.canReply).toBe(true);
    expect(matteo.waitingSince).toBe(conv("ACQ-S2").messages.at(-1)!.at);
  });

  it("R-G5: inesistente e progetto invisibile rispondono uguale", async () => {
    as(outsider());
    expect(await support.getSupportConversation("ACQ-S2")).toBeNull();
    expect(await support.getSupportConversation("ACQ-S99")).toBeNull();
    expect(await support.customerPreview("ACQ-S2")).toBeNull();
    expect(await support.listSupportConversations(ACQ)).toEqual([]);
    expect(await support.searchSupport("ACQ-S2")).toEqual([]);
    expect(await support.myRequestStatus("req-acq-1")).toBeNull();
    expect(await support.listWidgets(ACQ)).toEqual({ canManage: false, widgets: [] });
    await expect(support.replyToCustomer("ACQ-S2", "x")).rejects.toThrow("not_found");
    await expect(support.replyToCustomer("ACQ-S99", "x")).rejects.toThrow("not_found");
    await expect(support.simulateCustomerMessage("ACQ-S2", "x")).rejects.toThrow("not_found");
  });

  it("widget solo con widget.manage", async () => {
    as("p-sara");
    expect(await support.listWidgets(ACQ)).toEqual({ canManage: false, widgets: [] });
    await expect(support.createWidget(ACQ, { name: "x" })).rejects.toThrow("forbidden");
    await expect(support.updateWidget("wdg-acq-portal", { enabled: false })).rejects.toThrow(
      "forbidden",
    );
    as("p-matteo");
    const list = await support.listWidgets(ACQ);
    expect(list.canManage).toBe(true);
    expect(list.widgets).toEqual([
      expect.objectContaining({ id: "wdg-acq-portal", conversationCount: 3 }),
    ]);
  });

  it("⌘K trova per codice e nome del cliente", async () => {
    as("p-sara");
    const r = await support.searchSupport("lucia");
    expect(r).toEqual([
      expect.objectContaining({ code: "ACQ-S2", route: "#/p/ACQ/support/ACQ-S2" }),
    ]);
    expect((await support.searchSupport("acq-s3")).map((x) => x.code)).toEqual(["ACQ-S3"]);
  });

  it("Clienti in attesa: aspetta noi, dove ho support.reply", async () => {
    as("p-matteo");
    expect((await support.listWaitingCustomers()).map((c) => c.code)).toEqual(["ACQ-S2"]);
    as("p-sara");
    expect(await support.listWaitingCustomers()).toEqual([]);
  });
});

describe("Review Focus 4: il cliente vede solo il suo", () => {
  it("anteprima: niente autori, bozze né commenti interni", async () => {
    as("p-matteo");
    await support.replyToCustomer("ACQ-S2", "We are on it.");
    const preview = (await support.customerPreview("ACQ-S2"))!;
    expect(Object.keys(preview).sort()).toEqual(["messages", "status"]);
    expect(preview.status).toBe("received");
    for (const m of preview.messages) {
      expect(Object.keys(m).sort()).toEqual(["at", "body", "from"]);
      expect(["customer", "us"]).toContain(m.from);
    }
    const text = JSON.stringify(preview);
    expect(text).not.toContain("p-laura");
    expect(text).not.toContain("p-matteo");
    expect(text).not.toContain(conv("ACQ-S2").claudeDraft ?? "<nessuna bozza>");
    expect(preview.messages.at(-1)).toEqual({
      from: "us",
      body: "We are on it.",
      at: expect.any(String),
    });
  });

  it("Sara non risponde: forbidden e nessun messaggio", async () => {
    as("p-sara");
    const before = conv("ACQ-S2").messages.length;
    await expect(support.replyToCustomer("ACQ-S2", "Ciao")).rejects.toThrow("forbidden");
    await expect(support.draftReply("ACQ-S2")).rejects.toThrow("forbidden");
    await expect(support.emailDraftFor("ACQ-S2")).rejects.toThrow("forbidden");
    expect(conv("ACQ-S2").messages).toHaveLength(before);
  });

  it("risposta ed emailDraftFor non toccano la Posta e non avvisano nessuno", async () => {
    as("p-matteo");
    const mail = structuredClone(state.mailMessages);
    const drafts = structuredClone(state.mailDrafts);
    const notifications = state.notifications.length;
    const view = await support.replyToCustomer("ACQ-S2", "  Thanks Lucia.  ");
    expect(view.state).toBe("reply_sent");
    expect(view.following).toBe(true);
    expect(view.claudeDraft).toBeNull();
    expect(conv("ACQ-S2").messages.at(-1)).toMatchObject({
      from: "team",
      authorId: "p-matteo",
      body: "Thanks Lucia.",
    });
    const email = await support.emailDraftFor("ACQ-S2");
    expect(email.slot).toBe("support-ACQ-S2");
    expect(email.draft.threadId).toBeNull();
    expect(email.draft).toMatchObject({
      mode: "new",
      to: [expect.objectContaining({ email: "lucia.benedetti@example.com" })],
      subject: expect.stringMatching(/^About your request ACQ-R\d+$/),
    });
    expect(email.draft.body).toMatch(/^Hi Lucia/);
    expect(state.mailMessages).toEqual(mail);
    expect(state.mailDrafts).toEqual(drafts);
    expect(state.notifications).toHaveLength(notifications);
  });

  it("emailDraftFor: senza indirizzo o senza casella collegata, nessuna bozza", async () => {
    as("p-matteo");
    await expect(support.emailDraftFor("ACQ-S3")).rejects.toThrow("invalid: no_email");
    as("p-roberta");
    await expect(support.emailDraftFor("ACQ-S2")).rejects.toThrow("google_not_connected");
  });

  it("il cliente se ne va durante il triage: non conclusa, nessuna richiesta", async () => {
    as("p-matteo");
    const requests = state.requests.length;
    const view = await support.simulateCustomerLeaves("ACQ-S1");
    expect(view.state).toBe("not_concluded");
    expect(state.requests).toHaveLength(requests);
    expect(conv("ACQ-S1").requestId).toBeNull();
  });

  it("un messaggio del cliente su una non conclusa la riporta in triage", async () => {
    as("p-matteo");
    const view = await support.simulateCustomerMessage("ACQ-S3", "Still happening.");
    expect(view.state).toBe("triage");
  });
});

describe("R-K15: durante il triage non si risponde", () => {
  it("in triage replyToCustomer e draftReply sono invalid: state, nessun messaggio; la vista lo dice", async () => {
    as("p-matteo");
    const before = conv("ACQ-S1").messages.length;
    await expect(support.replyToCustomer("ACQ-S1", "Hello")).rejects.toThrow("invalid: state");
    await expect(support.draftReply("ACQ-S1")).rejects.toThrow("invalid: state");
    expect(conv("ACQ-S1").messages).toHaveLength(before);
    expect(conv("ACQ-S1").claudeDraft).toBeNull();
    const view = (await support.getSupportConversation("ACQ-S1"))!;
    expect(view.canReply).toBe(true);
    expect(view.replyClosed).toBe("triage");
  });

  it("su una non conclusa si risponde; fuori dal triage la casella è aperta", async () => {
    as("p-matteo");
    expect((await support.getSupportConversation("ACQ-S3"))!.replyClosed).toBeNull();
    expect((await support.getSupportConversation("ACQ-S2"))!.replyClosed).toBeNull();
    const view = await support.replyToCustomer("ACQ-S3", "We're looking into it.");
    expect(view.messages.at(-1)!.body).toBe("We're looking into it.");
  });
});

describe("R-K18: durante il triage nemmeno l'email", () => {
  it("emailDraftFor in triage è invalid: state, e la vista dice perché", async () => {
    as("p-matteo");
    const drafts = structuredClone(state.mailDrafts);
    await expect(support.emailDraftFor("ACQ-S1")).rejects.toThrow("invalid: state");
    expect(state.mailDrafts).toEqual(drafts);
    expect((await support.getSupportConversation("ACQ-S1"))!.emailBlocked).toBe("triage");
    // Chi non può rispondere resta `no_permission`, anche in triage.
    as("p-sara");
    expect((await support.getSupportConversation("ACQ-S1"))!.emailBlocked).toBe("no_permission");
  });
});

describe("R-K14: la bozza email ha uno slot suo", () => {
  it("emailDraftFor non usa lo slot della nuova email: id e slot della conversazione", async () => {
    as("p-matteo");
    const { draft } = await support.emailDraftFor("ACQ-S2");
    expect(draft.id).toBe("md-p-matteo-support-ACQ-S2");
    expect(draft.slot).toBe("support-ACQ-S2");
    expect(draft.threadId).toBeNull();
    expect(draft.id).not.toBe("md-p-matteo-new");
  });
});

describe("scritture", () => {
  it("risposta vuota: invalid, nessun messaggio", async () => {
    as("p-matteo");
    await expect(support.replyToCustomer("ACQ-S2", "   ")).rejects.toThrow("invalid: body");
    expect(conv("ACQ-S2").messages.at(-1)!.from).toBe("customer");
  });

  it("bozza di Claude: deterministica, non parte da sola", async () => {
    as("p-matteo");
    const messages = conv("ACQ-S2").messages.length;
    const a = await support.draftReply("ACQ-S2");
    const b = await support.draftReply("ACQ-S2");
    expect(a.claudeDraft).toBe(b.claudeDraft);
    expect(a.claudeDraft).toContain("ACQ-R");
    expect(conv("ACQ-S2").messages).toHaveLength(messages);
  });

  it("apri la richiesta da una non conclusa: backlog.create, origine Support, una sola", async () => {
    as("p-silvia");
    await expect(
      support.openRequestFrom("ACQ-S3", { title: "Logout", description: "" }),
    ).rejects.toThrow("forbidden");
    as("p-sara");
    await expect(
      support.openRequestFrom("ACQ-S1", { title: "x", description: "" }),
    ).rejects.toThrow("invalid: state");
    const [a, b] = await Promise.all([
      support.openRequestFrom("ACQ-S3", { title: "Logged out often", description: "Stay in." }),
      support.openRequestFrom("ACQ-S3", { title: "Logged out often", description: "Stay in." }),
    ]);
    expect(a.request!.id).toBe(b.request!.id);
    const req = state.requests.find((r) => r.id === a.request!.id)!;
    expect(req.origin).toEqual({ kind: "support", conversationId: conv("ACQ-S3").id });
    expect(req.requesterIds).toEqual([]);
    expect(state.requests.filter((r) => r.title === "Logged out often")).toHaveLength(1);
    expect(a.state).toBe("request_open");
    // Come la richiesta nata dal triage: un solo «support.request», col codice della richiesta.
    const alerts = state.notifications.filter(
      (n) => n.kind === "support.request" && n.objectCode === req.code,
    );
    expect(alerts).toHaveLength(1);
  });

  it("R-K12: segue chi vede la conversazione (ogni membro); rispondere resta a support.reply", async () => {
    as("p-matteo");
    expect((await support.followConversation("ACQ-S1", true)).following).toBe(true);
    expect((await support.followConversation("ACQ-S1", false)).following).toBe(false);
    as("p-sara");
    const view = await support.followConversation("ACQ-S1", true);
    expect(view.following).toBe(true);
    expect(view.canReply).toBe(false);
    expect(conv("ACQ-S1").followerIds).toContain("p-sara");
    // Seguire serve: l'avviso del cliente le arriva, anche senza support.reply.
    await support.simulateCustomerMessage("ACQ-S1", "From the portal.");
    const n = state.notifications.at(-1)!;
    expect((await listNotifications()).some((x) => x.id === n.id)).toBe(true);
    // Senza seguirla, no: il default resta acceso solo per chi risponde.
    await support.followConversation("ACQ-S1", false);
    await support.simulateCustomerMessage("ACQ-S1", "Hello?");
    const m = state.notifications.at(-1)!;
    expect((await listNotifications()).some((x) => x.id === m.id)).toBe(false);
    as(outsider());
    await expect(support.followConversation("ACQ-S1", true)).rejects.toThrow("not_found");
  });

  it("R-K13: widget coi campi del web, default e validazione con codici", async () => {
    as("p-matteo");
    const w = await support.createWidget(ACQ, { name: "  Site  " });
    expect(w).toMatchObject({
      name: "Site",
      enabled: false,
      sourceRepositoryIds: [],
      origins: [],
      title: "Help",
      welcomeMessage: "Hi! How can we help?",
      instructions: "",
      accentColor: "#22c55e",
      language: "it",
      dailyMessageCap: null,
      dailyRequestCap: null,
    });
    const bad: [Partial<support.WidgetInput>, string][] = [
      [{ name: " " }, "name"],
      [{ name: "x".repeat(81) }, "name"],
      [{ title: "" }, "title"],
      [{ title: "x".repeat(81) }, "title"],
      [{ welcomeMessage: " " }, "welcomeMessage"],
      [{ welcomeMessage: "x".repeat(501) }, "welcomeMessage"],
      [{ instructions: "x".repeat(4001) }, "instructions"],
      [{ accentColor: "green" }, "accentColor"],
      [{ language: "fr" as never }, "language"],
      [{ dailyMessageCap: 0 }, "dailyMessageCap"],
      [{ dailyMessageCap: 1.5 }, "dailyMessageCap"],
      [{ dailyRequestCap: 100_001 }, "dailyRequestCap"],
      [{ origins: ["ftp://x"] }, "origins"],
      [{ sourceRepositoryIds: ["repo-aud"] }, "sourceRepositoryIds"],
      [{ enabled: "yes" as never }, "enabled"],
    ];
    for (const [patch, code] of bad) {
      await expect(support.createWidget(ACQ, { name: "Ok", ...patch })).rejects.toThrow(
        `invalid: ${code}`,
      );
      await expect(support.updateWidget(w.id, patch)).rejects.toThrow(`invalid: ${code}`);
    }
    const updated = await support.updateWidget(w.id, {
      name: "Site 2",
      enabled: true,
      origins: ["https://acq.test"],
      title: "Assistance",
      welcomeMessage: "Hello",
      instructions: "Be brief.",
      accentColor: "#0A84FF",
      language: "en",
      dailyMessageCap: 200,
      dailyRequestCap: 20,
    });
    expect(updated).toMatchObject({
      name: "Site 2",
      enabled: true,
      accentColor: "#0A84FF",
      language: "en",
      dailyMessageCap: 200,
      dailyRequestCap: 20,
    });
    // Un tetto si riporta al default d'istanza con `null`.
    expect(
      (await support.updateWidget(w.id, { dailyMessageCap: null })).dailyMessageCap,
    ).toBeNull();
  });

  it("widget: crea, modifica, elimina (le conversazioni restano)", async () => {
    as("p-matteo");
    const w = await support.createWidget(ACQ, { name: "Site", origins: ["https://acq.test"] });
    expect((await support.updateWidget(w.id, { name: "Site 2" })).name).toBe("Site 2");
    await support.deleteWidget("wdg-acq-portal");
    expect(state.supportWidgets.map((x) => x.id)).toEqual([w.id]);
    expect(state.supportConversations).toHaveLength(4);
    const s1 = (await support.getSupportConversation("ACQ-S1"))!;
    expect(s1.widgetName).toBeNull();
  });
});

describe("simulazioni e avvisi", () => {
  it("messaggio del cliente: avviso obbligatorio ai follower", async () => {
    as("p-matteo");
    await support.simulateCustomerMessage("ACQ-S2", "Hello?");
    const n = state.notifications.at(-1)!;
    expect(n).toMatchObject({
      kind: "support.customer_replied",
      objectCode: "ACQ-S2",
      link: "#/p/ACQ/support/ACQ-S2",
      mandatory: [{ personId: "p-laura", reason: "follows_conversation" }],
    });
    as("p-laura");
    expect((await listNotifications()).some((x) => x.id === n.id)).toBe(true);
  });

  it("triage concluso: richiesta col desiderio riscritto e la conversazione, avviso", async () => {
    as("p-sara");
    expect(conv("ACQ-S1").confirmedAt).toBeNull();
    const view = await support.simulateTriageDone("ACQ-S1");
    expect(view.state).toBe("request_open");
    expect(view.confirmedAt).not.toBeNull();
    const req = state.requests.find((r) => r.id === conv("ACQ-S1").requestId)!;
    expect(req.origin).toEqual({ kind: "support", conversationId: conv("ACQ-S1").id });
    expect(req.description).toBe(conv("ACQ-S1").rewrittenWish);
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "support.request",
      objectCode: req.code,
      link: `#/p/ACQ/requests?request=${req.id}`,
    });
    await expect(support.simulateTriageDone("ACQ-S1")).rejects.toThrow("invalid: state");
  });

  it("la richiesta dal server MCP ha la conversazione", async () => {
    as("p-sara");
    const s4 = (await support.getSupportConversation("ACQ-S4"))!;
    expect(s4.channel).toBe("mcp");
    const req = state.requests.find((r) => r.id === s4.request!.id)!;
    expect(req.origin).toEqual({ kind: "support", conversationId: s4.id });
    expect(s4.messages.length).toBeGreaterThan(0);
  });
});

describe("customerStatus segue richiesta → task → rilascio", () => {
  it("ricevuta → in valutazione → pianificata → in lavorazione → rilasciata", async () => {
    as("p-matteo");
    const status = async () => (await support.customerPreview("ACQ-S2"))!.status;
    expect(await status()).toBe("received");
    await startRefine("req-acq-1");
    expect(await status()).toBe("evaluating");
    const task = await convertRequest("req-acq-1", { title: "Instalments", type: "feature" });
    expect(await status()).toBe("planned");
    state.tasksById.get(task.id)!.claude = "working";
    expect(await status()).toBe("in_progress");
    state.pullRequests.push({
      id: "pr-x",
      projectId: ACQ,
      taskId: task.id,
      kind: "pr_opened",
      at: "2026-10-28T10:00:00Z",
      number: 7,
      repo: "acq/portal",
    });
    state.releases.push({
      id: "rel-x",
      code: "ACQ-V1",
      projectId: ACQ,
      repositoryId: "repo-none",
      pr: { repo: "acq/portal", number: 7 },
      title: "Instalments",
      mergeSha: "a".repeat(40),
      mergedAt: "2026-10-28T10:00:00Z",
      mergedById: "p-matteo",
      mergedGitName: "Matteo",
      viaStubwise: true,
      runs: [
        {
          id: "run-x",
          name: "CI",
          status: "running",
          url: "https://x",
          failedStep: null,
          log: null,
          startedAt: "2026-10-28T10:00:00Z",
          endedAt: null,
        },
      ],
      seenInProductionAt: null,
      fixTaskId: null,
    });
    expect(await status()).toBe("in_progress");
    state.releases.at(-1)!.runs[0]!.status = "success";
    expect(await status()).toBe("released");
    expect(await support.myRequestStatus("req-acq-1")).toEqual({
      code: expect.stringMatching(/^ACQ-R\d+$/),
      title: expect.any(String),
      status: "released",
    });
  });
});

describe("failNext e resetApi", () => {
  it("una chiamata fallita non scrive", async () => {
    as("p-matteo");
    failNext("support.replyToCustomer");
    const before = conv("ACQ-S2").messages.length;
    await expect(support.replyToCustomer("ACQ-S2", "x")).rejects.toThrow(/Simulated failure/);
    expect(conv("ACQ-S2").messages).toHaveLength(before);
    failNext("support.listSupportConversations");
    await expect(support.listSupportConversations(ACQ)).rejects.toThrow(/Simulated failure/);
  });

  it("resetApi riporta conversazioni e widget al seme", async () => {
    as("p-matteo");
    await support.replyToCustomer("ACQ-S2", "x");
    await support.deleteWidget("wdg-acq-portal");
    resetApi();
    expect(conv("ACQ-S2").messages.at(-1)!.from).toBe("customer");
    expect(state.supportWidgets).toHaveLength(1);
  });
});
