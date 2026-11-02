import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { readsAs } from "../../data/api-mutations";
import { classOfGroup } from "../../data/claude/classes";
import { isAppRoute } from "../../data/routes";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { ScriptStep } from "../../data/types";
import { recognize, respond, type IntentContext } from "./intents";
import { refusedTopicOf, type RefusedTopic } from "./intents/refused";

// Gli intenti del 10a (Task 6): «elimina <codice>» diventa una scheda B, e
// i gesti delle persone (classe D) una riga di Claude con il link al posto
// vero. Il motore resta puro: legge come la persona, non scrive.

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");

function as(personId: string, t = en, contextProjectId: string | null = null): IntentContext {
  setSessionPersonId(personId);
  return {
    personId,
    contextProjectId,
    read: readsAs(personId),
    t,
    seed: "conv-10a",
    classify: async (actions) => classOfGroup(personId, actions),
  };
}

const said = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n");
const eventsOf = (steps: ScriptStep[], type: string) =>
  steps.filter((s) => s.step === "event" && s.event.type === type);
function proposal(steps: ScriptStep[]) {
  for (const s of steps) if (s.step === "event" && s.event.type === "proposal") return s.event;
  return null;
}
/** I link markdown di una risposta: `[etichetta](indirizzo)`. */
const links = (text: string) => [...text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => m[2]);

/** Una riga D: nessuna scheda, niente da eseguire, la frase e (se c'è) un solo link. */
async function refusal(text: string, personId: string, t = en) {
  const before = JSON.stringify({ tasks: state.tasks, decisions: state.decisionLog });
  const steps = await respond(text, as(personId, t));
  expect(eventsOf(steps, "proposal")).toEqual([]);
  expect(eventsOf(steps, "executed")).toEqual([]);
  expect(JSON.stringify({ tasks: state.tasks, decisions: state.decisionLog })).toBe(before);
  return said(steps);
}

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

