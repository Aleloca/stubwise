import { describe, expect, it } from "vitest";
import type {
  AutomationFlow,
  AutomationSource,
  DataField,
  PersonTarget,
  Step,
} from "../../data/model";
import { AUTOMATION_SOURCES, AUTOMATIONS } from "../../data/seed/automations";
import { validateFlow, type FlowIssue, type ValidateContext } from "./validate";

const CTX: ValidateContext = {
  sources: AUTOMATION_SOURCES,
  canApprove: () => true,
  projectId: "prj-aud",
};

const email = (id: string, over: Partial<Extract<Step, { kind: "sendEmail" }>> = {}): Step => ({
  id,
  kind: "sendEmail",
  to: "{{cliente.email}}",
  subject: "Dati per {{richiesta.funzione}}",
  body: "Ci servono: {{richiesta.dati}}",
  attachRefs: [],
  approval: { mode: "auto" },
  ...over,
});

const task = (id: string, over: Partial<Extract<Step, { kind: "createTask" }>> = {}): Step => ({
  id,
  kind: "createTask",
  title: "Attivare {{richiesta.funzione}}",
  description: "",
  assignee: null,
  dueInDays: 3,
  project: { mode: "own" },
  milestoneRef: null,
  approval: { mode: "auto" },
  ...over,
});

/** Un flusso valido sul webhook: email, attesa della risposta, condizione. */
function base(steps?: Step[]): AutomationFlow {
  return {
    trigger: { kind: "source", sourceId: "src-webhook", event: "webhook" },
    titleTemplate: "Dati – {{cliente.nome}}",
    steps: steps ?? [
      email("ask"),
      { id: "wait", kind: "wait", for: { replyTo: "ask", maxDays: 5 } },
      {
        id: "cond",
        kind: "condition",
        when: { left: { ref: "risposta.arrivata" }, op: "is", right: { value: true } },
        then: [task("t")],
        else: [],
      },
    ],
  };
}

const codes = (issues: FlowIssue[]) => issues.map((i) => `${i.path} ${i.code}`);

