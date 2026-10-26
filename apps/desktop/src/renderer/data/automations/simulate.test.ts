import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automations, createTask, failNext, resetApi, setLatency } from "../api";
import { AUTOMATION_CASES } from "../seed/automations";
import { runBeforePersonaChange, setSessionPersonId } from "../session";
import { now, state, visibleProjectIds } from "../store";
import type { AutomationFlow, Step } from "../types";
import { grantInstancePermission } from "../viewer";
import { SimulationConfigError } from "./simulate";
import { holdersOfRole } from "./visibility";

const as = (personId: string) => setSessionPersonId(personId);
const A = AUTOMATION_CASES.automations;
const S = AUTOMATION_CASES.sources;
const AUD = "prj-aud";
const sample = (sourceId: string, i: number) =>
  state.automationSources.find((s) => s.id === sourceId)!.sampleEvents[i]!;
const idle = () => automations.whenAutomationsIdle();
const DAY = 86_400_000;
const inDays = (days: number) =>
  new Date(Date.parse(now()) + days * DAY).toISOString().slice(0, 10);

/** Tutto lo stato del prototipo, contatori compresi: la prova non deve toccarne nulla. */
const snapshot = () => structuredClone(state);

/** Il codice che avrebbe la prossima task di un progetto. */
function nextTaskCode(projectId: string): string {
  const p = state.projectsById.get(projectId)!;
  const max = state.tasks
    .filter((t) => t.projectId === projectId)
    .reduce((m, t) => Math.max(m, Number(t.code.split("-").at(-1)) || 0), 0);
  return `${p.code}-${max + 1}`;
}

const AUTO = { mode: "auto" } as const;

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-matteo");
});

afterEach(async () => {
  await idle();
});

