import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  convertRequest,
  createRequest,
  failNext,
  resetApi,
  setLatency,
  startRefine,
  support,
} from "../api";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { __secretValuesForTest } from "../admin/secrets";
import { markReauthenticated, REAUTH_REQUIRED } from "../auth/reauth";
import { advanceNow, now, state, visibleProjectIds } from "../store";
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
        "listWidgets",
        "myRequestStatus",
        "searchSupport",
        "replyToCollaborator",
        "openRequestFrom",
        "markNotConcluded",
        "createWidget",
        "updateWidget",
        "deleteWidget",
        "regenerateIdentitySecret",
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
      // Area 8, F3: con un esito la conversazione è chiusa, qualunque sia l'ultimo messaggio.
      "ACQ-S2": "request_open",
      "ACQ-S3": "not_concluded",
      "ACQ-S4": "request_open",
      // Area 10b: le due nate dal supporto, in coda.
      "ACQ-S5": "request_open",
      "ACQ-S6": "request_open",
      "ACQ-S7": "request_open",
      // Area 8, F3: la risposta del widget è bastata (il controllo dopo il silenzio).
      "ACQ-S8": "answered",
      // La successiva di ACQ-S2 (S17): il triage riparte.
      "ACQ-S9": "triage",
    });
    // Ordine dei gruppi (area 8, F3): non concluse, in triage, richiesta aperta
    // (la più recente prima), risposte.
    expect(list.map((c) => c.code)).toEqual([
      "ACQ-S3",
      "ACQ-S1",
      "ACQ-S9",
      "ACQ-S6",
      "ACQ-S4",
      "ACQ-S5",
      "ACQ-S2",
      "ACQ-S7",
      // `answered` in fondo: nessuna azione da fare.
      "ACQ-S8",
    ]);
    expect(
      (await support.listSupportConversations(ACQ, { state: "triage" })).map((c) => c.code),
    ).toEqual(["ACQ-S1", "ACQ-S9"]);
  });

  it("i membri vedono conversazione e richiesta; rispondere solo con support.manage", async () => {
    as("p-sara");
    const sara = (await support.getSupportConversation("ACQ-S2"))!;
    expect(sara.request).toMatchObject({ code: expect.stringMatching(/^ACQ-R\d+$/) });
    expect(sara.request!.customerStatus).toBe("received");
    expect(sara.canReplyToCollaborator).toBe(false);
    as("p-matteo");
    // ACQ-S2 è del widget: al cliente non si scrive, nemmeno con support.manage.
    expect((await support.getSupportConversation("ACQ-S2"))!.canReplyToCollaborator).toBe(false);
    // ACQ-S4 è del canale mcp: il collaboratore interno sì, con support.manage.
    expect((await support.getSupportConversation("ACQ-S4"))!.canReplyToCollaborator).toBe(true);
    as("p-sara");
    expect((await support.getSupportConversation("ACQ-S4"))!.canReplyToCollaborator).toBe(false);
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
    await expect(support.replyToCollaborator("ACQ-S2", "x")).rejects.toThrow("not_found");
    await expect(support.replyToCollaborator("ACQ-S99", "x")).rejects.toThrow("not_found");
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
      expect.objectContaining({ id: "wdg-acq-portal", conversationCount: 8 }),
    ]);
  });

  it("⌘K trova per codice e nome del cliente", async () => {
    as("p-sara");
    const r = await support.searchSupport("lucia");
    expect(r.map((x) => [x.code, x.route])).toEqual([
      ["ACQ-S2", "#/p/ACQ/support/ACQ-S2"],
      ["ACQ-S9", "#/p/ACQ/support/ACQ-S9"],
    ]);
    expect((await support.searchSupport("acq-s3")).map((x) => x.code)).toEqual(["ACQ-S3"]);
  });
});