describe("validateFlow", () => {
  it("un flusso ben fatto non ha errori", () => {
    expect(validateFlow(base(), CTX)).toEqual([]);
  });

  it("ogni flusso del seme è valido", () => {
    for (const a of AUTOMATIONS) {
      for (const v of a.versions) {
        expect(
          validateFlow(v.flow, { ...CTX, projectId: a.projectId }),
          `${a.code} v${v.n}`,
        ).toEqual([]);
      }
    }
  });

  it("incomplete: testi vuoti, nessun passo, attesa a zero, confronto a metà, id doppi, progetto suo in una generale", () => {
    expect(codes(validateFlow(base([]), CTX))).toEqual([" incomplete"]);
    expect(codes(validateFlow({ ...base(), titleTemplate: " " }, CTX))).toEqual([
      "trigger incomplete",
    ]);
    expect(codes(validateFlow(base([email("e", { subject: "" })]), CTX))).toEqual(["0 incomplete"]);
    expect(codes(validateFlow(base([{ id: "w", kind: "wait", for: { days: 0 } }]), CTX))).toEqual([
      "0 incomplete",
    ]);
    expect(
      codes(
        validateFlow(
          base([
            {
              id: "c",
              kind: "condition",
              when: { left: { ref: "cliente.nome" }, op: "is" },
              then: [],
              else: [],
            },
          ]),
          CTX,
        ),
      ),
    ).toEqual(["0 incomplete"]);
    expect(codes(validateFlow(base([email("e"), email("e")]), CTX))).toEqual(["1 incomplete"]);
    expect(codes(validateFlow(base([task("t")]), { ...CTX, projectId: null }))).toEqual([
      "0 incomplete",
    ]);
    const claudeEmpty: Step = {
      id: "c",
      kind: "claude",
      instruction: "Leggi",
      inputs: [],
      outcomes: [],
      fields: [],
      branches: {},
    };
    expect(codes(validateFlow(base([claudeEmpty]), CTX))).toEqual(["0 incomplete"]);
  });

  it("unknown_ref: dato inesistente, riferimento a un passo che non precede, ramo di un'uscita non dichiarata", () => {
    expect(codes(validateFlow(base([email("e", { body: "{{cliente.telefono}}" })]), CTX))).toEqual([
      "0 unknown_ref",
    ]);
    // replyTo verso un passo successivo, o che non è un'email.
    expect(
      codes(
        validateFlow(
          base([{ id: "w", kind: "wait", for: { replyTo: "ask", maxDays: 5 } }, email("ask")]),
          CTX,
        ),
      ),
    ).toEqual(["0 unknown_ref"]);
    // Il dato del wait non c'è prima del wait.
    expect(
      codes(
        validateFlow(
          base([
            email("e", { body: "{{risposta.testo}}" }),
            { id: "w", kind: "wait", for: { replyTo: "e", maxDays: 2 } },
          ]),
          CTX,
        ),
      ),
    ).toEqual(["0 unknown_ref"]);
    expect(codes(validateFlow(base([task("t", { milestoneRef: "ms" })]), CTX))).toEqual([
      "0 unknown_ref",
    ]);
    expect(
      codes(
        validateFlow(
          base([
            {
              id: "c",
              kind: "claude",
              instruction: "Leggi",
              inputs: ["richiesta.dati"],
              outcomes: ["sì"],
              fields: [],
              branches: { no: [] },
            },
          ]),
          CTX,
        ),
      ),
    ).toEqual(["0 unknown_ref"]);
    expect(
      codes(
        validateFlow(
          { ...base(), trigger: { kind: "source", sourceId: "src-nessuna", event: "webhook" } },
          CTX,
        ),
      ),
    ).toContain("trigger unknown_ref");
  });

  it("type_mismatch: forEach su un dato che non è un elenco, maggiore di su un testo, booleano confrontato con un testo", () => {
    expect(
      codes(
        validateFlow(
          base([{ id: "f", kind: "forEach", list: "cliente.nome", as: "x", steps: [] }]),
          CTX,
        ),
      ),
    ).toEqual(["0 type_mismatch"]);
    expect(
      codes(
        validateFlow(
          base([
            {
              id: "c",
              kind: "condition",
              when: { left: { ref: "cliente.nome" }, op: "gt", right: { value: 3 } },
              then: [],
              else: [],
            },
          ]),
          CTX,
        ),
      ),
    ).toEqual(["0 type_mismatch"]);
    const flow = base();
    const cond = flow.steps[2] as Extract<Step, { kind: "condition" }>;
    cond.when = { left: { ref: "risposta.arrivata" }, op: "is", right: { value: "sì" } };
    expect(codes(validateFlow(flow, CTX))).toEqual(["2 type_mismatch"]);
  });

  it("approver_cant_see: chi approva non vede il progetto del passo", () => {
    const steps = [task("t", { approval: { mode: "ask", who: { personId: "p-sara" } } })];
    const seen: [unknown, string | null][] = [];
    const issues = validateFlow(base(steps), {
      ...CTX,
      canApprove: (who, projectId) => {
        seen.push([who, projectId]);
        return false;
      },
    });
    expect(codes(issues)).toEqual(["0 approver_cant_see"]);
    expect(seen).toEqual([[{ personId: "p-sara" }, "prj-aud"]]);
  });

  it("source_disconnected: inizio da una sorgente scaduta o scollegata", () => {
    const flow = {
      ...base(),
      trigger: { kind: "source", sourceId: "src-hubspot", event: "deal_won" },
    } as const;
    expect(codes(validateFlow(base(), CTX))).toEqual([]);
    const hubspotFlow: AutomationFlow = {
      ...flow,
      titleTemplate: "x",
      steps: [task("t", { title: "x" })],
    };
    expect(codes(validateFlow(hubspotFlow, CTX))).toEqual(["trigger source_disconnected"]);
    const off: AutomationSource[] = AUTOMATION_SOURCES.map((s) =>
      s.id === "src-webhook" ? { ...s, status: "disconnected" } : s,
    );
    expect(codes(validateFlow(base(), { ...CTX, sources: off }))).toEqual([
      "trigger source_disconnected",
    ]);
  });

  it("limit: repeatUntil senza un massimo fra 1 e 10", () => {
    for (const max of [0, 11, 2.5]) {
      const steps: Step[] = [
        email("ask"),
        { id: "w", kind: "wait", for: { replyTo: "ask", maxDays: 5 } },
        {
          id: "r",
          kind: "repeatUntil",
          until: { left: { ref: "risposta.testo" }, op: "not_empty" },
          max,
          steps: [email("again")],
          onLimit: [],
        },
      ];
      expect(codes(validateFlow(base(steps), CTX)), String(max)).toEqual(["2 limit"]);
    }
  });

  it("i percorsi dentro i cicli usano il giro 0 e ogni errore ha un messaggio", () => {
    const steps: Step[] = [
      {
        id: "f",
        kind: "forEach",
        list: "elenco",
        as: "x",
        steps: [email("e", { body: "{{x.nome}}" })],
      },
    ];
    const issues = validateFlow(base(steps), CTX);
    // L'elenco non esiste: errore sul forEach e sul riferimento dentro.
    expect(codes(issues)).toEqual(["0 unknown_ref", "0/forEach[0]/0 unknown_ref"]);
    for (const i of issues) expect(i.message.length).toBeGreaterThan(0);
  });
});

