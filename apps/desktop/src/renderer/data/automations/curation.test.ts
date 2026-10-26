import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automations, resetApi, setLatency } from "../api";
import { AUTOMATION_CASES, AUTOMATION_RUNS } from "../seed/automations";
import { BELLAVISTA_REPLY } from "../seed/automations/mail";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { visitSteps } from "../../domain/automations/fields";
import { resetViewerGrants, revokeProjectPermission } from "../viewer";

// Revisione del Task 5, giro 1: le letture e le scritture che le pagine delle
// Automations chiedevano e il livello dati non aveva (R-J16, proprietario e
// casella, problemi, sorgenti curate, «Remember», il tempo a ore).

const as = (personId: string) => setSessionPersonId(personId);
const A = AUTOMATION_CASES.automations;
const R = AUTOMATION_CASES.runs;
const S = AUTOMATION_CASES.sources;
const idle = () => automations.whenAutomationsIdle();
const auto = (id: string) => state.automations.find((a) => a.id === id)!;

/** Collega casella e account Google di una persona; restituisce l'indirizzo. */
function connectMailbox(personId: string): string {
  const email = `${personId.slice(2)}@example.com`;
  const account = state.googleAccounts.find((a) => a.personId === personId);
  if (account) account.status = "connected";
  else
    state.googleAccounts.push({
      personId,
      email,
      status: "connected",
      since: "2026-10-01T00:00:00Z",
    });
  state.mailboxes.push({
    personId,
    email,
    proposalsEnabled: false,
    syncedAt: "2026-10-01T00:00:00Z",
    sync: "ok",
  });
  return email;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  resetViewerGrants();
  as("p-giulia");
});

describe("R-J16: il testo della risposta del cliente lo vede solo il proprietario", () => {
  it("per chi non è il proprietario sparisce da attese, ingressi, variabili e campi di Claude", async () => {
    as("p-roberta");
    const view = (await automations.getRun(R.waitingApproval))!;
    expect(JSON.stringify(view)).not.toContain(BELLAVISTA_REPLY);
    const wait = view.log.find((e) => e.kind === "wait" && e.outcome === "ok")!;
    expect(wait.output["risposta.testo"]).toBe("");
    expect(wait.output["risposta.arrivata"]).toBe(true);
    expect(wait.replyHidden).toBe(true);
    const claude = view.log.find((e) => e.kind === "claude")!;
    expect(claude.input["risposta.testo"]).toBe("");
    expect(claude.replyHidden).toBe(true);
    // La motivazione di Claude resta (shape [A 21]).
    expect(claude.reason).toContain("orari di apertura");
    expect(view.vars["risposta.testo"]).toBe("");
    // Anche nelle righe d'elenco.
    const rows = await automations.listRuns({ automationId: A.clientData });
    expect(JSON.stringify(rows)).not.toContain(BELLAVISTA_REPLY);
  });

  it("il proprietario la legge intera; chi deve approvare vede l'anteprima (R-J14)", async () => {
    as("p-matteo");
    const view = (await automations.getRun(R.waitingApproval))!;
    expect(JSON.stringify(view)).toContain(BELLAVISTA_REPLY);
    expect(view.log.some((e) => e.replyHidden)).toBe(false);
    expect(view.ownerId).toBe("p-matteo");
  });
});

describe("accendere e pubblicare: casella e permessi di chi diventa proprietario", () => {
  it("la casella scelta resta sull'automazione; una non mia, mancante o scaduta è rifiutata", async () => {
    as("p-roberta");
    const mine = connectMailbox("p-roberta");
    await expect(
      automations.publish(A.newContract, { mailbox: "matteo@nowhere.example" }),
    ).rejects.toThrow("invalid: mailbox_missing");
    state.googleAccounts.find((g) => g.personId === "p-roberta")!.status = "expired";
    await expect(automations.publish(A.newContract, { mailbox: mine })).rejects.toThrow(
      "invalid: mailbox_expired",
    );
    state.googleAccounts.find((g) => g.personId === "p-roberta")!.status = "connected";
    await automations.publish(A.newContract, { mailbox: mine });
    expect(auto(A.newContract).mailbox).toBe(mine);
    expect(auto(A.newContract).ownerId).toBe("p-roberta");
  });

  it("senza nessuna casella, un flusso con email non si accende", async () => {
    as("p-roberta");
    await expect(automations.publish(A.newContract)).rejects.toThrow("invalid: mailbox_missing");
    expect(auto(A.newContract).ownerId).toBe("p-matteo");
  });

  it("senza il permesso di creare task nel progetto dell'automazione: `invalid: permission`", async () => {
    as("p-laura");
    revokeProjectPermission("p-laura", "prj-stw", "tickets.create" as never);
    await expect(automations.activate(A.draft)).rejects.toThrow("invalid: permission");
    expect(auto(A.draft).status).toBe("draft");
  });

  it("pausa e riaccensione scrivono e azzerano chi e quando", async () => {
    as("p-roberta");
    connectMailbox("p-roberta");
    await automations.pause(A.clientData);
    expect(auto(A.clientData).pausedById).toBe("p-roberta");
    expect(auto(A.clientData).pausedAt).toBeTruthy();
    await automations.activate(A.clientData);
    expect(auto(A.clientData).pausedById).toBeNull();
    expect(auto(A.clientData).pausedAt).toBeNull();
  });
});

