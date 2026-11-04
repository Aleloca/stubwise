import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { readsAs } from "../../data/api-mutations";
import { classOfGroup } from "../../data/claude/classes";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { AutomationFlow, ConversationEvent, ScriptStep } from "../../data/types";
import { toSteps } from "./answers";
import { recognize, respond, type IntentContext } from "./intents";

// L'intento «automazione» (area 10b, Task 5, S1): una frase che dice quando
// e cosa fare diventa una bozza coi soli blocchi del motore, da eseguire
// subito (A) e da provare (`trial`, che risolve `freeTurn`). Il motore resta
// puro: legge come la persona, non scrive niente.
//
// Seme: Laura gestisce le automazioni di ACQ, Sara no (Contributor);
// nessuno di Marketing vede ACQ.

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");
const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";
const SUPPORT = "dep-support";

function as(
  personId: string,
  t = en,
  contextProjectId: string | null = ACQ,
  extra: Partial<IntentContext> = {},
): IntentContext {
  setSessionPersonId(personId);
  return {
    personId,
    contextProjectId,
    read: readsAs(personId),
    t,
    seed: "conv-10b",
    classify: async (actions) => classOfGroup(personId, actions),
    asks: true,
    ...extra,
  };
}

const said = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n");
type Draft<T extends ConversationEvent["type"]> = Omit<
  Extract<ConversationEvent, { type: T }>,
  "id" | "at"
>;
function events<T extends ConversationEvent["type"]>(steps: ScriptStep[], type: T): Draft<T>[] {
  return steps.flatMap((s) =>
    s.step === "event" && s.event.type === type ? [s.event as unknown as Draft<T>] : [],
  );
}
const eventTypes = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "event" ? [s.event.type] : []));
const links = (text: string) => [...text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => m[2]);

const S1 = {
  en: [
    "When an urgent support request arrives, create a task and notify the department",
    "Whenever an urgent support request comes in, create a task and notify the department",
    "Create an automation: when an urgent support request arrives, create a task and notify the department",
  ],
  it: [
    "Quando arriva una richiesta di supporto urgente, crea una task e avvisa il reparto",
    "Ogni volta che arriva una richiesta di supporto urgente, crea una task e avvisa il reparto",
    "Fai un'automazione: quando arriva una richiesta di supporto urgente crea una task e avvisa il reparto",
  ],
};

/** Il flusso dell'azione da eseguire. */
function executedFlow(steps: ScriptStep[]): AutomationFlow {
  const [executed] = events(steps, "executed");
  expect(executed).toBeDefined();
  expect(executed!.actions).toHaveLength(1);
  expect(executed!.actions[0]!.fn).toBe("createAutomation");
  return executed!.actions[0]!.args.flow as AutomationFlow;
}

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

describe("il riconoscimento", () => {
  for (const text of [...S1.en, ...S1.it]) {
    it(`«${text}» è un'automazione`, () => {
      expect(recognize(text, new Set(["ACQ"]))).toBe("automation");
    });
  }

  it("prima dei comandi (P10): «crea un'automazione…» non crea una task", () => {
    expect(
      recognize("Crea un'automazione: quando arriva una richiesta urgente, crea una task"),
    ).toBe("automation");
    expect(recognize("Create an automation that sends an email when a request is created")).toBe(
      "automation",
    );
  });

  it("dopo `refused`: «accendi l'automazione ACQ-A1» resta un gesto delle persone", () => {
    expect(recognize("Accendi l'automazione ACQ-A1")).toBe("refused");
    expect(recognize("Turn on the automation ACQ-A1")).toBe("refused");
  });

  it("una domanda col «quando» senza evento né azione non è un'automazione", () => {
    expect(recognize("When is AUD-4 due?", new Set(["AUD"]))).not.toBe("automation");
    expect(recognize("Quando arriva la richiesta ACQ-R3?", new Set(["ACQ"]))).not.toBe(
      "automation",
    );
    expect(recognize("Crea una task in ACQ: “Report”", new Set(["ACQ"]))).toBe("create");
  });
});