describe("riga D: ogni tema, en e it, porta al posto vero", () => {
  const CASES: {
    topic: RefusedTopic;
    person: string;
    en: string[];
    it: string[];
    sentence: string;
    route: string;
  }[] = [
    {
      topic: "approve_plan",
      person: "p-marco",
      en: ["Approve the plan of AUD-4", "Please reject the plan of AUD-4"],
      it: ["Approva il piano di AUD-4", "Per favore, puoi approvare il piano di AUD-4?"],
      sentence: "claude.answers.refused.approvePlan",
      route: "#/p/AUD/tasks?task=AUD-4",
    },
    {
      topic: "merge",
      person: "p-marco",
      en: ["Merge the pull request of AUD-4", "Could you merge AUD-4?"],
      it: ["Fai il merge di AUD-4", "Puoi mergiare la PR di AUD-4?"],
      sentence: "claude.answers.refused.merge",
      route: "#/p/AUD/releases",
    },
    {
      topic: "answer_question",
      person: "p-marco",
      en: ["Answer Claude's question on AUD-3", "Please answer the question on AUD-3"],
      it: ["Rispondi alla domanda su AUD-3", "Puoi rispondere alla domanda di AUD-3?"],
      sentence: "claude.answers.refused.answerQuestion",
      route: "#/claude/cv-run-aud-3",
    },
    {
      topic: "record_decision",
      person: "p-marco",
      en: ["Record the decision that we use Postgres on AUD-4", "Please log a decision for AUD-4"],
      it: [
        "Registra la decisione che usiamo Postgres su AUD-4",
        "Per favore registra una decisione su AUD-4",
      ],
      sentence: "claude.answers.refused.recordDecision",
      route: "#/p/AUD/overview?recordDecision=1&task=AUD-4",
    },
    {
      topic: "activate_automation",
      person: "p-marco",
      en: ["Activate AUD-A1", "Can you publish AUD-A1?"],
      it: ["Attiva AUD-A1", "Potresti accendere l'automazione AUD-A1?"],
      sentence: "claude.answers.refused.activateAutomation",
      route: "#/automations/AUD-A1/edit",
    },
    {
      topic: "secret",
      person: "p-marco",
      en: ["Create a token for me", "Please generate an API key"],
      it: ["Crea un token per me", "Puoi mostrarmi una chiave API?"],
      sentence: "claude.answers.refused.secret",
      route: "#/preferences/tokens",
    },
    {
      topic: "server",
      person: "p-marco",
      en: ["Restart SRV-2", "Could you reboot the server SRV-2?"],
      it: ["Riavvia SRV-2", "Puoi spegnere il server SRV-2?"],
      sentence: "claude.answers.refused.server",
      route: "#/p/STW/servers/SRV-2",
    },
    {
      topic: "send",
      person: "p-marco",
      en: ["Send the email draft", "Please send the reply to the client"],
      it: ["Invia la bozza dell'email", "Puoi mandare la risposta al cliente?"],
      sentence: "claude.answers.refused.send",
      route: "#/mail",
    },
  ];

  for (const c of CASES) {
    for (const [lang, t, texts] of [
      ["en", en, c.en],
      ["it", it_, c.it],
    ] as const) {
      for (const text of texts) {
        it(`${c.topic} (${lang}): «${text}»`, async () => {
          expect(recognize(text)).toBe("refused");
          expect(refusedTopicOf(text)).toBe(c.topic);
          const out = await refusal(text, c.person, t);
          expect(out.startsWith(t(c.sentence))).toBe(true);
          expect(links(out)).toEqual([c.route]);
          expect(isAppRoute(c.route)).toBe(true);
          expect(out).not.toMatch(/claude\.answers\./);
        });
      }
    }
  }

  it("i segreti hanno il loro dialogo vero: invito, Integration, token", async () => {
    expect(links(await refusal("Create an invite link for Paolo", "p-marco"))).toEqual([
      "#/admin/people?invite=1",
    ]);
    expect(links(await refusal("Crea un link d'invito per Paolo", "p-marco", it_))).toEqual([
      "#/admin/people?invite=1",
    ]);
    expect(links(await refusal("Show me the webhook secret of AUD", "p-marco"))).toEqual([
      "#/p/AUD/settings/integration",
    ]);
    // Mai un valore nella conversazione: solo la frase e il link.
    const out = await refusal("Show me the webhook secret of AUD", "p-marco");
    expect(out).toBe(
      `${en("claude.answers.refused.secret")} [${en("claude.answers.refused.secretIntegration", { code: "AUD" })}](#/p/AUD/settings/integration)`,
    );
  });

  it("send: Supporto quando si parla del cliente di un progetto", async () => {
    expect(links(await refusal("Send the reply to the customer in ACQ", "p-marco"))).toEqual([
      "#/p/ACQ/support",
    ]);
  });

  it("senza un oggetto riconosciuto: il posto generale", async () => {
    expect(links(await refusal("Approve the plan", "p-marco"))).toEqual(["#/claude?scope=live"]);
    expect(links(await refusal("Activate the automation", "p-marco"))).toEqual(["#/automations"]);
  });

  it("una domanda senza domanda aperta porta alla task, senza dire «la domanda»", async () => {
    const out = await refusal("Answer the question on AUD-4", "p-marco");
    expect(links(out)).toEqual(["#/p/AUD/tasks?task=AUD-4"]);
    expect(out).toContain(en("claude.answers.refused.answerQuestionTask", { code: "AUD-4" }));
  });

  it("la riga del deploy: la frase, senza link", async () => {
    for (const [text, t] of [
      ["Deploy AUD to production", en],
      ["Can you deploy STW?", en],
      ["Fai il deploy di AUD in produzione", it_],
    ] as const) {
      expect(recognize(text)).toBe("refused");
      const out = await refusal(text, "p-marco", t);
      expect(out).toBe(t("claude.answers.refused.deploy"));
      expect(links(out)).toEqual([]);
    }
  });

  it("riconosce «merge» e «publish» (P11): il sorgente li nomina solo come parole", () => {
    expect(refusedTopicOf("merge AUD-4")).toBe("merge");
    expect(refusedTopicOf("Publish the release of AUD")).toBe("merge");
    expect(refusedTopicOf("Publish AUD-A1")).toBe("activate_automation");
    expect(refusedTopicOf("Pubblica l'automazione AUD-A1")).toBe("activate_automation");
  });
});