describe("Automations: la prova (simulazione)", () => {
  it("«Nuovo contratto» provato da cima a fondo: anteprime complete e NESSUNA scrittura nello store", async () => {
    const before = snapshot();
    const nextCode = nextTaskCode("prj-cbv");
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    // Non corre da sola: si ferma subito sul primo passo (Claude).
    let sim = (await automations.getSimulation(id))!;
    expect(sim).toMatchObject({ status: "running", cursor: "0", version: 1, ownerId: "p-matteo" });
    expect(sim.current).toMatchObject({ kind: "claude", path: "0" });
    expect(sim.log.map((e) => e.kind)).toEqual(["trigger"]);

    // «Passo successivo»: risponde il Claude finto (lo stesso delle esecuzioni vere).
    sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.preview.claude).toEqual([
      expect.objectContaining({
        path: "0",
        outcome: null,
        fields: expect.objectContaining({ "analisi.prodotto": "CRM" }),
        reason: expect.stringMatching(/contratto/),
      }),
    ]);
    // Il prossimo passo è il traguardo, già col progetto del cliente risolto.
    expect(sim.current).toMatchObject({
      kind: "createMilestone",
      preview: {
        kind: "milestone",
        name: "Attivazione CRM – Cantina Bellavista Srl",
        project: { id: "prj-cbv", code: "CBV" },
        dueDate: inDays(30),
      },
    });

    // «Vai alla prossima fermata»: si ferma all'approvazione dell'email.
    sim = await automations.simulationStep(id, { kind: "run" });
    expect(sim.status).toBe("waiting_approval");
    expect(sim.preview.milestones).toHaveLength(1);
    expect(
      sim.preview.tasks.map((t) => [t.title, t.departmentId, t.assignedBy, t.assigneeId]),
    ).toEqual([
      ["Importare l'anagrafica clienti nel CRM", "dep-development", "department", null],
      ["Pianificare le sessioni di formazione sul CRM", "dep-sales", "department", null],
      ["Configurare il Centralino AI", "dep-support", "department", null],
      ["Fatturare il primo canone all'attivazione", "dep-administration", "department", null],
    ]);
    for (const t of sim.preview.tasks) {
      expect(t).toMatchObject({
        project: { id: "prj-cbv", code: "CBV" },
        dueDate: inDays(14),
        milestone: { name: "Attivazione CRM – Cantina Bellavista Srl", stepId: "nc-milestone" },
      });
    }
    // Nessun codice inventato nel registro della prova.
    expect(sim.log.flatMap((e) => e.effects).every((x) => x.code === "")).toBe(true);
    expect(sim.waiting).toMatchObject({
      kind: "approval",
      path: "3",
      realApproverIds: ["p-matteo"],
    });
    const box = state.mailboxes.find((b) => b.personId === "p-matteo")!.email;
    expect(sim.current?.preview).toMatchObject({
      kind: "email",
      from: box,
      to: "amministrazione@cantinabellavista.example",
      subject: "Benvenuti in Audin, Cantina Bellavista Srl",
      body: expect.stringContaining("attivazione di CRM"),
    });
    // A metà prova lo store è identico.
    expect(state).toEqual(before);

    sim = await automations.simulationStep(id, { kind: "approved", path: "3", byId: "x" });
    expect(sim.status).toBe("running");
    sim = await automations.simulationStep(id, { kind: "run" });
    expect(sim.status).toBe("done");
    expect(sim.preview.emails).toHaveLength(1);
    expect(sim.log.find((e) => e.outcome === "approved")?.byId).toBe("p-matteo");

    await automations.endSimulation(id);
    await idle();
    expect(state).toEqual(before);
    expect(state.automationRuns).toHaveLength(before.automationRuns.length);
    // Il codice della prossima task vera non è cambiato.
    const real = await createTask({ projectId: "prj-cbv", title: "Vera" });
    expect(real.code).toBe(nextCode);
  });

  it("le approvazioni nella prova le dà chi prova, a nome suo; la riga dice chi approverebbe davvero", async () => {
    as("p-roberta");
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    let sim = await automations.simulationStep(id, { kind: "run" });
    expect(sim.waiting).toMatchObject({ kind: "approval", realApproverIds: ["p-matteo"] });
    // La correzione prima di approvare: solo i campi dell'anteprima.
    await expect(
      automations.simulationStep(id, {
        kind: "approved",
        path: "3",
        byId: "p-roberta",
        edited: { from: "x" },
      }),
    ).rejects.toThrow("invalid: edited");
    sim = await automations.simulationStep(id, {
      kind: "approved",
      path: "3",
      byId: "p-matteo",
      edited: { subject: "Benvenuti!" },
    });
    expect(sim.log.find((e) => e.outcome === "approved")?.byId).toBe("p-roberta");
    sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.status).toBe("done");
    expect(sim.preview.emails[0]?.subject).toBe("Benvenuti!");
  });

  it("la bozza si prova come la proverebbe chi la accende: proprietario chi prova", async () => {
    as("p-roberta");
    const id = await automations.startSimulation(A.newContract, "draft", sample(S.audin, 0));
    const sim = (await automations.getSimulation(id))!;
    expect(sim).toMatchObject({ version: 2, draft: true, ownerId: "p-roberta" });
    await expect(automations.startSimulation(A.clientData, "draft", {})).rejects.toThrow(
      "invalid: no_draft",
    );
  });

  it("le attese: «Avanti» le supera, la risposta del cliente si scrive, Claude la verifica", async () => {
    const before = snapshot();
    const id = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 0));
    let sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.preview.emails).toHaveLength(1);
    expect(sim.status).toBe("waiting_event");
    expect(sim.waiting).toMatchObject({
      kind: "event",
      path: "1",
      until: expect.stringContaining(inDays(5)),
      wait: { replyTo: "cd-ask", maxDays: 5 },
      email: { subject: "Ci servono alcuni dati per attivare Centralino AI" },
    });
    // «Passo successivo» non scavalca un'attesa.
    await expect(automations.simulationStep(id, { kind: "next" })).rejects.toThrow(
      "invalid: stopped",
    );
    // «Vai avanti di 5 giorni — nessuna risposta».
    const until = sim.waiting?.kind === "event" ? sim.waiting.until : "";
    sim = await automations.simulationStep(id, { kind: "time", now: until });
    expect(sim.status).toBe("running");
    expect(sim.current).toMatchObject({ kind: "sendEmail", path: "2/repeat[0]/0" });
    sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.waiting).toMatchObject({ kind: "event", wait: { replyTo: "cd-remind" } });
    // La risposta scritta nella prova.
    sim = await automations.simulationStep(id, {
      kind: "event",
      payload: {
        kind: "reply",
        to: "cd-remind",
        text: "I numeri da collegare sono 0577 000111 e 0577 000112; gli orari di apertura dalle 9 alle 18; il messaggio di benvenuto: «Benvenuti in cantina».",
      },
    });
    sim = await automations.simulationStep(id, { kind: "run" });
    expect(sim.status).toBe("done");
    expect(sim.preview.claude.at(-1)).toMatchObject({
      outcome: "tutto presente",
      reason: "La risposta contiene tutto quello che era stato chiesto.",
    });
    expect(sim.preview.tasks).toEqual([
      expect.objectContaining({
        title: "Attivare Centralino AI per Cantina Bellavista Srl",
        project: expect.objectContaining({ id: AUD }),
        departmentId: "dep-development",
      }),
    ]);
    expect(sim.preview.emails).toHaveLength(2);
    expect(state).toEqual(before);
  });

  it("al limite dei promemoria: la task del Project Lead, risolto come nell'esecuzione vera", async () => {
    const id = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 1));
    let sim = await automations.simulationStep(id, { kind: "next" });
    for (let i = 0; i < 3; i++) {
      const until = sim.waiting?.kind === "event" ? sim.waiting.until : "";
      sim = await automations.simulationStep(id, { kind: "time", now: until });
      if (sim.status === "running") sim = await automations.simulationStep(id, { kind: "run" });
    }
    expect(sim.status).toBe("done");
    const lead = holdersOfRole(AUD, "project_lead")[0]!;
    expect(sim.preview.tasks).toEqual([
      expect.objectContaining({
        title: "Chiamare Mix Cucine Srl: nessuna risposta alla richiesta dati",
        assigneeId: lead,
        assignedBy: "role",
        role: "project_lead",
        warning: null,
      }),
    ]);
    expect(sim.log.find((e) => e.outcome === "limit")?.path).toBe("2");
  });

  it("una risposta incompleta: Claude dice cosa manca, l'email da approvare si rifiuta nella prova", async () => {
    const id = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 0));
    await automations.simulationStep(id, { kind: "next" });
    await automations.simulationStep(id, {
      kind: "event",
      payload: { kind: "reply", to: "cd-ask", text: "Gli orari di apertura sono dalle 9 alle 18." },
    });
    let sim = await automations.simulationStep(id, { kind: "run" });
    expect(sim.preview.claude[0]).toMatchObject({
      outcome: "mancano informazioni",
      fields: { "verifica.mancanti": expect.stringContaining("numeri") },
    });
    expect(sim.status).toBe("waiting_approval");
    expect(sim.current?.preview).toMatchObject({
      kind: "email",
      subject: "Mancano ancora alcuni dati per Centralino AI",
    });
    sim = await automations.simulationStep(id, { kind: "rejected", path: "", byId: "" });
    expect(sim).toMatchObject({ status: "cancelled", error: "rejected" });
    expect(sim.log.at(-1)).toMatchObject({ outcome: "rejected", byId: "p-matteo" });
    expect(sim.preview.emails).toHaveLength(1);
  });

  it("cliente fuori dalla tabella: la prova chiede il progetto, senza toccare la tabella", async () => {
    const links = structuredClone(state.clientProjectLinks);
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 2));
    let sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.status).toBe("waiting_project");
    expect(sim.waiting).toMatchObject({
      kind: "project",
      clientKey: "forneriarossilari.example",
      ownerId: "p-matteo",
    });
    await expect(
      automations.simulationStep(id, { kind: "project_chosen", projectId: "prj-nope" }),
    ).rejects.toThrow("not_found");
    sim = await automations.simulationStep(id, { kind: "project_chosen", projectId: AUD });
    expect(sim.current?.preview).toMatchObject({
      kind: "milestone",
      project: { id: AUD, code: "AUD" },
    });
    expect(sim.log.at(-1)).toMatchObject({ outcome: "approved", byId: "p-matteo" });
    expect(state.clientProjectLinks).toEqual(links);
  });

  it("se la vera fallirebbe, la prova fallisce allo stesso passo con lo stesso motivo", async () => {
    state.googleAccounts.find((a) => a.personId === "p-matteo")!.status = "expired";
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    let sim = await automations.simulationStep(id, { kind: "run" });
    // Già prima di approvare l'anteprima dice cosa succederebbe.
    expect(sim.current?.failure).toMatchObject({ error: "mailbox_expired" });
    await automations.simulationStep(id, { kind: "approved", path: "3", byId: "p-matteo" });
    sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim).toMatchObject({ status: "failed", error: "mailbox_expired", cursor: "3" });
    expect(sim.log.at(-1)).toMatchObject({
      outcome: "failed",
      kind: "sendEmail",
      reason:
        "La casella del proprietario (Matteo Conti) è scaduta: va ricollegata prima di riprovare.",
    });
    await expect(automations.simulationStep(id, { kind: "next" })).rejects.toThrow(
      "invalid: finished",
    );
  });

  it("R-J11 anche nella prova: un'approvazione che nessuno potrebbe dare fallisce `no_approver`", async () => {
    // Il ruolo nel progetto del cliente si sa solo dall'evento: la configurazione non lo vede.
    const flow: AutomationFlow = {
      trigger: { kind: "source", sourceId: S.audin, event: "deal_won" },
      titleTemplate: "Ruolo",
      steps: [
        {
          id: "t1",
          kind: "createTask",
          title: "Per {{cliente.nome}}",
          description: "",
          assignee: null,
          dueInDays: null,
          project: { mode: "from_client", clientRef: "cliente.dominio" },
          milestoneRef: null,
          approval: { mode: "ask", who: { projectRole: "nessuno" } },
        },
      ],
    };
    const a = await automations.createAutomation({ name: "Ruolo", projectId: null, flow });
    const id = await automations.startSimulation(a.id, "draft", sample(S.audin, 0));
    const sim = (await automations.getSimulation(id))!;
    expect(sim).toMatchObject({ status: "failed", error: "no_approver", waiting: null });
    expect(sim.log.at(-1)).toMatchObject({
      outcome: "failed",
      path: "0",
      reason: expect.stringMatching(/^Nessuno può approvare questo passo/),
    });
  });

  it("«Avvia un'altra automazione» dice solo che partirebbe: nessuna esecuzione, i suoi passi non si percorrono", async () => {
    // Una bozza mai accesa, che Matteo vede.
    const off = await automations.createAutomation({ name: "Spenta", projectId: AUD });
    const flow: AutomationFlow = {
      trigger: { kind: "manual" },
      titleTemplate: "Catena",
      steps: [
        { id: "s1", kind: "startAutomation", automationId: A.clientData, approval: AUTO },
        { id: "s2", kind: "startAutomation", automationId: off.id, approval: AUTO },
      ],
    };
    const a = await automations.createAutomation({ name: "Catena", projectId: AUD, flow });
    const before = snapshot();
    const id = await automations.startSimulation(a.id, "draft", { avvio: { data: "2026-10-26" } });
    let sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.preview.starts).toEqual([
      expect.objectContaining({ automationId: A.clientData, code: "AUD-A1", path: "0" }),
    ]);
    // La bozza non è attiva: la vera fallirebbe, la prova pure.
    sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim).toMatchObject({ status: "failed", error: "automation_not_active" });
    expect(state).toEqual(before);
  });

  it("errori di configurazione: la prova non parte e dice dove", async () => {
    const flow: AutomationFlow = {
      trigger: { kind: "manual" },
      titleTemplate: "Rotta",
      steps: [
        { id: "s1", kind: "startAutomation", automationId: "aut-nope", approval: AUTO },
        {
          id: "s2",
          kind: "notify",
          personRef: "p-marco",
          text: "",
          approval: AUTO,
        } as Step,
      ],
    };
    const a = await automations.createAutomation({ name: "Rotta", projectId: AUD, flow });
    const error = await automations.startSimulation(a.id, "draft", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SimulationConfigError);
    expect((error as SimulationConfigError).message).toBe("invalid: config");
    expect((error as SimulationConfigError).issues).toContainEqual(
      expect.objectContaining({ path: "0", code: "unknown_ref" }),
    );
  });

  it("chi vede ma non gestisce non prova; chi non vede riceve not_found; la prova di un altro non si legge", async () => {
    const id = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 0));
    as("p-marco");
    await expect(automations.startSimulation(A.clientData, 1, {})).rejects.toThrow("forbidden");
    expect(await automations.getSimulation(id)).toBeNull();
    await expect(automations.simulationStep(id, { kind: "next" })).rejects.toThrow("not_found");
    await expect(automations.endSimulation(id)).rejects.toThrow("not_found");
    as("p-sara");
    await expect(automations.startSimulation(A.newContract, 1, {})).rejects.toThrow("not_found");
    await expect(automations.startSimulation("aut-nope", 1, {})).rejects.toThrow("not_found");
    as("p-matteo");
    await expect(automations.startSimulation(A.clientData, 9, {})).rejects.toThrow(
      "invalid: version",
    );
  });

  it("chi prova non può iniettare risultati di effetti o di Claude", async () => {
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    await expect(
      automations.simulationStep(id, { kind: "claude_result", outcome: "x", reason: "y" }),
    ).rejects.toThrow("invalid: input");
    await expect(
      automations.simulationStep(id, { kind: "effect_result", ok: true }),
    ).rejects.toThrow("invalid: input");
  });

  it("i progetti che chi prova non vede restano senza id né nome (R-G5)", async () => {
    grantInstancePermission("p-laura", "automations.manage");
    as("p-laura");
    expect(state.projectsById.get("prj-cbv")!.memberIds).not.toContain("p-laura");
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    let sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.current?.preview).toMatchObject({
      kind: "milestone",
      project: { id: "", code: "", name: "" },
    });
    sim = await automations.simulationStep(id, { kind: "run" });
    expect(sim.preview.tasks).toHaveLength(4);
    expect(sim.preview.tasks.every((t) => t.project.id === "")).toBe(true);
    const text = JSON.stringify(sim);
    expect(text).not.toContain("prj-cbv");
    expect(text).not.toContain('"CBV"');
  });

  it("le prove vivono in memoria: si buttano con endSimulation, resetApi e il cambio di persona", async () => {
    const one = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 0));
    await automations.endSimulation(one);
    expect(await automations.getSimulation(one)).toBeNull();
    const two = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 0));
    runBeforePersonaChange();
    expect(await automations.getSimulation(two)).toBeNull();
    const three = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 0));
    resetApi();
    setLatency(0);
    as("p-matteo");
    expect(await automations.getSimulation(three)).toBeNull();
  });

  it("«Avanti» due volte, o mentre un effetto aspetta: rifiutato, e la prova va ancora avanti", async () => {
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    let sim = (await automations.getSimulation(id))!;
    // Claude in sospeso: il tempo non si sposta e l'effetto non si perde.
    await expect(automations.simulationStep(id, { kind: "time", now: sim.now })).rejects.toThrow(
      "invalid: not_waiting",
    );
    sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.preview.claude).toHaveLength(1);

    const other = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 0));
    sim = await automations.simulationStep(other, { kind: "next" });
    const until = sim.waiting?.kind === "event" ? sim.waiting.until : "";
    sim = await automations.simulationStep(other, { kind: "time", now: until });
    expect(sim.current).toMatchObject({ kind: "sendEmail", path: "2/repeat[0]/0" });
    await expect(automations.simulationStep(other, { kind: "time", now: until })).rejects.toThrow(
      "invalid: not_waiting",
    );
    sim = await automations.simulationStep(other, { kind: "next" });
    expect(sim.preview.emails).toHaveLength(2);
    expect(sim.status).toBe("waiting_event");
  });

  it("nessuna scrittura anche con «Avvisa» e un'email che torna indietro (stesso esito della vera)", async () => {
    const flow: AutomationFlow = {
      trigger: { kind: "source", sourceId: S.audin, event: "deal_won" },
      titleTemplate: "Avvisi",
      steps: [
        {
          id: "n1",
          kind: "notify",
          personRef: "trattativa.commerciale",
          text: "Chiusa {{trattativa.titolo}}",
          approval: AUTO,
        },
        {
          id: "e1",
          kind: "sendEmail",
          to: "{{cliente.email}}",
          subject: "Benvenuti",
          body: "Ciao",
          attachRefs: ["trattativa.contratto"],
          approval: AUTO,
        },
      ],
    };
    const a = await automations.createAutomation({ name: "Avvisi", projectId: AUD, flow });
    const event = structuredClone(sample(S.audin, 0)) as {
      cliente: { email: string };
    } & Record<string, unknown>;
    event.cliente.email = "nessuno@bounce.example";
    const before = snapshot();
    const id = await automations.startSimulation(a.id, "draft", event);
    const sim = await automations.simulationStep(id, { kind: "run" });
    expect(sim.preview.notifications).toEqual([
      expect.objectContaining({
        personId: "p-elena",
        text: expect.stringContaining("Chiusa CRM"),
        project: expect.objectContaining({ id: AUD }),
      }),
    ]);
    expect(sim).toMatchObject({ status: "failed", error: "address_not_found", cursor: "1" });
    expect(sim.log.at(-1)?.reason).toBe(
      "L'indirizzo «nessuno@bounce.example» non esiste: l'email è tornata indietro.",
    );
    await automations.endSimulation(id);
    await idle();
    expect(state).toEqual(before);
  });

  it("il promemoria partirebbe nella stessa conversazione della richiesta, come nella vera", async () => {
    const id = await automations.startSimulation(A.clientData, 1, sample(S.webhook, 0));
    let sim = await automations.simulationStep(id, { kind: "next" });
    const until = sim.waiting?.kind === "event" ? sim.waiting.until : "";
    sim = await automations.simulationStep(id, { kind: "time", now: until });
    sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.preview.emails.map((e) => e.sameConversationAs)).toEqual([
      null,
      { stepId: "cd-ask", path: "0" },
    ]);
  });

  it("Claude dice quali documenti ha letto", async () => {
    const id = await automations.startSimulation(A.newContract, 1, sample(S.audin, 0));
    const sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.preview.claude[0]?.read).toEqual(["Contratto AUD-TR-1042.pdf"]);
  });

  it("R-G5: un'automazione da avviare che chi prova non vede resta senza id, codice e nome", async () => {
    const flow: AutomationFlow = {
      trigger: { kind: "manual" },
      titleTemplate: "Avvia",
      steps: [{ id: "s1", kind: "startAutomation", automationId: A.clientData, approval: AUTO }],
    };
    const a = await automations.createAutomation({ name: "Avvia", projectId: null, flow });
    await automations.activate(a.id);
    grantInstancePermission("p-sara", "automations.manage");
    as("p-sara");
    const id = await automations.startSimulation(a.id, 1, { avvio: { data: "2026-10-26" } });
    let sim = (await automations.getSimulation(id))!;
    expect(sim.current?.preview).toMatchObject({ kind: "start", automationId: "", code: "" });
    sim = await automations.simulationStep(id, { kind: "next" });
    expect(sim.status).toBe("done");
    expect(sim.preview.starts).toEqual([
      expect.objectContaining({ automationId: "", code: "", name: "" }),
    ]);
    const text = JSON.stringify(sim);
    expect(text).not.toContain(A.clientData);
    expect(text).not.toContain("AUD-A1");
    expect(text).not.toContain("Richiesta dati al cliente");
  });

  it("failNext: la prova che non parte", async () => {
    failNext("automations.startSimulation");
    await expect(automations.startSimulation(A.clientData, 1, {})).rejects.toThrow(
      "Simulated failure",
    );
  });
});