describe("Review Focus 4: il cliente vede solo il suo", () => {
  it("anteprima: niente autori, bozze né commenti interni", async () => {
    as("p-matteo");
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
  });

  it("Sara non risponde: forbidden e nessun messaggio", async () => {
    as("p-sara");
    const before = conv("ACQ-S4").messages.length;
    await expect(support.replyToCollaborator("ACQ-S4", "Ciao")).rejects.toThrow("forbidden");
    expect(conv("ACQ-S4").messages).toHaveLength(before);
  });

  it("la risposta non tocca la Posta e non avvisa nessuno", async () => {
    as("p-matteo");
    const mail = structuredClone(state.mailMessages);
    const drafts = structuredClone(state.mailDrafts);
    const notifications = state.notifications.length;
    const view = await support.replyToCollaborator("ACQ-S4", "  Thanks.  ");
    expect(view.state).toBe("request_open");
    expect(conv("ACQ-S4").messages.at(-1)).toMatchObject({
      from: "team",
      authorId: "p-matteo",
      body: "Thanks.",
    });
    expect(state.mailMessages).toEqual(mail);
    expect(state.mailDrafts).toEqual(drafts);
    expect(state.notifications).toHaveLength(notifications);
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

describe("al cliente del widget il team non scrive mai (area 8, F3)", () => {
  it("replyToCollaborator su una conversazione del widget: invalid: channel in ogni stato, nessun messaggio", async () => {
    as("p-matteo");
    for (const code of ["ACQ-S1", "ACQ-S2", "ACQ-S3", "ACQ-S8"]) {
      const before = conv(code).messages.length;
      await expect(support.replyToCollaborator(code, "Hello")).rejects.toThrow("invalid: channel");
      expect(conv(code).messages).toHaveLength(before);
    }
  });

  it("sul canale mcp si risponde al collaboratore; senza support.manage no", async () => {
    as("p-matteo");
    const view = await support.replyToCollaborator("ACQ-S4", "We're looking into it.");
    expect(view.messages.at(-1)).toMatchObject({
      from: "team",
      authorId: "p-matteo",
      body: "We're looking into it.",
    });
    as("p-sara");
    await expect(support.replyToCollaborator("ACQ-S4", "Hi")).rejects.toThrow("forbidden");
  });
});

describe("la bozza di Claude non c'è più (area 8, F3, decisione del maintainer)", () => {
  it("nessuna funzione, nessun campo nella vista, nessuna bozza nel modello", async () => {
    as("p-matteo");
    expect("draftReply" in support).toBe(false);
    const view = (await support.getSupportConversation("ACQ-S2"))!;
    expect("claudeDraft" in view).toBe(false);
    expect(state.supportConversations.every((c) => !("claudeDraft" in c))).toBe(true);
  });
});

describe("«Scrivigli per email» non c'è più (area 8, F3, decisione del maintainer)", () => {
  it("il team non scrive al cliente per email da Support: nessuna funzione, nessun campo nella vista", async () => {
    as("p-matteo");
    expect("emailDraftFor" in support).toBe(false);
    const view = (await support.getSupportConversation("ACQ-S2"))!;
    expect("emailBlocked" in view).toBe(false);
  });
});

describe("scritture", () => {
  it("risposta vuota: invalid, nessun messaggio", async () => {
    as("p-matteo");
    const before = conv("ACQ-S4").messages.length;
    await expect(support.replyToCollaborator("ACQ-S4", "   ")).rejects.toThrow("invalid: body");
    expect(conv("ACQ-S4").messages).toHaveLength(before);
  });

  it("una richiesta con l'origine Support vuole support.manage anche da createRequest (review F3, m6)", async () => {
    // Sara ha backlog.create ma non support.manage.
    as("p-sara");
    const before = state.requests.length;
    await expect(
      createRequest({
        projectId: ACQ,
        title: "From the conversation",
        origin: { kind: "support", conversationId: conv("ACQ-S3").id },
      }),
    ).rejects.toThrow("forbidden");
    expect(state.requests).toHaveLength(before);
  });

  it("apri la richiesta da una non conclusa: support.manage e backlog.create, origine Support, una sola", async () => {
    as("p-silvia");
    await expect(
      support.openRequestFrom("ACQ-S3", { title: "Logout", description: "" }),
    ).rejects.toThrow("forbidden");
    // Area 8, F3: backlog.create non basta, serve anche support.manage.
    as("p-sara");
    await expect(
      support.openRequestFrom("ACQ-S3", { title: "Logout", description: "" }),
    ).rejects.toThrow("forbidden");
    expect((await support.getSupportConversation("ACQ-S3"))!.canOpenRequest).toBe(false);
    as("p-matteo");
    await expect(
      support.openRequestFrom("ACQ-S1", { title: "x", description: "" }),
    ).rejects.toThrow("invalid: state");
    expect((await support.getSupportConversation("ACQ-S3"))!.canOpenRequest).toBe(true);
    const [a, b] = await Promise.all([
      support.openRequestFrom("ACQ-S3", { title: "Logged out often", description: "Stay in." }),
      support.openRequestFrom("ACQ-S3", { title: "Logged out often", description: "Stay in." }),
    ]);
    expect(a.request!.id).toBe(b.request!.id);
    const req = state.requests.find((r) => r.id === a.request!.id)!;
    expect(req.origin).toEqual({ kind: "support", conversationId: conv("ACQ-S3").id, conversationCode: "ACQ-S3" });
    expect(req.requesterIds).toEqual([]);
    expect(state.requests.filter((r) => r.title === "Logged out often")).toHaveLength(1);
    expect(a.state).toBe("request_open");
    // Come la richiesta nata dal triage: un solo «support.request», col codice della richiesta.
    const alerts = state.notifications.filter(
      (n) => n.kind === "support.request" && n.objectCode === req.code,
    );
    expect(alerts).toHaveLength(1);
  });

  it("«Segui» non c'è più (area 8, F3): nessuna funzione, nessun campo, nessun follower", async () => {
    as("p-matteo");
    expect("followConversation" in support).toBe(false);
    const view = (await support.getSupportConversation("ACQ-S2"))!;
    expect("following" in view).toBe(false);
    expect(state.supportConversations.every((c) => !("followerIds" in c))).toBe(true);
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
    expect(state.supportWidgets.filter((x) => x.projectId === ACQ).map((x) => x.id)).toEqual([w.id]);
    // Area 8, F3: più AUD-S1 (l'esito è un ticket del widget di Audin) e ACQ-S9 (S17).
    expect(state.supportConversations).toHaveLength(10);
    const s1 = (await support.getSupportConversation("ACQ-S1"))!;
    expect(s1.widgetName).toBeNull();
  });
});

describe("la conversazione chiusa e la successiva (area 8, F3, S17)", () => {
  it("il seme: ACQ-S2 è chiusa e continua in ACQ-S9, che viene da lì", async () => {
    as("p-matteo");
    const s2 = (await support.getSupportConversation("ACQ-S2"))!;
    expect(s2.continuedIn).toEqual({ code: "ACQ-S9" });
    const s9 = (await support.getSupportConversation("ACQ-S9"))!;
    expect(s9.continuedFrom).toEqual({ code: "ACQ-S2" });
    expect(s9.state).toBe("triage");
  });

  it("un messaggio su una conversazione con esito apre la successiva: nessuna riga sulla chiusa", async () => {
    as("p-matteo");
    const before = conv("ACQ-S7").messages.length;
    const count = state.supportConversations.length;
    const view = await support.simulateCustomerMessage("ACQ-S7", "Is it done?");
    expect(conv("ACQ-S7").messages).toHaveLength(before);
    expect(state.supportConversations).toHaveLength(count + 1);
    expect(view.code).toBe("ACQ-S10");
    expect(view.continuedFrom).toEqual({ code: "ACQ-S7" });
    expect(view.messages.map((m) => [m.from, m.body])).toEqual([["customer", "Is it done?"]]);
    expect(view.customer).toEqual(conv("ACQ-S7").customer);
    expect(view.state).toBe("triage");
    // Il secondo messaggio va alla STESSA successiva.
    await support.simulateCustomerMessage("ACQ-S7", "Hello?");
    expect(state.supportConversations).toHaveLength(count + 1);
    expect(conv("ACQ-S10").messages).toHaveLength(2);
  });

  it("su una successiva chiusa a sua volta, se ne apre una terza in fondo alla catena", async () => {
    as("p-matteo");
    conv("ACQ-S9").requestId = conv("ACQ-S2").requestId;
    const view = await support.simulateCustomerMessage("ACQ-S2", "Still there?");
    expect(view.code).toBe("ACQ-S10");
    expect(view.continuedFrom).toEqual({ code: "ACQ-S9" });
    expect(conv("ACQ-S9").messages.at(-1)!.body).not.toBe("Still there?");
  });

  it("senza esito il messaggio resta nella stessa conversazione", async () => {
    as("p-matteo");
    const count = state.supportConversations.length;
    const view = await support.simulateCustomerMessage("ACQ-S3", "Still happening.");
    expect(view.code).toBe("ACQ-S3");
    expect(state.supportConversations).toHaveLength(count);
  });
});

describe("simulazioni e avvisi", () => {
  it("messaggio del cliente: nessun avviso (non c'è più «Segui» né support.customer_replied)", async () => {
    as("p-matteo");
    const notifications = state.notifications.length;
    await support.simulateCustomerMessage("ACQ-S2", "Hello?");
    expect(state.notifications).toHaveLength(notifications);
  });

  it("triage concluso: richiesta col desiderio riscritto e la conversazione, avviso", async () => {
    as("p-sara");
    expect(conv("ACQ-S1").confirmedAt).toBeNull();
    const view = await support.simulateTriageDone("ACQ-S1");
    expect(view.state).toBe("request_open");
    expect(view.confirmedAt).not.toBeNull();
    const req = state.requests.find((r) => r.id === conv("ACQ-S1").requestId)!;
    expect(req.origin).toEqual({ kind: "support", conversationId: conv("ACQ-S1").id, conversationCode: "ACQ-S1" });
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
    expect(req.origin).toEqual({ kind: "support", conversationId: s4.id, conversationCode: s4.code });
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
    failNext("support.replyToCollaborator");
    const before = conv("ACQ-S4").messages.length;
    await expect(support.replyToCollaborator("ACQ-S4", "x")).rejects.toThrow(/Simulated failure/);
    expect(conv("ACQ-S4").messages).toHaveLength(before);
    failNext("support.listSupportConversations");
    await expect(support.listSupportConversations(ACQ)).rejects.toThrow(/Simulated failure/);
  });

  it("resetApi riporta conversazioni e widget al seme", async () => {
    as("p-matteo");
    const seeded = conv("ACQ-S4").messages.length;
    await support.replyToCollaborator("ACQ-S4", "x");
    await support.deleteWidget("wdg-acq-portal");
    resetApi();
    expect(conv("ACQ-S4").messages).toHaveLength(seeded);
    // Il widget di ACQ e (area 8, F3) quello di Audin.
    expect(state.supportWidgets.map((w) => w.id)).toEqual(["wdg-acq-portal", "wdg-aud-help"]);
  });
});

describe("«Not concluded» su una conversazione answered (area 8, F3)", () => {
  it("con support.manage: torna fra quelle che aspettano il team, col nome di chi l'ha deciso", async () => {
    as("p-matteo");
    const before = (await support.getSupportConversation("ACQ-S8"))!;
    expect(before.state).toBe("answered");
    expect(before.canMarkNotConcluded).toBe(true);
    const after = await support.markNotConcluded("ACQ-S8");
    expect(after.state).toBe("not_concluded");
    expect(after.canMarkNotConcluded).toBe(false);
    expect(after.canOpenRequest).toBe(true);
    expect(after.triage).toMatchObject({ outcome: "not_concluded", byUserId: "p-matteo" });
  });

  it("senza support.manage: niente bottone e forbidden; la conversazione resta answered", async () => {
    as("p-sara");
    expect((await support.getSupportConversation("ACQ-S8"))!.canMarkNotConcluded).toBe(false);
    await expect(support.markNotConcluded("ACQ-S8")).rejects.toThrow("forbidden");
    expect((await support.getSupportConversation("ACQ-S8"))!.state).toBe("answered");
  });

  it("solo su una answered (invalid: state); su una già non conclusa la stessa vista", async () => {
    as("p-matteo");
    await expect(support.markNotConcluded("ACQ-S1")).rejects.toThrow("invalid: state");
    await expect(support.markNotConcluded("ACQ-S2")).rejects.toThrow("invalid: state");
    const s3 = conv("ACQ-S3").triage;
    expect((await support.markNotConcluded("ACQ-S3")).state).toBe("not_concluded");
    expect(conv("ACQ-S3").triage).toEqual(s3);
    expect((await support.getSupportConversation("ACQ-S1"))!.canMarkNotConcluded).toBe(false);
  });

  it("un progetto che non vede: not_found", async () => {
    as(outsider());
    await expect(support.markNotConcluded("ACQ-S8")).rejects.toThrow("not_found");
  });

  it("un messaggio nuovo del cliente rende vecchio il giudizio della persona: di nuovo in triage", async () => {
    as("p-matteo");
    await support.markNotConcluded("ACQ-S8");
    // Il cliente riscrive un minuto dopo (l'orologio del prototipo è fermo).
    advanceNow(60_000);
    expect((await support.simulateCustomerMessage("ACQ-S8", "Actually, one more thing")).state).toBe("triage");
  });
});

describe("l'esito che è un ticket del widget (area 8, F3)", () => {
  it("AUD-S1: l'esito è la task aperta dal widget, la richiesta non c'è; il blocco ha la task e cosa vede il cliente", async () => {
    as("p-matteo");
    const c = (await support.getSupportConversation("AUD-S1"))!;
    expect(c.state).toBe("request_open");
    expect(c.request).toBeNull();
    expect(c.task).toMatchObject({ code: "AUD-6", title: "Speed up the dashboard of large accounts" });
    expect(c.task!.customerStatus).toBe("planned");
  });
});

describe("l'identità dei clienti del widget (API per i siti, S6)", () => {
  const secretValues = () => __secretValuesForTest().flatMap((s) => s.values);

  it("rigenerare il segreto chiede la riconferma: senza, niente cambia", async () => {
    as("p-matteo");
    const before = structuredClone(state.supportWidgets.find((w) => w.id === "wdg-aud-help"));
    expect(await support.regenerateIdentitySecret("wdg-aud-help")).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(state.supportWidgets.find((w) => w.id === "wdg-aud-help")).toEqual(before);
    expect(REAUTH_REQUIRED.has("support.regenerateIdentitySecret")).toBe(true);
  });

  it("il segreto esce una volta sola, 32 byte in base64url; le letture dicono solo se c'è e da quando", async () => {
    as("p-matteo");
    markReauthenticated("p-matteo");
    const r = await support.regenerateIdentitySecret("wdg-acq-portal");
    if (!r.ok) throw new Error(r.error);
    expect(r.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.rotatedAt).toBe(now());
    const { widgets } = await support.listWidgets(ACQ);
    const w = widgets.find((x) => x.id === "wdg-acq-portal")!;
    expect(w).toMatchObject({ identitySecretSet: true, identitySecretRotatedAt: now() });
    expect(JSON.stringify(widgets)).not.toContain(r.secret);
    expect(JSON.stringify(state.supportWidgets)).not.toContain(r.secret);
    expect(JSON.stringify(state.changelog)).not.toContain(r.secret);
  });

  it("rigenerare spegne il vecchio SUBITO: il valore di prima non è più custodito", async () => {
    as("p-matteo");
    markReauthenticated("p-matteo");
    const first = await support.regenerateIdentitySecret("wdg-aud-help");
    const second = await support.regenerateIdentitySecret("wdg-aud-help");
    if (!first.ok || !second.ok) throw new Error("reauth");
    expect(second.secret).not.toBe(first.secret);
    expect(secretValues()).toContain(second.secret);
    expect(secretValues()).not.toContain(first.secret);
  });

  it("solo con widget.manage; chi non vede il progetto riceve not_found", async () => {
    as("p-sara");
    markReauthenticated("p-sara");
    await expect(support.regenerateIdentitySecret("wdg-acq-portal")).rejects.toThrow("forbidden");
    const out = outsider();
    as(out);
    markReauthenticated(out);
    await expect(support.regenerateIdentitySecret("wdg-acq-portal")).rejects.toThrow("not_found");
  });

  it("«Solo clienti verificati» si accende solo con un segreto, ed è un booleano", async () => {
    as("p-matteo");
    await expect(support.updateWidget("wdg-aud-help", { identityRequired: true })).rejects.toThrow(
      "invalid: identityRequired",
    );
    await expect(
      support.updateWidget("wdg-acq-portal", { identityRequired: "yes" as never }),
    ).rejects.toThrow("invalid: identityRequired");
    expect((await support.updateWidget("wdg-acq-portal", { identityRequired: true })).identityRequired).toBe(
      true,
    );
    expect((await support.updateWidget("wdg-acq-portal", { identityRequired: false })).identityRequired).toBe(
      false,
    );
    // Un widget nuovo nasce senza segreto e col toggle spento.
    expect(await support.createWidget(ACQ, { name: "New" })).toMatchObject({
      identitySecretSet: false,
      identitySecretRotatedAt: null,
      identityRequired: false,
    });
  });

  it("la conversazione dice se il cliente è verificato; la successiva NON lo eredita (72: la catena non promuove)", async () => {
    as("p-matteo");
    expect((await support.getSupportConversation("ACQ-S5"))!.identityVerified).toBe(true);
    expect((await support.getSupportConversation("ACQ-S1"))!.identityVerified).toBe(false);
    const next = await support.simulateCustomerMessage("ACQ-S5", "One more thing");
    expect(next.code).not.toBe("ACQ-S5");
    // Verificata solo se nasce con un token valido: il messaggio simulato non ne ha.
    expect(next.identityVerified).toBe(false);
    const declared = await support.simulateCustomerMessage("ACQ-S7", "Hello again");
    expect(declared.code).not.toBe("ACQ-S7");
    expect(declared.identityVerified).toBe(false);
  });
});