describe("S1 di Laura, contesto ACQ", () => {
  for (const [lng, t] of [
    ["en", en],
    ["it", it_],
  ] as const) {
    for (const text of S1[lng]) {
      it(`${lng}: «${text}» chiede il reparto, Support consigliato e per primo`, async () => {
        const steps = await respond(text, as(LAURA, t));
        const [q, ...more] = events(steps, "question");
        expect(more).toEqual([]);
        expect(q!.text).toBe(t("claude.answers.automation.ask.department"));
        expect(q!.options[0]).toEqual({ label: "Support", recommended: true });
        expect(q!.options.filter((o) => o.recommended)).toHaveLength(1);
        expect(q!.options.map((o) => o.label).sort()).toEqual(
          state.departments.map((d) => d.name).sort(),
        );
        expect(eventTypes(steps)).not.toContain("executed");
        expect(eventTypes(steps)).not.toContain("trial");
      });

      it(`${lng}: «${text}» + «Support» esegue la bozza e chiede la prova subito dopo`, async () => {
        const steps = await respond(`${text} Support`, as(LAURA, t));
        expect(events(steps, "question")).toEqual([]);
        const types = eventTypes(steps);
        expect(types.indexOf("trial")).toBe(types.indexOf("executed") + 1);
        expect(events(steps, "trial")).toEqual([
          { type: "trial", status: "pending", wants: ["passes", "fails"] },
        ]);
        const flow = executedFlow(steps);
        expect(flow.steps.map((s) => s.kind)).toEqual(["createTask", "notify"]);
        expect(flow.steps[0]).toMatchObject({ assignee: { departmentId: SUPPORT }, dueInDays: 1 });
        expect(flow.steps[1]).toMatchObject({ who: { departmentId: SUPPORT } });
        const [executed] = events(steps, "executed");
        expect(executed!.actions[0]!.args).toMatchObject({ projectId: ACQ });
        // Il riassunto del flusso, prima dell'azione.
        const line = said(steps);
        expect(line).toContain(t("claude.answers.automation.start.urgentSupport", { code: "ACQ" }));
        expect(line).toContain(
          t("claude.answers.automation.step.createTask", { department: "Support", count: 1 }),
        );
        expect(line).toContain(
          t("claude.answers.automation.step.notify", { department: "Support" }),
        );
        expect(line).toContain(t("claude.answers.automation.auto"));
      });
    }
  }

  it("il nome della bozza dal modello «evento → azione», nella lingua di chi chiede", async () => {
    const enSteps = await respond(`${S1.en[0]} Support`, as(LAURA, en));
    const itSteps = await respond(`${S1.it[0]} Support`, as(LAURA, it_));
    const name = (steps: ScriptStep[]) => events(steps, "executed")[0]!.actions[0]!.args.name;
    expect(name(enSteps)).toBe("Urgent support request → task for Support");
    expect(name(itSteps)).toBe("Richiesta di supporto urgente → task per Support");
  });

  it("il reparto nominato nella frase: nessuna scheda di scelta", async () => {
    for (const [text, t] of [
      [
        "Quando arriva una richiesta di supporto urgente, crea una task e avvisa il reparto Support",
        it_,
      ],
      [
        "When an urgent support request arrives, create a task and notify the Support department",
        en,
      ],
    ] as const) {
      const steps = await respond(text, as(LAURA, t));
      expect(events(steps, "question")).toEqual([]);
      expect(executedFlow(steps).steps[1]).toMatchObject({ who: { departmentId: SUPPORT } });
    }
  });

  it("«…e manda un'email al cliente»: il riassunto dice che l'email chiede approvazione", async () => {
    const steps = await respond(
      "Quando arriva una richiesta di supporto urgente, crea una task, avvisa il reparto Support e manda un'email al cliente",
      as(LAURA, it_),
    );
    const flow = executedFlow(steps);
    expect(flow.steps.map((s) => s.kind)).toEqual(["createTask", "notify", "sendEmail"]);
    expect(flow.steps[2]).toMatchObject({ approval: { mode: "ask", who: { owner: true } } });
    const line = said(steps);
    expect(line).toContain(it_("claude.answers.automation.autoWithEmail"));
    expect(line).toContain(it_("claude.answers.automation.ownerNote"));
    expect(line).not.toContain(it_("claude.answers.automation.auto") + ".");
  });

  it("«…e pubblicala su Slack»: costruisce il resto, nomina «avvisare» a parole, nessun passo nuovo", async () => {
    const steps = await respond(
      "Quando arriva una richiesta di supporto urgente, crea una task per Support e pubblicala su Slack",
      as(LAURA, it_),
    );
    expect(events(steps, "question")).toEqual([]);
    expect(events(steps, "proposal")).toEqual([]);
    const flow = executedFlow(steps);
    // Solo la task: nessun `notify` aggiunto da Claude, nessun passo inventato.
    expect(flow.steps.map((s) => s.kind)).toEqual(["createTask"]);
    const line = said(steps);
    expect(line).toContain(it_("claude.answers.automation.cant.slack"));
    expect(line).toContain(it_("claude.answers.automation.closest"));
    expect(events(steps, "trial")).toHaveLength(1);
  });

  it("«chiama il cliente» si dice allo stesso modo", async () => {
    const steps = await respond(
      "When an urgent support request arrives, create a task for Support and call the customer",
      as(LAURA, en),
    );
    expect(executedFlow(steps).steps.map((s) => s.kind)).toEqual(["createTask"]);
    expect(said(steps)).toContain(en("claude.answers.automation.cant.call"));
  });

  it("un reparto che non vede ACQ diventa una scheda coi soli reparti che lo vedono", async () => {
    const steps = await respond(
      "Quando arriva una richiesta di supporto urgente, avvisa il reparto Marketing",
      as(LAURA, it_),
    );
    const [q] = events(steps, "question");
    expect(q!.text).toBe(
      it_("claude.answers.automation.ask.departmentCantSee", {
        department: "Marketing",
        code: "ACQ",
      }),
    );
    const labels = q!.options.map((o) => o.label);
    expect(labels).not.toContain("Marketing");
    expect(labels).toContain("Support");
    expect(q!.options.some((o) => o.recommended)).toBe(false);
    expect(eventTypes(steps)).not.toContain("executed");
  });

  it("solo una frase di automazione senza un passo che so fare: la riga, niente da eseguire", async () => {
    const steps = await respond(
      "Crea un'automazione: quando arriva una richiesta urgente, chiama il cliente",
      as(LAURA, it_),
    );
    expect(said(steps)).toContain(it_("claude.answers.automation.noAction"));
    expect(eventTypes(steps)).toEqual([]);
  });
});