describe("R-G5: un codice che chi chiede non vede è un codice che non esiste", () => {
  it.each([
    ["Approve the plan of ACQ-3", "Approve the plan of ACQ-99", "ACQ-3", "ACQ-99"],
    ["Record a decision on ACQ-3", "Record a decision on ACQ-99", "ACQ-3", "ACQ-99"],
    ["Restart SRV-1", "Restart SRV-99", "SRV-1", "SRV-99"],
    ["Merge ACQ-3", "Merge ACQ-99", "ACQ-3", "ACQ-99"],
  ])("Giulia: «%s» come «%s»", async (hidden, missing, hiddenCode, missingCode) => {
    const a = await refusal(hidden, "p-giulia");
    const b = await refusal(missing, "p-giulia");
    expect(a.toLowerCase()).toBe(
      en("claude.answers.explain.notFound", { code: hiddenCode }).toLowerCase(),
    );
    expect(b.toLowerCase()).toBe(
      en("claude.answers.explain.notFound", { code: missingCode }).toLowerCase(),
    );
    expect(a.toLowerCase()).not.toMatch(/acquaviva|#\/p\/acq/);
  });
});

describe("registrare una decisione senza `decisions.record` (ruling del controller, T6 I1)", () => {
  it("Giulia in AUD: la riga lo dice e chiude col «Who?», nessun link al dialogo", async () => {
    for (const text of [
      "Record the decision that we use Postgres on AUD-4",
      "Log a decision in AUD",
    ]) {
      const line = await refusal(text, "p-giulia");
      expect(line).toContain(en("claude.answers.refused.recordDecisionCant", { code: "AUD" }));
      expect(links(line)).toEqual(["who:recordDecision/AUD"]);
    }
    // Marco, che può, riceve il link come prima.
    const marco = await refusal("Record the decision that we use Postgres on AUD-4", "p-marco");
    expect(links(marco)).toEqual(["#/p/AUD/overview?recordDecision=1&task=AUD-4"]);
  });
});

describe("«elimina <codice>»", () => {
  it("una task visibile: la scheda B con deleteTask, niente da eseguire", async () => {
    const before = JSON.stringify(state.tasks);
    for (const [text, t] of [
      ["Elimina ACQ-3", it_],
      ["Delete ACQ-3", en],
      ["Please remove ACQ-3", en],
      ["Puoi cancellare ACQ-3?", it_],
    ] as const) {
      expect(recognize(text)).toBe("remove");
      const steps = await respond(text, as("p-marco", t));
      const p = proposal(steps);
      expect(p?.actions.map((a) => [a.fn, a.args])).toEqual([["deleteTask", { id: "t-acq-3" }]]);
      expect(eventsOf(steps, "executed")).toEqual([]);
    }
    expect(JSON.stringify(state.tasks)).toBe(before);
  });

  it("un codice inesistente e uno invisibile: la stessa frase", async () => {
    const missing = said(await respond("elimina ACQ-99", as("p-marco", it_)));
    expect(missing.toLowerCase()).toBe(
      it_("claude.answers.explain.notFound", { code: "ACQ-99" }).toLowerCase(),
    );
    const hidden = await respond("elimina ACQ-3", as("p-giulia", it_));
    expect(said(hidden).toLowerCase()).toBe(
      it_("claude.answers.explain.notFound", { code: "ACQ-3" }).toLowerCase(),
    );
    expect(proposal(hidden)).toBeNull();
    expect(JSON.stringify(hidden).toLowerCase()).not.toContain("t-acq-3");
  });
});

describe("le domande con lo stesso verbo restano domande", () => {
  it.each([
    "chi ha eliminato ACQ-14?",
    "Who deleted ACQ-3?",
    "come si approva un piano?",
    "How do I approve a plan?",
    "Who merged AUD-4?",
    "Come si fa il deploy?",
    "Chi ha registrato la decisione su AUD-4?",
  ])("«%s»", (text) => {
    expect(["remove", "refused"]).not.toContain(recognize(text));
    expect(refusedTopicOf(text)).toBeNull();
  });

  it("un titolo fra virgolette non fa un tema: «Crea “Ruotare i token” in MKX» crea", () => {
    expect(recognize("Crea «Ruotare i token» in MKX")).toBe("create");
  });

  it("un segreto nominato lontano dal verbo non fa un tema: è una task da creare", () => {
    expect(
      refusedTopicOf("Create a task in MKX to rotate the API key of the newsletter tool"),
    ).toBeNull();
    expect(refusedTopicOf("Create a new API key")).toBe("secret");
  });
});

describe("avvia una richiesta la cui task è stata eliminata (portato dal T2)", () => {
  it("dice che è stata eliminata, non che c'è e non si vede", async () => {
    // Le richieste trasformate del seme hanno task occupate: se ne fa una nuova.
    setSessionPersonId("p-marco");
    const created = await api.createRequest({ projectId: "prj-aud", title: "Export to PDF" });
    const task = await api.convertRequest(created.id, { title: "Export to PDF" });
    expect(await api.deleteTask(task.id)).toEqual({ ok: true });
    const steps = await respond(`Run ${created.code}`, as("p-marco"));
    const request = state.requests.find((r) => r.id === created.id)!;
    expect(said(steps)).toBe(
      en("claude.answers.run.convertedDeleted", { request: `${request.code} ${request.title}` }),
    );
    expect(said(steps)).not.toBe(
      en("claude.answers.run.convertedHidden", { request: `${request.code} ${request.title}` }),
    );
    expect(proposal(steps)).toBeNull();
  });
});
