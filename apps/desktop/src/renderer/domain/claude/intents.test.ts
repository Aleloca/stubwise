import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { readsAs } from "../../data/api-mutations";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { ProposedAction, ScriptStep } from "../../data/types";
import { recognize, respond, type IntentContext, type ReadApi } from "./intents";

// Il motore di intenti sui dati del seed, letto come le persone del «vedi
// come»: legge solo con le funzioni del livello dati (della sessione) e non
// scrive mai — le modifiche escono come proposte aperte.

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");

/** Solo le letture: se il motore chiamasse una mutazione, qui non la troverebbe. */
const READ: ReadApi = {
  listProjects: api.listProjects,
  listPinnedProjectIds: api.listPinnedProjectIds,
  listProjectPulses: api.listProjectPulses,
  listProjectStatuses: api.listProjectStatuses,
  getLatestBrief: api.getLatestBrief,
  listPeople: api.listPeople,
  listTasks: api.listTasks,
  getTaskByCode: api.getTaskByCode,
  getRequest: api.getRequest,
  getRequestByCode: api.getRequestByCode,
  listDecisionRequests: api.listDecisionRequests,
  listDocPages: api.listDocPages,
  readDriveFiles: api.drive.listDriveFilesForClaude,
};

function as(personId: string, t = en, contextProjectId: string | null = null): IntentContext {
  setSessionPersonId(personId);
  return { personId, contextProjectId, read: READ, t, seed: "conv-test-1" };
}

const said = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n");
const actions = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "action" ? [s.label] : []));
const refs = (steps: ScriptStep[]) =>
  steps.flatMap((s) =>
    s.step === "event" && s.event.type === "citation" ? s.event.refs.map((r) => r.id) : [],
  );
function proposal(steps: ScriptStep[]) {
  for (const s of steps) {
    if (s.step === "event" && s.event.type === "proposal") return s.event;
  }
  return null;
}
const fns = (steps: ScriptStep[]) => proposal(steps)?.actions.map((a: ProposedAction) => a.fn);

/** Una fotografia dei dati che una proposta cambierebbe: deve restare identica. */
const snapshot = () =>
  JSON.stringify({
    tasks: state.tasks,
    requests: state.requests,
    events: [...state.conversationEvents],
  });

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