describe("Automations: gli esempi della prova", () => {
  const draftWith = (trigger: AutomationFlow["trigger"], projectId: string | null) =>
    automations.createAutomation({
      name: "Esempi",
      projectId,
      flow: { trigger, titleTemplate: "Esempi", steps: [] },
    });

  it("da una sorgente collegata i suoi eventi d'esempio, il più recente in alto; scaduta → nessuno", async () => {
    const examples = await automations.listSimulationExamples(A.newContract, 1);
    expect(examples.map((e) => e.label)).toEqual([
      "CRM + Campagne WhatsApp + Preventivi online – Forneria Rossi & Lari",
      "Campagne WhatsApp – Mix Cucine Srl",
      "CRM + Centralino AI – Cantina Bellavista Srl",
    ]);
    expect(examples[2]!.event).toEqual(sample(S.audin, 0));
    const hub = await draftWith({ kind: "source", sourceId: S.hubspot, event: "deal_won" }, null);
    expect(await automations.listSimulationExamples(hub.id, "draft")).toEqual([]);
  });

  it("inizi di Stubwise: solo oggetti veri che chi prova vede, del progetto dell'automazione", async () => {
    const aud = await draftWith({ kind: "stubwise", event: "task_created" }, AUD);
    const own = await automations.listSimulationExamples(aud.id, "draft");
    expect(own.length).toBeGreaterThan(0);
    expect(
      own.every((e) => (e.event as { task: { progetto: string } }).task.progetto === "AUD"),
    ).toBe(true);
    // Una generale provata da Laura: mai task di progetti che Laura non vede.
    grantInstancePermission("p-laura", "automations.manage");
    as("p-laura");
    const general = await draftWith({ kind: "stubwise", event: "task_created" }, null);
    const seen = await automations.listSimulationExamples(general.id, "draft");
    const sees = visibleProjectIds("p-laura");
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) {
      const t = state.tasks.find((x) => x.code === e.code)!;
      expect(sees.has(t.projectId)).toBe(true);
    }
  });

  it("R-J13: le email d'esempio vengono SOLO dalle caselle di chi prova, non da quelle di chi l'ha creata", async () => {
    const a = await draftWith({ kind: "stubwise", event: "mail_received" }, null);
    const mine = await automations.listSimulationExamples(a.id, "draft");
    const inMatteo = state.mailMessages.filter(
      (m) => m.mailboxPersonIds.includes("p-matteo") && m.from.personId !== "p-matteo",
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => inMatteo.some((m) => m.subject === e.label))).toBe(true);
    // La stessa automazione (creata da Matteo) provata da Roberta: le email di Matteo non compaiono.
    as("p-roberta");
    const hers = await automations.listSimulationExamples(a.id, "draft");
    const matteoOnly = new Set(
      inMatteo.filter((m) => !m.mailboxPersonIds.includes("p-roberta")).map((m) => m.subject),
    );
    expect(matteoOnly.size).toBeGreaterThan(0);
    expect(hers.some((e) => matteoOnly.has(e.label))).toBe(false);
    for (const e of hers) {
      expect(
        state.mailMessages.some(
          (m) => m.subject === e.label && m.mailboxPersonIds.includes("p-roberta"),
        ),
      ).toBe(true);
    }
  });

  it("chi vede ma non gestisce non ha esempi; chi non vede: not_found", async () => {
    as("p-marco");
    await expect(automations.listSimulationExamples(A.clientData, 1)).rejects.toThrow("forbidden");
    as("p-sara");
    await expect(automations.listSimulationExamples(A.newContract, 1)).rejects.toThrow("not_found");
  });
});