describe("validateFlow, revisione giro 1", () => {
  const claude = (id: string, fields: Extract<Step, { kind: "claude" }>["fields"]): Step => ({
    id,
    kind: "claude",
    instruction: "Leggi",
    inputs: [],
    outcomes: [],
    fields,
    branches: {},
  });
  const notify = (who: PersonTarget): Step => ({
    id: "n",
    kind: "notify",
    who,
    text: "Ciao",
    approval: { mode: "auto" },
  });

  it("notify: una persona, il dato Persona (chiave di un dato persona) o un ruolo; mai un testo libero", () => {
    expect(codes(validateFlow(base([notify({ personRef: "p-laura" })]), CTX))).toEqual([
      "0 unknown_ref",
    ]);
    expect(codes(validateFlow(base([notify({ personRef: "cliente.nome" })]), CTX))).toEqual([
      "0 type_mismatch",
    ]);
    expect(codes(validateFlow(base([notify({ personId: "p-laura" })]), CTX))).toEqual([]);
    expect(codes(validateFlow(base([notify({ projectRole: "project_lead" })]), CTX))).toEqual([]);
    for (const empty of [{ personId: "" }, { personRef: "" }, { projectRole: "" }])
      expect(codes(validateFlow(base([notify(empty)]), CTX))).toEqual(["0 incomplete"]);
    const withPerson: AutomationFlow = {
      ...base([notify({ personRef: "task.incaricato" })]),
      trigger: { kind: "stubwise", event: "task_created" },
      titleTemplate: "x",
    };
    expect(codes(validateFlow(withPerson, CTX))).toEqual([]);
  });

  it("createTask: l'incaricato dal dato Persona dev'essere un dato persona disponibile", () => {
    const task = (assignee: { personRef: string }): Step => ({
      id: "t",
      kind: "createTask",
      title: "x",
      description: "",
      assignee,
      dueInDays: null,
      project: { mode: "fixed", projectId: "prj-aud" },
      milestoneRef: null,
      approval: { mode: "auto" },
    });
    const flow = (ref: string): AutomationFlow => ({
      ...base([task({ personRef: ref })]),
      trigger: { kind: "stubwise", event: "task_created" },
      titleTemplate: "x",
    });
    expect(codes(validateFlow(flow("task.incaricato"), CTX))).toEqual([]);
    expect(codes(validateFlow(flow("task.titolo"), CTX))).toEqual(["0 type_mismatch"]);
    expect(codes(validateFlow(flow("nessuno"), CTX))).toEqual(["0 unknown_ref"]);
  });

  it("revisione Task 6: uscite di sole cifre, campi senza nome, più di 5 livelli", () => {
    const c = (outcomes: string[], fields: DataField[] = []): Step => ({
      id: "c",
      kind: "claude",
      instruction: "x",
      inputs: [],
      outcomes,
      fields,
      branches: {},
    });
    expect(codes(validateFlow(base([c(["12"])]), CTX))).toEqual(["0 incomplete"]);
    expect(codes(validateFlow(base([c(["ok: sì", "a:b"])]), CTX))).toEqual([]);
    expect(
      codes(validateFlow(base([c([], [{ key: "k", label: " ", type: "text" }])]), CTX)),
    ).toEqual(["0 incomplete"]);
    // 5 livelli sì; un blocco al quinto che apre rami no.
    const nest = (levels: number, leaf: Step): Step => {
      let s = leaf;
      for (let i = levels; i >= 1; i--)
        s = {
          id: `n${i}`,
          kind: "condition",
          when: { left: { value: 1 }, op: "is", right: { value: 1 } },
          then: [s],
          else: [],
        };
      return s;
    };
    const notifyLeaf: Step = {
      id: "leaf",
      kind: "notify",
      who: { personId: "p-laura" },
      text: "x",
      approval: { mode: "auto" },
    };
    expect(codes(validateFlow(base([nest(5, notifyLeaf)]), CTX))).toEqual([]);
    // Claude al quinto livello, anche senza uscite: come `fits` nel costruttore.
    expect(
      codes(validateFlow(base([nest(5, c([], [{ key: "k", label: "K", type: "text" }]))]), CTX)),
    ).toEqual(["0/then/0/then/0/then/0/then/0/then/0 limit"]);
    // Un avviso a un ruolo in una generale: non c'è un progetto dove cercarlo.
    const role: Step = { ...notifyLeaf, who: { projectRole: "project_lead" } } as Step;
    expect(codes(validateFlow(base([role]), { ...CTX, projectId: null }))).toEqual([
      "0 incomplete",
    ]);
    expect(codes(validateFlow(base([role]), { ...CTX, projectId: "prj-aud" }))).toEqual([]);
    expect(codes(validateFlow(base([c(["__proto__"])]), CTX))).toEqual(["0 incomplete"]);
    expect(codes(validateFlow(base([nest(6, notifyLeaf)]), CTX))).toEqual([
      "0/then/0/then/0/then/0/then/0/then/0 limit",
      "0/then/0/then/0/then/0/then/0/then/0/then/0 limit",
    ]);
  });

  it("Claude non restituisce file, nemmeno dentro un elenco", () => {
    expect(
      codes(validateFlow(base([claude("c", [{ key: "a.doc", label: "Doc", type: "file" }])]), CTX)),
    ).toEqual(["0 type_mismatch"]);
    const nested = claude("c", [
      {
        key: "a.righe",
        label: "Righe",
        type: "list",
        of: [{ key: "doc", label: "Doc", type: "file" }],
      },
    ]);
    expect(codes(validateFlow(base([nested]), CTX))).toEqual(["0 type_mismatch"]);
  });

  it("chiavi di Claude riservate o che si confondono con l'elemento di un forEach", () => {
    for (const key of ["risposta.testo", "risposta", "avvio.data"]) {
      expect(
        codes(validateFlow(base([claude("c", [{ key, label: "x", type: "text" }])]), CTX)),
        key,
      ).toEqual(["0 incomplete"]);
    }
    const steps: Step[] = [
      claude("c", [
        { key: "e", label: "x", type: "text" },
        { key: "e.nome", label: "x", type: "text" },
        { key: "elenco.x", label: "x", type: "list" },
      ]),
      { id: "f", kind: "forEach", list: "elenco.x", as: "e", steps: [] },
    ];
    expect(codes(validateFlow(base(steps), CTX))).toEqual(["0 incomplete", "0 incomplete"]);
  });

  it("l'elenco di un forEach non si ridichiara dentro il suo ciclo", () => {
    const steps: Step[] = [
      claude("c", [{ key: "analisi.task", label: "x", type: "list" }]),
      {
        id: "f",
        kind: "forEach",
        list: "analisi.task",
        as: "t",
        steps: [
          {
            id: "cond",
            kind: "condition",
            when: { left: { ref: "t" }, op: "not_empty" },
            then: [claude("c2", [{ key: "analisi.task", label: "x", type: "list" }])],
            else: [],
          },
        ],
      },
    ];
    expect(codes(validateFlow(base(steps), CTX))).toEqual(["1/forEach[0]/0/then/0 incomplete"]);
  });
});
