import { describe, expect, it } from "vitest";

import { eventIsUntrusted, forceApprovalForUntrusted, taintedKeys, untrustedTargets } from "./taint.js";
import type { Approval, AutomationFlow, AutomationSource, Step } from "./types.js";
import { validateFlow } from "./validate.js";

// Area 7, F3 (F3-1 = a, M): un campo di Claude che nasce da un input non
// fidato (un'email arrivata, la risposta di un cliente, l'evento di una
// sorgente esterna) è «tinto», e la tinta passa ai campi di Claude che lo
// leggono. Un passo che lo usa per scegliere A CHI o DOVE va l'effetto
// chiede SEMPRE l'approvazione: il costruttore la forza, `validateFlow` lo
// ricontrolla (`untrusted_target`), così prototipo, app e server dicono lo
// stesso.

const claude = (id: string, inputs: string[], fields: string[]): Step =>
  ({
    id,
    kind: "claude",
    instruction: "Leggi e rispondi",
    inputs,
    outcomes: [],
    fields: fields.map((key) => ({
      key,
      label: key,
      type: key.endsWith("persona") ? "person" : "text",
    })),
    branches: {},
  }) as unknown as Step;
const email = (id: string, to: string, approval: Approval = { mode: "auto" }): Step =>
  ({ id, kind: "sendEmail", to, subject: "x", body: "y", attachRefs: [], approval }) as Step;
const notify = (id: string, personRef: string): Step =>
  ({ id, kind: "notify", who: { personRef }, text: "x", approval: { mode: "auto" } }) as Step;
const task = (id: string, personRef: string): Step =>
  ({
    id,
    kind: "createTask",
    title: "x",
    description: "",
    assignee: { personRef },
    dueInDays: null,
    project: { mode: "own" },
    milestoneRef: null,
    approval: { mode: "auto" },
  }) as Step;
const flow = (trigger: AutomationFlow["trigger"], steps: Step[]): AutomationFlow =>
  ({ trigger, steps, titleTemplate: "x" }) as AutomationFlow;
const mail: AutomationFlow["trigger"] = { kind: "stubwise", event: "mail_received" };
const taskCreated: AutomationFlow["trigger"] = { kind: "stubwise", event: "task_created" };

describe("i campi tinti", () => {
  it("i campi di un'email arrivata sono tinti, e la tinta passa ai campi di Claude che li leggono", () => {
    const f = flow(mail, [
      claude("c1", ["email.testo"], ["claude.destinatario"]),
      claude("c2", ["claude.destinatario"], ["claude.altro"]),
    ]);
    const keys = taintedKeys(f, []);
    expect(keys.has("email.testo")).toBe(true);
    expect(keys.has("claude.destinatario")).toBe(true);
    expect(keys.has("claude.altro")).toBe(true);
  });

  it("un passo di Claude che legge solo campi di Stubwise non è tinto", () => {
    const f = flow(taskCreated, [claude("c1", ["task.titolo"], ["claude.destinatario"])]);
    expect(taintedKeys(f, []).has("claude.destinatario")).toBe(false);
  });

  it("la risposta di un cliente e l'evento di una sorgente esterna sono tinti", () => {
    const wait = { id: "w", kind: "wait", for: { replyTo: "e0", maxDays: 3 } } as Step;
    const f = flow(taskCreated, [
      email("e0", "a@b.it"),
      wait,
      claude("c1", ["risposta.testo"], ["claude.persona"]),
    ]);
    expect(taintedKeys(f, []).has("claude.persona")).toBe(true);
    const source = {
      id: "s1",
      fields: [{ key: "trattativa.nome", label: "Nome", type: "text" }],
    } as unknown as AutomationSource;
    const fromSource = flow({ kind: "source", sourceId: "s1", event: "webhook" }, [
      claude("c1", ["trattativa.nome"], ["claude.x"]),
    ]);
    expect(taintedKeys(fromSource, [source]).has("claude.x")).toBe(true);
  });
});

describe("le destinazioni tinte", () => {
  it("il destinatario di un'email, la persona di un avviso, l'incaricato di una task", () => {
    const f = flow(mail, [
      claude("c1", ["email.testo"], ["claude.indirizzo", "claude.persona"]),
      email("e1", "{{claude.indirizzo}}"),
      notify("n1", "claude.persona"),
      task("t1", "claude.persona"),
      // Il testo può citare un campo tinto: non sceglie a chi va.
      email("e2", "ufficio@audin.test"),
    ]);
    expect(untrustedTargets(f, []).map((t) => t.stepId)).toEqual(["e1", "n1", "t1"]);
  });

  it("un campo grezzo dell'evento come destinazione non è F3-1: rispondere al mittente resta com'era (F2)", () => {
    const f = flow(mail, [email("e1", "{{email.mittente}}")]);
    expect(untrustedTargets(f, [])).toEqual([]);
  });

  it("l'elemento di un «per ogni» su un elenco di Claude tinto è tinto anche lui", () => {
    const loop = {
      id: "fe",
      kind: "forEach",
      list: "claude.persone",
      as: "p",
      steps: [notify("n1", "p.persona")],
    } as unknown as Step;
    const f = flow(mail, [claude("c1", ["email.testo"], ["claude.persone"]), loop]);
    expect(untrustedTargets(f, []).map((t) => t.stepId)).toEqual(["n1"]);
  });

  it("validateFlow: senza approvazione è `untrusted_target`; con l'approvazione no", () => {
    const issues = (steps: Step[]) =>
      validateFlow(flow(mail, steps), { sources: [], canApprove: () => true })
        .filter((i) => i.code === "untrusted_target")
        .map((i) => i.path);
    const c = claude("c1", ["email.testo"], ["claude.indirizzo"]);
    expect(issues([c, email("e1", "{{claude.indirizzo}}")])).toEqual(["1"]);
    expect(
      issues([c, email("e1", "{{claude.indirizzo}}", { mode: "ask", who: { owner: true } })]),
    ).toEqual([]);
  });

  it("forzare: ogni passo con una destinazione tinta passa a «chiede al proprietario», gli altri restano", () => {
    const f = flow(mail, [
      claude("c1", ["email.testo"], ["claude.indirizzo"]),
      email("e1", "{{claude.indirizzo}}"),
      email("e2", "ufficio@audin.test"),
      email("e3", "{{claude.indirizzo}}", { mode: "ask", who: { projectRole: "Project Lead" } }),
    ]);
    const forced = forceApprovalForUntrusted(f, []);
    expect(forced.steps.map((s) => ("approval" in s ? s.approval : undefined))).toEqual([
      undefined,
      { mode: "ask", who: { owner: true } },
      { mode: "auto" },
      { mode: "ask", who: { projectRole: "Project Lead" } },
    ]);
    // Niente da forzare: lo stesso oggetto (il costruttore non salva per niente).
    const clean = flow(taskCreated, [email("e1", "a@b.it")]);
    expect(forceApprovalForUntrusted(clean, [])).toBe(clean);
  });
});

