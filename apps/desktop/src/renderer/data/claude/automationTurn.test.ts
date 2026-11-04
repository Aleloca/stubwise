import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptStep } from "../types";

// La prova nel flusso della libera (area 10b, Task 5, S1): l'intento crea la
// bozza (classe A, spenta, di nessuno) e `freeTurn` la prova subito dopo
// l'`executed` che l'ha creata (`prepareTrials`): due esempi, nessun
// effetto, poi la frase dell'esito e la riga «It's off…». Una creazione che
// non parte o diventa una scheda lascia la prova `skipped`, senza frase.

// Il motore si può sostituire con passi scritti a mano (la creazione che
// fallisce o sale a scheda non nasce da una frase).
const gate = vi.hoisted(() => ({ steps: null as ScriptStep[] | null }));
vi.mock("../../domain/claude/intents", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../domain/claude/intents")>();
  return {
    ...original,
    respond: vi.fn((...args: Parameters<typeof original.respond>) =>
      gate.steps ? Promise.resolve(gate.steps) : original.respond(...args),
    ),
  };
});

import i18n from "../../i18n";
import {
  answerQuestion,
  automations,
  createConversation,
  resetApi,
  sendMessage,
  setLatency,
  whenIdle,
} from "../api";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { now, state, visibleProjectIds } from "../store";
import type { ContextRef, ConversationEvent } from "../types";

const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";
const SUPPORT = "dep-support";
const SUPPORT_PAGE: ContextRef = { kind: "page", route: "support", projectId: ACQ };

const as = (personId: string) => setSessionPersonId(personId);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(id: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await whenIdle(id);
    await tick();
  }
}

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const log = (id: string): ConversationEvent[] => state.conversationEvents.get(id) ?? [];
const ofType = <T extends ConversationEvent["type"]>(id: string, type: T): Ev<T>[] =>
  log(id).filter((e): e is Ev<T> => e.type === type);
const texts = (id: string) => ofType(id, "assistant").map((e) => e.text);
const nameOf = (id: string) => PEOPLE.find((p) => p.id === id)!.name;

/** Chi riceverebbe l'avviso a Support in ACQ, calcolato a parte. */
const supportSeeingAcq = () =>
  state.access.departments
    .find((d) => d.departmentId === SUPPORT)!
    .memberIds.filter((m) => m !== "p-claude" && visibleProjectIds(m).has(ACQ));

/** Ciò che né la creazione di una bozza né la prova devono toccare. */
const effects = () =>
  structuredClone({
    tasks: state.tasks,
    notifications: state.notifications,
    automationRuns: state.automationRuns,
    mailMessages: state.mailMessages,
    changelog: state.changelog,
    decisionLog: state.decisionLog,
  });

/** Una libera di `personId` dalla pagina Support di ACQ (o senza contesto) e il messaggio. */
async function send(text: string, context: ContextRef | null = SUPPORT_PAGE) {
  const c = await createConversation();
  await sendMessage(c.id, { text }, { context });
  await settle(c.id);
  return c.id;
}