describe("problemi della versione pubblicata e della bozza", () => {
  it("la riga porta anche gli errori della versione pubblicata", async () => {
    as("p-roberta");
    state.automationSources.find((s) => s.id === S.audin)!.status = "disconnected";
    const row = (await automations.listAutomations()).find((a) => a.id === A.newContract)!;
    expect(row.liveErrorCount).toBeGreaterThan(0);
  });
});

describe("duplicare (anche per riprendere una versione vecchia)", () => {
  it("una bozza nuova col flusso della versione scelta, a nome di chi duplica", async () => {
    as("p-roberta");
    const copy = await automations.duplicateAutomation(A.newContract, {
      version: 1,
      name: "Nuovo contratto (copia)",
    });
    expect(copy.status).toBe("draft");
    expect(copy.code).toMatch(/^AUT-\d+$/);
    expect(copy.code).not.toBe("AUT-1");
    expect(copy.createdById).toBe("p-roberta");
    const subject = JSON.stringify(copy.versions[0]!.flow);
    expect(subject).toContain("Benvenuti in Audin");
    await expect(
      automations.duplicateAutomation(A.newContract, { version: 9, name: "x" }),
    ).rejects.toThrow("invalid: version");
    as("p-laura");
    await expect(automations.duplicateAutomation(A.newContract, { name: "x" })).rejects.toThrow(
      "not_found",
    );
  });
});

describe("«Remember for <cliente>» nella scelta del progetto", () => {
  it("solo con `integrations.manage`; scrive la riga a nome di chi sceglie", async () => {
    as("p-matteo");
    await expect(
      automations.chooseProject(R.waitingProject, "prj-aud", { remember: true }),
    ).rejects.toThrow("forbidden");
    auto(A.newContract).ownerId = "p-roberta";
    as("p-roberta");
    await automations.chooseProject(R.waitingProject, "prj-aud", { remember: true });
    await idle();
    const link = state.clientProjectLinks.find((l) => l.clientKey === "forneriarossilari.example")!;
    expect(link).toMatchObject({
      clientName: "Forneria Rossi & Lari",
      projectId: "prj-aud",
      addedById: "p-roberta",
    });
    expect(link.addedAt).toBeTruthy();
  });
});

describe("il tempo a ore («+1 hour»)", () => {
  it("accetta ore e giorni; rifiuta zero e oltre 23 ore", async () => {
    as("p-roberta");
    await expect(automations.advanceTime(R.waitingEvent, 0, 0)).rejects.toThrow("invalid: days");
    await expect(automations.advanceTime(R.waitingEvent, 0, 24)).rejects.toThrow("invalid: days");
    await automations.advanceTime(R.waitingEvent, 0, 1);
    await idle();
    const clock = state.automationClock.get(R.waitingEvent)!;
    expect(Date.parse(clock) - Date.parse("2026-01-01T00:00:00Z")).toBeGreaterThan(0);
    expect(state.automationRuns.find((r) => r.id === R.waitingEvent)!.status).toBe("waiting_event");
  });
});