describe("review F3 (72): le richieste dal supporto e i «per ogni» su un elenco grezzo", () => {
  const claudeOn = (input: string): Step => ({ id: "c", kind: "claude", instruction: "x", inputs: [input], outcomes: [], fields: [{ key: "chi", label: "Chi", type: "email" }], branches: {} });
  it("I4 *(O, 46)*: titolo e descrizione di una richiesta sono tinti (possono venire dal widget di supporto), salvo un filtro che escluda le richieste dal supporto", () => {
    for (const event of ["request_created", "request_converted"] as const) {
      const flow: AutomationFlow = { trigger: { kind: "stubwise", event }, steps: [claudeOn("richiesta.descrizione")], titleTemplate: "t" };
      expect(taintedKeys(flow, []).has("richiesta.descrizione"), event).toBe(true);
      expect(taintedKeys(flow, []).has("chi"), event).toBe(true);
      const internal: AutomationFlow = { ...flow, trigger: { kind: "stubwise", event, filter: { left: { ref: "richiesta.dal_supporto" }, op: "is", right: { value: false } } } };
      expect(taintedKeys(internal, []).has("richiesta.descrizione"), event).toBe(false);
    }
    const task: AutomationFlow = { trigger: { kind: "stubwise", event: "task_created" }, steps: [claudeOn("task.titolo")], titleTemplate: "t" };
    expect(taintedKeys(task, []).has("chi")).toBe(false);
  });

  it("M6: l'elemento di un «per ogni» su un elenco GREZZO non fidato è tinto (per chi legge), ma non è deciso da Claude (non forza l'approvazione)", () => {
    const flow: AutomationFlow = {
      trigger: { kind: "stubwise", event: "mail_received" },
      steps: [{ id: "f", kind: "forEach", list: "email.testo", as: "riga", steps: [{ id: "m", kind: "sendEmail", to: "{{riga}}", subject: "s", body: "b", attachRefs: [], approval: { mode: "auto" } }] }],
      titleTemplate: "t",
    };
    expect(taintedKeys(flow, []).has("riga")).toBe(true);
    expect(untrustedTargets(flow, [])).toEqual([]);
  });
});


describe("review F4: la tinta lungo «avvia un'altra» (l'evento della figlia non fidato per intero)", () => {
  // La figlia parte a mano (o da Stubwise) ma riceve l'evento della madre, che veniva da fuori.
  const child = flow(taskCreated, [claude("c", ["task.titolo"], ["chi"]), email("e", "{{chi}}")]);

  it("senza il segno, i campi dell'inizio sono fidati: niente da forzare", () => {
    expect(untrustedTargets(child, [])).toEqual([]);
  });

  it("con eventUntrusted, ogni campo dell'inizio è tinto: ciò che Claude ne ricava, usato come destinazione, chiede l'approvazione", () => {
    expect(taintedKeys(child, [], { eventUntrusted: true }).has("task.titolo")).toBe(true);
    expect(untrustedTargets(child, [], { eventUntrusted: true })).toEqual([{ stepId: "e", path: "1", approved: false }]);
    const forced = forceApprovalForUntrusted(child, [], { eventUntrusted: true });
    expect((forced.steps[1] as { approval: Approval }).approval).toEqual({ mode: "ask", who: { owner: true } });
  });

  it("eventIsUntrusted: un inizio da sorgente, da email o da richiesta (salvo il filtro che esclude il supporto) porta dati di fuori; uno da task no", () => {
    expect(eventIsUntrusted(flow({ kind: "source", sourceId: "s", event: "webhook" }, []))).toBe(true);
    expect(eventIsUntrusted(flow(mail, []))).toBe(true);
    expect(eventIsUntrusted(flow({ kind: "stubwise", event: "request_created" }, []))).toBe(true);
    const onlyInternal = { kind: "stubwise", event: "request_created", filter: { left: { ref: "richiesta.dal_supporto" }, op: "is", right: { value: false } } } as AutomationFlow["trigger"];
    expect(eventIsUntrusted(flow(onlyInternal, []))).toBe(false);
    expect(eventIsUntrusted(flow(taskCreated, []))).toBe(false);
    expect(eventIsUntrusted(flow({ kind: "manual" }, []))).toBe(false);
  });
});