describe("Sara, senza permesso", () => {
  for (const [lng, t] of [
    ["en", en],
    ["it", it_],
  ] as const) {
    it(`${lng}: tre righe che descrivono il flusso e il «Who?», nessuna azione`, async () => {
      const before = structuredClone(state.automations);
      const steps = await respond(S1[lng][0]!, as(SARA, t));
      expect(eventTypes(steps)).toEqual([]);
      const text = said(steps);
      const bullets = text.split("\n").filter((l) => l.startsWith("- "));
      expect(bullets).toEqual([
        `- ${t("claude.answers.automation.would.start.urgentSupport", { code: "ACQ" })}`,
        `- ${t("claude.answers.automation.would.createTask", { department: "Support", count: 1 })}`,
        `- ${t("claude.answers.automation.would.notify", { department: "Support", code: "ACQ" })}`,
      ]);
      expect(text).toContain(t("claude.answers.automation.cantCreate", { code: "ACQ" }));
      expect(links(text)).toEqual(["who:manageProjectAutomations/ACQ"]);
      expect(state.automations).toEqual(before);
    });
  }
});

describe("senza contesto di progetto", () => {
  it("prima la scheda dei progetti dove Laura gestisce le automazioni", async () => {
    const steps = await respond(S1.it[0]!, as(LAURA, it_, null));
    const [q] = events(steps, "question");
    expect(q!.text).toBe(it_("claude.answers.automation.ask.project"));
    const projects = await api.listProjects();
    const lnt = projects.find((p) => p.code === "LNT");
    const labels = q!.options.map((o) => o.label);
    expect(labels.some((l) => l.startsWith("ACQ "))).toBe(true);
    // LNT la vede ma non ne gestisce le automazioni.
    if (lnt) expect(labels.some((l) => l.startsWith("LNT "))).toBe(false);
    expect(eventTypes(steps)).not.toContain("executed");
  });

  it("risposto il progetto, la scheda dei reparti", async () => {
    const steps = await respond(`${S1.it[0]} ACQ Portale`, as(LAURA, it_, null));
    const [q] = events(steps, "question");
    expect(q!.text).toBe(it_("claude.answers.automation.ask.department"));
  });

  it("dopo due schede la terza mancanza è una riga, non una scheda", async () => {
    const steps = await respond(
      "Quando arriva una richiesta di supporto urgente, avvisa il reparto Marketing ACQ",
      as(LAURA, it_, null, { asks: false }),
    );
    expect(events(steps, "question")).toEqual([]);
    expect(eventTypes(steps)).toEqual([]);
    expect(said(steps)).toBe(
      it_("claude.answers.automation.stillNeed.departmentCantSee", {
        department: "Marketing",
        code: "ACQ",
      }),
    );
  });
});

describe("nella Chat (P11)", () => {
  it("niente `trial`: la proposta e una riga che rimanda al riquadro", async () => {
    const steps = await respond(
      `${S1.en[0]} Support`,
      as(LAURA, en, ACQ, { classify: undefined, asks: true }),
    );
    expect(eventTypes(steps)).not.toContain("trial");
    expect(eventTypes(steps)).not.toContain("executed");
    expect(events(steps, "proposal")[0]!.actions[0]!.fn).toBe("createAutomation");
    expect(said(steps)).toContain(en("claude.answers.automation.panel"));
  });

  it("`toSteps` non emette una prova senza `classify`, nemmeno se la risposta la chiede", () => {
    const answer = {
      actions: [],
      text: "x",
      execute: [{ fn: "createAutomation" as const, args: {}, summary: "x" }],
      trial: { wants: ["passes" as const] },
    };
    const chat = as(LAURA, en, ACQ, { classify: undefined });
    expect(eventTypes(toSteps(answer, chat, "x"))).not.toContain("trial");
    expect(eventTypes(toSteps(answer, as(LAURA, en), "x"))).toContain("trial");
  });
});