describe("riconoscimento", () => {
  it.each([
    ["Where are my projects?", "status"],
    ["A che punto sono i progetti?", "status"],
    ["What should I do today?", "today"],
    ["Cosa devo fare oggi?", "today"],
    ["Explain AUD-3", "explain"],
    ["spiegami STW-R4", "explain"],
    ["a che punto è AUD-3?", "explain"],
    ["How do scheduled callbacks work in AUD?", "howto"],
    ["Come funziona l'import dei contatti in AUD?", "howto"],
    ["Run STW-R1", "run"],
    ["Avvia STW-R1", "run"],
    ["Create “Banner copy review” in MKX", "create"],
    ["Crea «Revisione banner» in MKX", "create"],
    ["Assign AUD-10 to Marco", "assign"],
    ["Assegna AUD-10 a Marco", "assign"],
    ["Plan AUD-10 for next week", "plan"],
    ["Pianifica AUD-10 per la settimana prossima", "plan"],
    ["What's the weather like in Milan?", "general"],
    ["How are you?", "general"],
    ["Qual è la capitale del Portogallo?", "general"],
  ])("%s → %s", (text, intent) => {
    expect(recognize(text)).toBe(intent);
  });

  it("«plan» senza una settimana non è una pianificazione: spiega la task", () => {
    expect(recognize("What's the plan for AUD-3?")).toBe("explain");
  });

  it.each([
    ["Can you run AUD-4?", "run"],
    ["Please create “Banner copy review” in MKX", "create"],
    ["Could you plan AUD-10 for next week?", "plan"],
    // Dopo una cortesia l'infinito vale come comando, anche con il «?» (fix round 2).
    ["Potresti assegnare AUD-10 a Marco?", "assign"],
    ["Puoi creare “Banner copy review” in MKX", "create"],
    ["Puoi crearmi una task in MKX", "create"],
    ["Vorrei creare “Banner copy review” in MKX", "create"],
    ["Puoi avviare STW-R3", "run"],
    ["Puoi avviare STW-R3?", "run"],
    ["Puoi pianificare MKX-4 per la prossima settimana", "plan"],
    ["Puoi assegnare MKX-4 a Paolo", "assign"],
    ["Mi puoi aggiungere “Banner copy review” in MKX?", "create"],
    ["Per favore, avvia STW-R1", "run"],
    ["Please, run STW-R1", "run"],
    ["Ciao, puoi avviare STW-R1?", "run"],
    ["Hi, could you assign AUD-10 to Marco?", "assign"],
  ])("una richiesta cortese resta un comando: %s → %s", (text, intent) => {
    expect(recognize(text)).toBe(intent);
  });

  it.each([
    ["Puoi dirmi quando è partita AUD-4?", "explain"],
    ["Ciao, chi ha assegnato AUD-10 a Marco?", "explain"],
    ["Hi, why did the run on AUD-4 fail?", "explain"],
    // Un infinito senza cortesia non è un comando.
    ["Avviare AUD-4 è stata una buona idea?", "explain"],
  ])("una domanda resta una domanda anche con saluti e cortesie: %s → %s", (text, intent) => {
    expect(recognize(text)).toBe(intent);
  });

  it("le proposte nate da richieste cortesi in italiano", async () => {
    const created = await respond("Puoi creare “Banner copy review” in MKX?", as("p-giulia", it_));
    expect(fns(created)).toEqual(["createTask"]);
    const planned = await respond(
      "Puoi pianificare MKX-4 per la prossima settimana?",
      as("p-giulia", it_),
    );
    expect(proposal(planned)!.actions[0]!.args).toMatchObject({
      id: "t-mkx-4",
      plan: { week: "2026-W44" },
    });
    const assigned = await respond("Puoi assegnare MKX-4 a Paolo", as("p-giulia", it_));
    expect(proposal(assigned)!.actions[0]!.args).toEqual({
      id: "t-mkx-4",
      patch: { assigneeId: "p-paolo" },
    });
    expect(fns(await respond("Ciao, puoi avviare STW-R1?", as("p-giulia", it_)))).toEqual([
      "convertRequest",
      "startRun",
    ]);
  });
});

describe("una domanda non diventa mai una proposta (fix round 1)", () => {
  it.each([
    ["When did AUD-4 start?", "explain"],
    ["Why did the run on AUD-4 fail?", "explain"],
    ["AUD-10 è pianificata per la settimana prossima?", "explain"],
    ["Chi ha assegnato AUD-10 a Marco?", "explain"],
    ["Is AUD-10 planned for next week?", "explain"],
    ["How do I add contacts in AUD?", "howto"],
    ["Come si crea un preventivo in AUD?", "howto"],
    ["How does UTF-8 import work in AUD?", "howto"],
  ])("%s → %s, nessuna proposta", async (text, intent) => {
    const ctx = as("p-giulia");
    const visible = new Set((await api.listProjects()).map((p) => p.code));
    expect(recognize(text, visible)).toBe(intent);
    expect(proposal(await respond(text, ctx))).toBeNull();
  });

  it("«UTF-8» non è un codice: cerca nei Docs di AUD", async () => {
    const steps = await respond("How does UTF-8 import work in AUD?", as("p-giulia"));
    expect(actions(steps)).toEqual(["Searched AUD docs for “UTF-8 import”"]);
    expect(refs(steps)).toEqual(["doc-aud-import"]);
  });

  it("un codice in minuscolo vale solo se il prefisso è un progetto visibile", async () => {
    expect(refs(await respond("explain aud-3", as("p-giulia")))).toEqual(["t-aud-3"]);
    // Sara non vede AUD: «aud-3» non è un codice per lei, quindi nessuna lettura di AUD.
    const sara = await respond("explain aud-3", as("p-sara"));
    expect(refs(sara)).toEqual([]);
    expect(actions(sara)).toEqual([]);
  });

  it("create: il progetto nel titolo fra virgolette non conta", async () => {
    const steps = await respond("Create “Report for AUD” in MKX", as("p-giulia"));
    expect(proposal(steps)!.actions[0]!.args).toEqual({
      projectId: "prj-mkx",
      title: "Report for AUD",
    });
  });

  it("run di una richiesta fusa in una che non vedo: frase a sé, nessun «****»", async () => {
    const read: ReadApi = { ...READ, getRequest: async () => null };
    const steps = await respond("Run STW-R3", { ...as("p-giulia"), read });
    expect(said(steps)).toBe(
      "**STW-R3 Drag and drop on the board** was merged into another request that you can't see, so there's nothing to start here.",
    );
    expect(said(steps)).not.toContain("****");
    expect(proposal(steps)).toBeNull();
  });
});