/** Risponde all'ultima scheda di scelta con l'opzione che comincia con `label`. */
async function answer(id: string, label: string) {
  const q = ofType(id, "question").at(-1)!;
  const optionIndex = q.options.findIndex((o) => o.label.startsWith(label));
  expect(optionIndex).toBeGreaterThanOrEqual(0);
  await answerQuestion(id, q.questionId, { optionIndex, text: null });
  await settle(id);
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  gate.steps = null;
  as(LAURA);
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

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

describe("S1: Laura dalla pagina Support di ACQ", () => {
  for (const lng of ["en", "it"] as const) {
    for (const text of S1[lng]) {
      it(`${lng}: «${text}»: scheda, Support, bozza spenta, prova su due esempi senza effetti`, async () => {
        await i18n.changeLanguage(lng);
        const t = i18n.getFixedT(lng);
        const before = effects();
        const automationsBefore = state.automations.length;
        const id = await send(text);

        // La scheda del reparto, Support consigliato; niente ancora creato.
        const [q] = ofType(id, "question");
        expect(q!.options[0]).toEqual({ label: "Support", recommended: true });
        expect(state.automations).toHaveLength(automationsBefore);
        expect(ofType(id, "trial")).toEqual([]);

        await answer(id, "Support");

        // La bozza: `ACQ-A<n>`, spenta e di nessuno, creata da Claude.
        const [executed] = ofType(id, "executed");
        expect(executed!.status).toBe("done");
        const code = executed!.objectCodes![0]!;
        expect(code).toMatch(/^ACQ-A\d+$/);
        const a = state.automations.find((x) => x.code === code)!;
        expect(a).toMatchObject({ status: "draft", ownerId: null, createdVia: "claude" });

        // La prova: due esiti, il primo passa, il secondo non partirebbe.
        const [trial, ...more] = ofType(id, "trial");
        expect(more).toEqual([]);
        expect(trial).toMatchObject({
          status: "done",
          wants: ["passes", "fails"],
          automationId: a.id,
          code,
        });
        const [passes, fails] = trial!.results!;
        expect(trial!.results).toHaveLength(2);
        expect(passes).toMatchObject({
          status: "done",
          tasks: 1,
          notifications: supportSeeingAcq().length,
          emails: 0,
          written: false,
        });
        expect(fails).toMatchObject({ status: "filtered_out", tasks: 0, notifications: 0 });
        expect(trial!.openSimId).toBe(passes!.simId);
        // La prova aperta nel costruttore è la versione creata (la bozza), e la prova
        // finita bene segna proprio la sua revisione (nota T2 → T5).
        const draft = a.versions.at(-1)!;
        expect(draft.publishedAt).toBeNull();
        expect(await automations.getSimulation(trial!.openSimId!)).toMatchObject({
          version: draft.n,
          draft: true,
        });
        expect(draft.testedRev).toBe(draft.rev ?? null);

        // Poi la frase dell'esito e la riga finale, in quest'ordine, dopo la prova.
        const list = new Intl.ListFormat(lng, { type: "conjunction" }).format([
          t("claude.answers.automation.outcome.task", { department: "Support" }),
          t("claude.answers.automation.outcome.notifications", {
            count: supportSeeingAcq().length,
          }),
        ]);
        const sentence = t("claude.answers.automation.outcome.sentence", { parts: list, wait: "" });
        const outcome = sentence.charAt(0).toUpperCase() + sentence.slice(1);
        const off = t("claude.answers.automation.off");
        const all = log(id);
        const at = (text: string) =>
          all.findIndex((e) => e.type === "assistant" && e.text === text);
        expect(at(outcome)).toBeGreaterThan(all.indexOf(trial!));
        expect(at(off)).toBe(at(outcome) + 1);

        // Nessuna task, notifica, esecuzione, email o voce nuova.
        expect(effects()).toEqual(before);
      });
    }
  }

  it("il reparto nominato nella frase: nessuna scheda, la bozza e la prova subito", async () => {
    const id = await send(
      "Quando arriva una richiesta di supporto urgente, crea una task e avvisa il reparto Support",
    );
    expect(ofType(id, "question")).toEqual([]);
    expect(ofType(id, "executed")[0]!.status).toBe("done");
    expect(ofType(id, "trial")[0]!.status).toBe("done");
  });

  it("«…e manda un'email al cliente»: la bozza senza email, l'email detta a parole (ruling T5 I2)", async () => {
    await i18n.changeLanguage("it");
    const t = i18n.getFixedT("it");
    const before = effects();
    const id = await send(
      "Quando arriva una richiesta di supporto urgente, crea una task, avvisa il reparto Support e manda un'email al cliente",
    );
    expect(ofType(id, "question")).toEqual([]);
    const code = ofType(id, "executed")[0]!.objectCodes![0]!;
    const a = state.automations.find((x) => x.code === code)!;
    // Nessun passo email: andrebbe a un collega, non al cliente.
    expect(a.versions.at(-1)!.flow.steps.map((s) => s.kind)).toEqual(["createTask", "notify"]);
    const all = texts(id).join("\n");
    expect(all).toContain(t("claude.answers.automation.cant.email"));
    expect(all).not.toContain(
      t("claude.answers.automation.outcome.waitFor", { name: nameOf(LAURA) }),
    );
    const [trial] = ofType(id, "trial");
    expect(trial!.results![0]).toMatchObject({ status: "done", emails: 0 });
    expect(effects()).toEqual(before);
  });

  it("Marketing → la scheda «Nessuno di Marketing vede ACQ» → Support: la bozza nasce (I1)", async () => {
    await i18n.changeLanguage("it");
    const t = i18n.getFixedT("it");
    const id = await send(
      "Quando arriva una richiesta di supporto urgente, crea una task e avvisa il reparto Marketing",
    );
    expect(ofType(id, "question").at(-1)!.text).toBe(
      t("claude.answers.automation.ask.departmentCantSee", {
        department: "Marketing",
        code: "ACQ",
      }),
    );
    await answer(id, "Support");
    expect(ofType(id, "question")).toHaveLength(1);
    const [executed] = ofType(id, "executed");
    expect(executed!.status).toBe("done");
    const a = state.automations.find((x) => x.code === executed!.objectCodes![0])!;
    expect(a.versions.at(-1)!.flow.steps).toEqual([
      expect.objectContaining({ kind: "createTask", assignee: { departmentId: SUPPORT } }),
      expect.objectContaining({ kind: "notify", who: { departmentId: SUPPORT } }),
    ]);
    expect(ofType(id, "trial")[0]!.status).toBe("done");
  });

  it("«…e pubblicala su Slack»: la bozza senza Slack, la riga che nomina l'avviso, nessuna scheda", async () => {
    await i18n.changeLanguage("it");
    const t = i18n.getFixedT("it");
    const id = await send(
      "Quando arriva una richiesta di supporto urgente, crea una task per Support e pubblicala su Slack",
    );
    expect(ofType(id, "question")).toEqual([]);
    expect(ofType(id, "proposal")).toEqual([]);
    const code = ofType(id, "executed")[0]!.objectCodes![0]!;
    const a = state.automations.find((x) => x.code === code)!;
    expect(a.versions.at(-1)!.flow.steps.map((s) => s.kind)).toEqual(["createTask"]);
    expect(texts(id).join("\n")).toContain(t("claude.answers.automation.closest"));
    expect(ofType(id, "trial")[0]!.status).toBe("done");
  });

  it("la coda di ACQ in pausa: la bozza nasce e la prova gira (non sono lavoro in coda)", async () => {
    state.instance.queuePauses.push({ projectId: ACQ, byId: "p-roberta", at: now() });
    const id = await send(
      "When an urgent support request arrives, create a task and notify the Support department",
    );
    expect(ofType(id, "executed")[0]!.status).toBe("done");
    expect(ofType(id, "trial")[0]).toMatchObject({ status: "done" });
    expect(ofType(id, "trial")[0]!.results).toHaveLength(2);
  });
});

describe("Sara, senza permesso", () => {
  it("nessuna automazione, nessuna prova: tre righe e il «Who?»", async () => {
    as(SARA);
    const before = structuredClone(state.automations);
    const id = await send(S1.en[0]!);
    expect(state.automations).toEqual(before);
    expect(ofType(id, "executed")).toEqual([]);
    expect(ofType(id, "trial")).toEqual([]);
    const text = texts(id).join("\n");
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
    expect(text).toContain("(who:manageProjectAutomations/ACQ)");
  });
});

describe("senza contesto di progetto", () => {
  it("prima i progetti, poi i reparti; la terza mancanza è una riga e non nasce niente", async () => {
    await i18n.changeLanguage("it");
    const t = i18n.getFixedT("it");
    const automationsBefore = state.automations.length;
    const id = await send(S1.it[0]!, null);
    expect(ofType(id, "question").at(-1)!.text).toBe(t("claude.answers.automation.ask.project"));
    await answer(id, "ACQ ");
    expect(ofType(id, "question").at(-1)!.text).toBe(t("claude.answers.automation.ask.department"));
    await answer(id, "Marketing");
    expect(ofType(id, "question")).toHaveLength(2);
    expect(texts(id).at(-1)).toBe(
      t("claude.answers.automation.stillNeed.departmentCantSee", {
        department: "Marketing",
        code: "ACQ",
      }),
    );
    expect(state.automations).toHaveLength(automationsBefore);
    expect(ofType(id, "trial")).toEqual([]);
  });
});

describe("la prova senza una creazione riuscita: `skipped`, senza frase", () => {
  const trialStep: ScriptStep = {
    step: "event",
    event: { type: "trial", status: "pending", wants: ["passes", "fails"] },
  };

  it("la creazione non parte (flusso senza passi): `skipped`, niente frase né riga finale", async () => {
    gate.steps = [
      { step: "deliver" },
      { step: "state", state: "working" },
      { step: "say", text: "Starts when…" },
      {
        step: "event",
        event: {
          type: "executed",
          groupId: "",
          status: "pending",
          actions: [
            {
              fn: "createAutomation",
              args: {
                projectId: ACQ,
                name: "Vuota",
                flow: { trigger: { kind: "manual" }, steps: [], titleTemplate: "x" },
              },
              summary: "createAutomation",
            },
          ],
        },
      },
      trialStep,
      { step: "state", state: "idle" },
    ];
    const before = state.automations.length;
    const id = await send("anything");
    expect(ofType(id, "executed")[0]!.status).toBe("failed");
    expect(ofType(id, "trial")).toEqual([
      expect.objectContaining({ status: "skipped", wants: ["passes", "fails"] }),
    ]);
    expect(ofType(id, "trial")[0]!.results).toBeUndefined();
    expect(state.automations).toHaveLength(before);
    expect(texts(id).join("\n")).not.toContain(i18n.t("claude.answers.automation.off"));
  });

  it("la creazione sale a scheda: `skipped`, niente frase né riga finale", async () => {
    // Un'azione B al posto della A: diventa una scheda.
    const draft = state.automations.find((a) => a.projectId === ACQ && a.status === "draft");
    const target = draft ?? state.automations.find((a) => a.status === "draft")!;
    gate.steps = [
      { step: "deliver" },
      { step: "state", state: "working" },
      { step: "say", text: "Starts when…" },
      {
        step: "event",
        event: {
          type: "executed",
          groupId: "",
          status: "pending",
          actions: [
            {
              fn: "deleteAutomationDraft",
              args: { id: target.id },
              summary: "deleteAutomationDraft",
            },
          ],
        },
      },
      trialStep,
      { step: "state", state: "idle" },
    ];
    const id = await send("anything");
    expect(ofType(id, "proposal")).toHaveLength(1);
    expect(ofType(id, "trial")).toEqual([expect.objectContaining({ status: "skipped" })]);
    expect(texts(id).join("\n")).not.toContain(i18n.t("claude.answers.automation.off"));
  });
});