describe("sorgenti curate", () => {
  it("un webhook nuovo, rinominato, con l'indirizzo rigenerato; tutto con `integrations.manage`", async () => {
    as("p-laura");
    await expect(automations.createWebhookSource("Ordini e-shop")).rejects.toThrow("forbidden");
    as("p-roberta");
    const hook = await automations.createWebhookSource("Ordini e-shop");
    expect(hook).toMatchObject({
      kind: "webhook",
      status: "connected",
      connectedById: "p-roberta",
      fields: [],
    });
    expect(hook.address).toMatch(/^https:\/\/stubwise\.example\/hooks\/in\//);
    await automations.renameSource(hook.id, "Ordini del negozio");
    const before = hook.address;
    const after = await automations.regenerateWebhookAddress(hook.id);
    expect(after).not.toBe(before);
    expect(state.automationSources.find((s) => s.id === hook.id)).toMatchObject({
      name: "Ordini del negozio",
      address: after,
    });
    await expect(automations.regenerateWebhookAddress(S.audin)).rejects.toThrow(
      "invalid: not_webhook",
    );
  });

  it("l'esempio: JSON non valido detto, campi derivati con etichette e tipi, quelli usati che spariscono segnalati", async () => {
    as("p-roberta");
    const bad = await automations.previewWebhookExample(S.webhook, '{ "a": 1, }');
    expect(bad.error).toBeTruthy();
    const json = JSON.stringify({
      cliente: { nome: "Rossi Srl", email: "info@rossi.example" },
      ordine: { totale: 120, data: "2026-10-20", righe: [{ nome: "Pane", quantita: 3 }] },
    });
    const p = await automations.previewWebhookExample(S.webhook, json);
    expect(p.error).toBeNull();
    // `cliente.nome` resta con l'etichetta di prima; `richiesta.dati` sparisce ed è usata da AUD-A1.
    expect(p.fields.find((f) => f.key === "cliente.nome")!.label).toBe("Cliente");
    expect(p.fields.find((f) => f.key === "ordine.totale")).toMatchObject({
      type: "number",
      label: "Ordine totale",
    });
    expect(p.fields.find((f) => f.key === "ordine.data")!.type).toBe("date");
    expect(p.fields.find((f) => f.key === "ordine.righe")!.of!.map((f) => f.key)).toEqual([
      "nome",
      "quantita",
    ]);
    expect(p.missing.map((m) => m.key)).toContain("richiesta.dati");
    expect(p.missing.find((m) => m.key === "richiesta.dati")!.usedBy).toEqual(["AUD-A1"]);
    // L'anteprima non ha scritto niente.
    expect(
      state.automationSources
        .find((s) => s.id === S.webhook)!
        .fields.some((f) => f.key === "richiesta.dati"),
    ).toBe(true);
    await automations.setWebhookExample(S.webhook, json);
    const source = state.automationSources.find((s) => s.id === S.webhook)!;
    expect(source.sampleEvents[0]).toEqual(JSON.parse(json));
    expect(source.fields.some((f) => f.key === "richiesta.dati")).toBe(false);
    // AUD-A1 ora mostra un problema.
    const row = (await automations.listAutomations()).find((a) => a.id === A.clientData)!;
    expect(row.liveErrorCount).toBeGreaterThan(0);
  });

  it("etichetta e tipo di un campo di un webhook, anche dentro un elenco; valori non validi rifiutati", async () => {
    as("p-roberta");
    await automations.setWebhookExample(
      S.webhook,
      JSON.stringify({ cliente: { nome: "Rossi" }, righe: [{ nome: "Pane", quantita: 1 }] }),
    );
    await automations.updateWebhookField(S.webhook, "righe.nome", { label: "Prodotto" });
    await automations.updateWebhookField(S.webhook, "righe.quantita", { type: "text" });
    const righe = state.automationSources
      .find((s) => s.id === S.webhook)!
      .fields.find((f) => f.key === "righe")!;
    expect(righe.of).toEqual([
      { key: "nome", label: "Prodotto", type: "text" },
      { key: "quantita", label: "Quantita", type: "text" },
    ]);
    await expect(
      automations.updateWebhookField(S.webhook, "cliente.nome", { label: " " }),
    ).rejects.toThrow("invalid: label");
    await expect(
      automations.updateWebhookField(S.webhook, "cliente.nome", { type: "colore" as never }),
    ).rejects.toThrow("invalid: type");
    await expect(
      automations.updateWebhookField(S.webhook, "nessuno", { label: "x" }),
    ).rejects.toThrow("not_found");
    await expect(
      automations.updateWebhookField(S.audin, "cliente.nome", { label: "x" }),
    ).rejects.toThrow("invalid: not_webhook");
  });

  it("«Edit and send»: un evento scritto a mano fa partire le automazioni; tipi sbagliati no", async () => {
    as("p-roberta");
    const payload = {
      cliente: { nome: "Panificio Neri", email: "info@panificioneri.example" },
      richiesta: { funzione: "CRM", dati: "Il logo." },
    };
    const ids = await automations.simulateSourceEvent(S.webhook, { payload });
    await idle();
    expect(ids).toHaveLength(1);
    expect(state.automationRuns.find((r) => r.id === ids[0])!.event).toEqual(payload);
    await expect(
      automations.simulateSourceEvent(S.audin, { payload: { trattativa: { importo: "tanti" } } }),
    ).rejects.toThrow("invalid: event_types");
    await expect(automations.simulateSourceEvent(S.audin, { payload: [1] })).rejects.toThrow(
      "invalid: event",
    );
  });

  it("ricollegare scrive chi e quando; la tabella clienti porta «Added by»; i suggerimenti dagli eventi recenti", async () => {
    as("p-roberta");
    await automations.connectSource(S.hubspot);
    const hub = state.automationSources.find((s) => s.id === S.hubspot)!;
    expect(hub).toMatchObject({
      status: "connected",
      reconnectedById: "p-roberta",
      expiredAt: null,
    });
    await automations.setClientLink({
      clientKey: "neri.example",
      clientName: "Neri",
      projectId: "prj-aud",
    });
    expect(state.clientProjectLinks.find((l) => l.clientKey === "neri.example")).toMatchObject({
      addedById: "p-roberta",
    });
    const suggestions = await automations.listClientSuggestions();
    expect(suggestions).toContainEqual({
      clientKey: "forneriarossilari.example",
      clientName: "Forneria Rossi & Lari",
    });
    expect(suggestions.some((s) => s.clientKey === "cantinabellavista.example")).toBe(false);
    as("p-laura");
    expect(await automations.listClientSuggestions()).toEqual([]);
  });
});

describe("tabella cliente → progetto: un progetto che non vedo non si rivela", () => {
  it("la riga resta, senza l'id del progetto", async () => {
    as("p-laura");
    const links = await automations.listClientLinks();
    const mix = links.find((l) => l.clientKey === "mixcucine.example")!;
    expect(mix).toMatchObject({ projectId: "", projectVisible: false });
    expect(JSON.stringify(links)).not.toContain("prj-mkx");
  });
});

describe("revisione del Task 5, giro 2", () => {
  it("R-J14 sotto R-J16: chi decide senza essere il proprietario vede l'anteprima intera; registro e variabili restano nascosti", async () => {
    const run = state.automationRuns.find((r) => r.id === R.waitingApproval)!;
    const a = auto(run.automationId);
    for (const v of a.versions)
      visitSteps(v.flow.steps, (step) => {
        if ("approval" in step && step.approval.mode === "ask")
          step.approval = { mode: "ask", who: { personId: "p-roberta" } };
      });
    (run.pending!.preview as Record<string, unknown>).body = `Riassunto: ${BELLAVISTA_REPLY}`;
    // Il seme non condivide più l'oggetto fra anteprima e riga del registro.
    const seeded = AUTOMATION_RUNS.find((r) => r.id === R.waitingApproval)!;
    expect(seeded.log.some((e) => e.input === seeded.pending!.preview)).toBe(false);
    as("p-roberta");
    const view = (await automations.getRun(R.waitingApproval))!;
    expect(view.deciders).toEqual(["p-roberta"]);
    expect(JSON.stringify(view.pending!.preview)).toContain(BELLAVISTA_REPLY);
    expect(JSON.stringify(view.log)).not.toContain(BELLAVISTA_REPLY);
    expect(view.vars["risposta.testo"]).toBe("");
  });

  it("R-J14 sotto R-J16 anche se anteprima e riga del registro sono lo stesso oggetto (difesa in `viewRun`)", async () => {
    const run = state.automationRuns.find((r) => r.id === R.waitingApproval)!;
    const a = auto(run.automationId);
    for (const v of a.versions)
      visitSteps(v.flow.steps, (step) => {
        if ("approval" in step && step.approval.mode === "ask")
          step.approval = { mode: "ask", who: { personId: "p-roberta" } };
      });
    const shared = { ...run.pending!.preview, body: `Riassunto: ${BELLAVISTA_REPLY}` };
    run.pending!.preview = shared;
    run.log.find(
      (e) => e.outcome === "waiting" && e.kind === "sendEmail" && e.path === run.cursor,
    )!.input = shared;
    as("p-roberta");
    const view = (await automations.getRun(R.waitingApproval))!;
    expect(JSON.stringify(view.pending!.preview)).toContain(BELLAVISTA_REPLY);
    expect(JSON.stringify(view.log)).not.toContain(BELLAVISTA_REPLY);
  });

  it("il motore dà a ogni riga del registro la sua copia dell'anteprima", async () => {
    as("p-matteo");
    await automations.approve(R.waitingApproval);
    await idle();
    const run = state.automationRuns.find((r) => r.id === R.waitingApproval)!;
    const rows = run.log.filter((e) => e.path === "3/then/0/mancano informazioni/0");
    const waiting = rows.find((e) => e.outcome === "waiting")!;
    const ok = rows.find((e) => e.outcome === "ok")!;
    expect(ok.input).not.toBe(waiting.input);
  });

  it("l'email parte solo dalla casella scelta: se non è più del proprietario, `mailbox_missing` che la nomina", async () => {
    auto(A.clientData).mailbox = "vecchia-scelta@example.com";
    as("p-matteo");
    await automations.approve(R.waitingApproval);
    await idle();
    const run = state.automationRuns.find((r) => r.id === R.waitingApproval)!;
    expect(run).toMatchObject({ status: "failed", error: "mailbox_missing" });
    expect(run.log.at(-1)!.reason).toContain("vecchia-scelta@example.com");
  });

  it("con la casella scelta ancora collegata l'email parte", async () => {
    const box = state.mailboxes.find((b) => b.personId === "p-matteo")!.email;
    auto(A.clientData).mailbox = box.toUpperCase();
    as("p-matteo");
    await automations.approve(R.waitingApproval);
    await idle();
    expect(state.automationRuns.find((r) => r.id === R.waitingApproval)!.status).not.toBe("failed");
  });

  it("«Edit and send» controlla anche date, email e i campi dentro gli elenchi", async () => {
    as("p-roberta");
    const bad = [
      { trattativa: { chiusaIl: "ieri" } },
      { cliente: { email: "non-un-indirizzo" } },
      { trattativa: { prodotti: [{ nome: "CRM", quantita: "tre" }] } },
    ];
    for (const payload of bad)
      await expect(automations.simulateSourceEvent(S.audin, { payload })).rejects.toThrow(
        "invalid: event_types",
      );
  });

  it("un campo usato si conta solo nella versione pubblicata e nella bozza, anche dentro un `forEach`", async () => {
    as("p-roberta");
    const a = auto(A.clientData);
    const old = a.versions[0]!;
    // v1 diventa vecchia: la v2 pubblicata non cita più `richiesta.dati`, e scorre `righe` con `r.nome`.
    const live = JSON.parse(
      JSON.stringify(old.flow).replaceAll("richiesta.dati", "richiesta.funzione"),
    );
    live.steps.push({
      id: "each",
      kind: "forEach",
      list: "righe",
      as: "r",
      steps: [
        {
          id: "t",
          kind: "notify",
          who: { personId: "p-matteo" },
          text: "{{r.nome}}",
          approval: { mode: "auto" },
        },
      ],
    });
    a.versions.push({
      n: 2,
      flow: live,
      publishedAt: "2026-10-22T10:00:00Z",
      publishedById: "p-matteo",
    });
    const source = state.automationSources.find((x) => x.id === S.webhook)!;
    source.fields.push({
      key: "righe",
      label: "Righe",
      type: "list",
      of: [{ key: "nome", label: "Nome", type: "text" }],
    });
    const p = await automations.previewWebhookExample(
      S.webhook,
      JSON.stringify({ cliente: { nome: "X", email: "x@x.example" }, righe: [{ quantita: 1 }] }),
    );
    expect(p.missing.find((m) => m.key === "righe.nome")?.usedBy).toEqual(["AUD-A1"]);
    // `richiesta.dati` lo cita solo la v1, che non gira più.
    expect(p.missing.some((m) => m.key === "richiesta.dati")).toBe(false);
  });
});