describe("risposte come Giulia", () => {
  it("ogni risposta: consegna, al lavoro, … , di nuovo in attesa", async () => {
    const steps = await respond("What should I do today?", as("p-giulia"));
    expect(steps[0]).toEqual({ step: "deliver" });
    expect(steps[1]).toEqual({ step: "state", state: "working" });
    expect(steps.at(-1)).toEqual({ step: "state", state: "idle" });
  });

  it("status: il polso dei progetti fissati, citati", async () => {
    const steps = await respond("Where are my projects?", as("p-giulia"));
    expect(actions(steps)).toEqual(["Read the pulse of 14 projects"]);
    const text = said(steps);
    expect(text).toMatch(/^Here's where your pinned projects stand:/);
    expect(text).toContain("**AUD** Audin 2.0 — 5 to do, 4 in progress");
    expect(text).toContain("waiting on you");
    expect(text).toContain("…and 6 more");
    expect(refs(steps)).toContain("prj-aud");
    expect(proposal(steps)).toBeNull();
  });

  it("status di un progetto: polso e prima riga del brief (testo generato)", async () => {
    const steps = await respond("a che punto sono i progetti di AUD?", as("p-giulia", it_));
    expect(actions(steps)).toEqual(["Letto il polso di AUD"]);
    expect(said(steps)).toContain("**AUD** Audin 2.0 — 5 da fare, 4 in corso");
    expect(said(steps)).toContain("Il brief settimanale (testo generato) dice:");
    expect(refs(steps)).toEqual(["prj-aud"]);
  });

  it("today: decisioni che la aspettano, in ritardo, settimana", async () => {
    const steps = await respond("What should I do today?", as("p-giulia"));
    const text = said(steps);
    expect(text).toContain("**3 decisions waiting on you**");
    expect(text).toContain("STW-4 Wording of the stalled reasons — Laura Costa asks:");
    expect(text).toContain("**1 task overdue or due today**");
    expect(text).toContain("FRL-2 Collect testimonials for the case study — overdue since Oct 18");
    expect(text).toContain("more tasks planned this week**");
    expect(refs(steps)).toContain("t-stw-4");
    expect(proposal(steps)).toBeNull();
  });

  it("today in italiano", async () => {
    const steps = await respond("Cosa devo fare oggi?", as("p-giulia", it_));
    expect(said(steps)).toContain("**3 decisioni ti aspettano**");
    expect(said(steps)).toContain("in ritardo dal 18 ott");
  });

  it("explain di una task: riassunto e citazione", async () => {
    const steps = await respond("Explain AUD-3", as("p-giulia"));
    expect(actions(steps)).toEqual(["Looked up AUD-3"]);
    const text = said(steps);
    expect(text).toContain(
      "**AUD-3 Import contacts from CSV with duplicates check** is a task in AUD Audin 2.0",
    );
    expect(text).toContain("Assigned to Marco Bellini");
    expect(text).toContain("Claude is waiting for an answer");
    expect(refs(steps)).toEqual(["t-aud-3"]);
  });

  it("explain di una richiesta, in italiano", async () => {
    const steps = await respond("spiegami STW-R4", as("p-giulia", it_));
    expect(said(steps)).toContain(
      "**STW-R4 Quiet hours for notifications** è una richiesta di STW Stubwise: in rifinitura.",
    );
    expect(said(steps)).toContain("Chiesta da Elena Moretti");
    expect(refs(steps)).toEqual(["req-stw-4"]);
  });

  it("explain di un codice che non esiste: «non la trovo o non puoi vederla», niente citazioni", async () => {
    const steps = await respond("Explain AUD-99", as("p-giulia"));
    expect(said(steps)).toBe("I can't find AUD-99, or you can't see it.");
    expect(refs(steps)).toEqual([]);
  });

  it("howto: cerca nei Docs del progetto e cita la pagina", async () => {
    const steps = await respond("How do scheduled callbacks work in AUD?", as("p-giulia"));
    expect(actions(steps)).toEqual(["Searched AUD docs for “scheduled callbacks”"]);
    expect(said(steps)).toContain(
      "From the AUD Docs, page **AUD-D1 Scheduled callbacks** (Guide / Dialer):",
    );
    expect(said(steps)).toContain("> A callback is stored in UTC");
    expect(refs(steps)).toEqual(["doc-aud-callbacks"]);
  });

  it("howto in italiano", async () => {
    const steps = await respond("Come funziona l'import dei contatti in AUD?", as("p-giulia", it_));
    expect(said(steps)).toMatch(/Dai Docs di AUD, pagina \*\*AUD-D\d+ Importing contacts\*\*/);
    expect(refs(steps)).toEqual(["doc-aud-import"]);
  });

  it("howto con il progetto della conversazione come contesto", async () => {
    const steps = await respond("How does weekly planning work?", as("p-giulia", en, "prj-stw"));
    expect(refs(steps)).toEqual(["doc-stw-planning"]);
  });

  it("howto su un progetto senza Docs: lo dice, non inventa", async () => {
    const steps = await respond("How does billing work in MKX?", as("p-giulia"));
    expect(said(steps)).toBe(
      "MKX has no Docs, so I have nothing to quote. I won't guess: you could ask the team with a request.",
    );
    expect(refs(steps)).toEqual([]);
  });

  it("howto che i Docs non coprono: lo dice", async () => {
    const steps = await respond("How do refunds work in AUD?", as("p-giulia"));
    expect(said(steps)).toContain("The AUD Docs don't cover “refunds”.");
    expect(refs(steps)).toEqual([]);
  });

  it("run di una richiesta nuova: proposta convertRequest + startRun, nessuna esecuzione", async () => {
    const before = snapshot();
    const steps = await respond("Run STW-R1", as("p-giulia"));
    expect(fns(steps)).toEqual(["convertRequest", "startRun"]);
    const p = proposal(steps)!;
    expect(p.status).toBe("open");
    expect(p.requesterId).toBe("p-giulia");
    expect(p.actions[0]!.args).toEqual({
      id: "req-stw-1",
      input: { title: "Show who moved a task to another week" },
    });
    expect(p.actions[1]!.args).toEqual({ taskFromAction: 0 });
    expect(p.actions[0]!.summary).toBe(
      "Turn STW-R1 into a task in STW: “Show who moved a task to another week”",
    );
    // Nulla è cambiato: la richiesta è ancora nuova, nessuna task nata.
    expect(snapshot()).toBe(before);
    expect(state.requests.find((r) => r.id === "req-stw-1")!.status).toBe("new");
  });

  it("run di una richiesta già trasformata: startRun sulla sua task", async () => {
    const steps = await respond("Avvia STW-R2", as("p-giulia", it_));
    expect(fns(steps)).toEqual(["startRun"]);
    expect(proposal(steps)!.actions[0]!.args).toEqual({ taskId: "t-stw-3" });
    expect(said(steps)).toContain(
      "è già diventata **STW-3 Board view with keyboard drag and drop**",
    );
  });

  it("run di una task: startRun; di una richiesta archiviata: nessuna proposta", async () => {
    expect(fns(await respond("Start AUD-4", as("p-giulia")))).toEqual(["startRun"]);
    const merged = await respond("Run STW-R3", as("p-giulia"));
    expect(proposal(merged)).toBeNull();
    expect(said(merged)).toContain("was merged into **STW-R2");
  });

  it("create: proposta createTask con persona, settimana e taglia", async () => {
    const before = snapshot();
    const steps = await respond(
      "Create “Banner copy review” in MKX for Marco next week size M",
      as("p-giulia"),
    );
    const p = proposal(steps)!;
    expect(p.actions).toEqual([
      {
        fn: "createTask",
        args: {
          projectId: "prj-mkx",
          title: "Banner copy review",
          assigneeId: "p-marco",
          plannedWeek: "2026-W44",
          size: "M",
        },
        summary: "Create in MKX: “Banner copy review” · Marco Bellini · W44 · M",
        // La frase, che chi guarda rilegge nella sua lingua.
        summaryText: {
          key: "claude.answers.create.summaryWithMeta",
          params: { code: "MKX", title: "Banner copy review", meta: "Marco Bellini · W44 · M" },
        },
      },
    ]);
    expect(snapshot()).toBe(before);
  });

  it("create in italiano, con il progetto del contesto", async () => {
    const steps = await respond("Crea «Revisione testi banner»", as("p-giulia", it_, "prj-mkx"));
    expect(proposal(steps)!.actions[0]!.summary).toBe("Crea in MKX: «Revisione testi banner»");
  });

  it("create senza progetto né contesto: chiede dove, nessuna proposta", async () => {
    const steps = await respond("Create “Banner copy review”", as("p-giulia"));
    expect(proposal(steps)).toBeNull();
    expect(said(steps)).toMatch(/^In which project/);
  });

  it("assign: proposta updateTask", async () => {
    const steps = await respond("Assegna AUD-10 a Marco", as("p-giulia", it_));
    expect(proposal(steps)!.actions).toEqual([
      {
        fn: "updateTask",
        args: { id: "t-aud-10", patch: { assigneeId: "p-marco" } },
        summary: "Assegna AUD-10 Store review notes for the mobile app a Marco Bellini",
        summaryText: {
          key: "claude.answers.assign.summary",
          params: { task: "AUD-10 Store review notes for the mobile app", name: "Marco Bellini" },
        },
      },
    ]);
  });

  it("plan: proposta planTask sulla settimana nominata", async () => {
    const steps = await respond("Plan AUD-10 for next week for Marco", as("p-giulia"));
    expect(proposal(steps)!.actions).toEqual([
      {
        fn: "planTask",
        args: { id: "t-aud-10", plan: { assigneeId: "p-marco", week: "2026-W44" } },
        summary: "Plan AUD-10 Store review notes for the mobile app · Marco Bellini · W44",
        summaryText: {
          key: "claude.answers.plan.summary",
          params: {
            task: "AUD-10 Store review notes for the mobile app",
            name: "Marco Bellini",
            week: "W44",
          },
        },
      },
    ]);
  });

  it("general: risposta generica, nessuna azione, nessuna proposta", async () => {
    for (const [text, t] of [
      ["What's the weather like in Milan?", en],
      ["Qual è la capitale del Portogallo?", it_],
    ] as const) {
      const steps = await respond(text, as("p-giulia", t));
      expect(actions(steps)).toEqual([]);
      expect(proposal(steps)).toBeNull();
      expect(refs(steps)).toEqual([]);
      expect(said(steps)).toBe(t("claude.answers.general"));
    }
  });

  it("stesso testo e stesso seme → stessa proposta (puro e deterministico)", async () => {
    const a = await respond("Run STW-R1", as("p-giulia"));
    const b = await respond("Run STW-R1", as("p-giulia"));
    expect(a).toEqual(b);
    const c = await respond("Run STW-R1", { ...as("p-giulia"), seed: "conv-test-2" });
    expect(proposal(c)!.proposalId).not.toBe(proposal(a)!.proposalId);
  });
});

describe("le letture sono di chi conversa (Sara non vede AUD)", () => {
  it("explain di una task di AUD: la stessa frase di un codice inesistente, nessun dettaglio", async () => {
    const hidden = await respond("Explain AUD-3", as("p-sara"));
    const missing = await respond("Explain AUD-99", as("p-sara"));
    expect(said(hidden)).toBe("I can't find AUD-3, or you can't see it.");
    expect(said(missing)).toBe("I can't find AUD-99, or you can't see it.");
    expect(JSON.stringify(hidden)).not.toContain("Import contacts");
    expect(refs(hidden)).toEqual([]);
    expect(proposal(hidden)).toBeNull();
  });

  it("run, assign, howto su AUD: nessuna proposta, nessuna pagina", async () => {
    expect(proposal(await respond("Run AUD-R2", as("p-sara")))).toBeNull();
    expect(proposal(await respond("Assign AUD-10 to Marco", as("p-sara")))).toBeNull();
    const docs = await respond("How do scheduled callbacks work in AUD?", as("p-sara"));
    expect(refs(docs)).toEqual([]);
    expect(said(docs)).toBe("I can't find a project AUD, or you can't see it.");
  });

  it("la stessa domanda dà a Giulia la task", async () => {
    expect(refs(await respond("Explain AUD-3", as("p-giulia")))).toEqual(["t-aud-3"]);
  });
});

// Review Focus 1 (area 6): Claude non legge la posta né le riunioni di
// nessuno. Il motore riceve solo le letture di `ReadApi`, nessuna delle
// quali tocca posta, trascrizioni o calendario; le domande su email e
// riunioni ricadono negli intenti esistenti e non citano mai un messaggio.
// La bozza di una risposta (`mailDraft.ts`) legge la conversazione con
// `getMailThread`, già filtrata da `canSeeMessage` (Task 4).
describe("la posta e le riunioni di altri non arrivano a Claude (Review Focus 1)", () => {
  const QUESTIONS = [
    "What did Sofia write about the VAT number column?",
    "Summarize the AUD weekly review meeting",
    "Cosa dice l'email sul billing export di AUD?",
    "What do I have today?",
    "Riassumi la riunione settimanale di AUD",
  ];
  const secrets = () => [
    ...new Set(state.mailMessages.map((m) => m.subject).filter((s) => s.length > 12)),
    ...state.meetingTranscripts.flatMap((t) => (t.summary ? [t.summary.slice(0, 40)] : [])),
  ];

  // Il perimetro delle letture di Claude, chiuso. Una lettura nuova di posta,
  // trascrizioni o calendario che entra qui DEVE passare dai filtri di chi
  // conversa (`canSeeMessage`, `canSeeTranscript`, `canSeeEvent`/`canReadEvent`,
  // o una lettura del livello dati costruita su di loro): chi allarga
  // l'elenco aggiorni il test sapendo di aprire una porta.
  it("le letture di Claude sono un elenco chiuso, senza posta né calendario", () => {
    expect(Object.keys(readsAs("p-giulia")).sort()).toEqual([
      "getLatestBrief",
      "getRequest",
      "getRequestByCode",
      "getTaskByCode",
      "listDecisionRequests",
      "listDocPages",
      "listPeople",
      "listPinnedProjectIds",
      "listProjectPulses",
      "listProjectStatuses",
      "listProjects",
      "listTasks",
      "readDriveFiles",
    ]);
  });

  // E il motore non ha altre strade: dal livello dati importa solo tipi e
  // date, mai una lettura (che non passerebbe da `ReadApi`).
  it("domain/claude importa da data/ solo tipi e date", () => {
    // I test girano da apps/desktop (vitest.config.ts); happy-dom non dà un `import.meta.url` file:.
    const root = join(process.cwd(), "src/renderer/domain/claude");
    const sources = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
    );
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      const text = readFileSync(join(root, file), "utf8");
      for (const [, found] of text.matchAll(/from\s+"([^"]*\/data\/[^"]*)"/g)) {
        const spec = found ?? "";
        expect([file, spec.replace(/^(\.\.\/)+/, "")]).toEqual([
          file,
          expect.stringMatching(/^data\/(types|dates)$/),
        ]);
        if (!spec.endsWith("/types")) {
          // Dalle date, solo valori (l'orologio fisso), non funzioni di lettura.
          expect(spec).toMatch(/\/dates$/);
        }
      }
    }
  });

  for (const [personId, who] of [
    ["p-roberta", "l'admin"],
    ["p-alessia", "un collega di AUD non destinatario"],
  ] as const) {
    it(`${who}: nessun oggetto, testo o riassunto nelle risposte`, async () => {
      expect(secrets().length).toBeGreaterThan(10);
      for (const q of QUESTIONS) {
        const out = JSON.stringify(await respond(q, as(personId)));
        for (const secret of secrets()) expect(out).not.toContain(secret);
      }
    });
  }
});
