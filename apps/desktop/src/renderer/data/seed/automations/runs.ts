// Le esecuzioni del seme (area 7), una per ogni caso dello spec: in attesa
// del cliente da 3 giorni, ferma su un'approvazione (un'email per Laura),
// finita, fallita (permesso perso), in attesa del progetto. Il registro
// segue i passi dei flussi in `automations.ts`.
import type { AutomationRun, RunLogEntry } from "../../types";
import { daysFromToday } from "../dates";
import { AUTOMATION_CLIENT_DATA, AUTOMATION_NEW_CONTRACT, AUTOMATION_PAUSED } from "./automations";
import { AUDIN_SAMPLE_EVENTS, WEBHOOK_SAMPLE_EVENTS } from "./sources";

export const RUN_DONE = "arun-aut1-1";
export const RUN_WAITING_PROJECT = "arun-aut1-2";
export const RUN_WAITING_APPROVAL = "arun-auda1-1";
export const RUN_WAITING_EVENT = "arun-auda1-2";
export const RUN_FAILED = "arun-mkxa1-1";

const at = (days: number, time: string) => `${daysFromToday(days)}T${time}:00Z`;

/** Una riga del registro; i campi non dati sono vuoti. */
function entry(
  e: Pick<RunLogEntry, "at" | "stepId" | "path" | "kind" | "outcome"> & Partial<RunLogEntry>,
): RunLogEntry {
  return { input: {}, output: {}, reason: null, byId: null, effects: [], ...e };
}

function trigger(when: string, event: Record<string, unknown>): RunLogEntry {
  return entry({
    at: when,
    stepId: "trigger",
    path: "trigger",
    kind: "trigger",
    outcome: "ok",
    output: event,
  });
}

// --- «Nuovo contratto» --------------------------------------------------------

const BELLAVISTA_DEAL = AUDIN_SAMPLE_EVENTS[0]!;
const FORNERIA_DEAL = AUDIN_SAMPLE_EVENTS[2]!;

const BELLAVISTA_TASKS = [
  { titolo: "Importare l'anagrafica clienti nel CRM", reparto: "Development" },
  { titolo: "Configurare il Centralino AI sui due numeri della cantina", reparto: "Support" },
  { titolo: "Fatturare il primo canone all'attivazione", reparto: "Administration" },
  { titolo: "Pianificare le due sessioni di formazione sul CRM", reparto: "Sales" },
];

const BELLAVISTA_VARS = {
  "analisi.prodotto": "CRM",
  "analisi.task": BELLAVISTA_TASKS,
};

const WELCOME = {
  to: "amministrazione@cantinabellavista.example",
  subject: "Benvenuti in Audin, Cantina Bellavista Srl",
};

// I percorsi delle task seguono la catena di condizioni sul reparto.
const TASK_PATHS = [
  "2/forEach[0]/0/then/0",
  "2/forEach[1]/0/else/0/then/0",
  "2/forEach[2]/0/else/0/else/0/then/0",
  "2/forEach[3]/0/else/0/else/0/else/0",
];
const TASK_STEPS = ["nc-task-dev", "nc-task-support", "nc-task-admin", "nc-task-sales"];

const doneRun: AutomationRun = {
  id: RUN_DONE,
  automationId: AUTOMATION_NEW_CONTRACT,
  n: 1,
  version: 1,
  title: "Nuovo contratto – Cantina Bellavista Srl",
  status: "done",
  event: BELLAVISTA_DEAL,
  vars: BELLAVISTA_VARS,
  cursor: null,
  waitingUntil: null,
  pending: null,
  startedAt: at(-12, "16:05"),
  endedAt: at(-11, "09:30"),
  error: null,
  projectIds: ["prj-cbv"],
  log: [
    trigger(at(-12, "16:05"), BELLAVISTA_DEAL),
    entry({
      at: at(-12, "16:06"),
      stepId: "nc-read",
      path: "0",
      kind: "claude",
      outcome: "ok",
      input: {
        "trattativa.contratto": "Contratto AUD-TR-1042.pdf",
        "trattativa.prodotti": ["CRM", "Centralino AI"],
      },
      output: BELLAVISTA_VARS,
      reason:
        "Il contratto attiva CRM per otto utenti e il Centralino AI: la migrazione dei contatti è tecnica, il centralino lo configura il supporto, il primo canone lo fattura l'amministrazione e la formazione la organizza il commerciale.",
    }),
    entry({
      at: at(-12, "16:06"),
      stepId: "nc-milestone",
      path: "1",
      kind: "createMilestone",
      outcome: "ok",
      input: { nome: "Attivazione CRM – Cantina Bellavista Srl", progetto: "prj-cbv" },
      effects: [{ kind: "milestone", code: "ms-cbv-aut1" }],
    }),
    entry({
      at: at(-12, "16:06"),
      stepId: "nc-each",
      path: "2",
      kind: "forEach",
      outcome: "ok",
      output: { giri: BELLAVISTA_TASKS.length },
    }),
    ...BELLAVISTA_TASKS.map((t, i) =>
      entry({
        at: at(-12, "16:07"),
        stepId: TASK_STEPS[i]!,
        path: TASK_PATHS[i]!,
        kind: "createTask",
        outcome: "ok",
        input: { titolo: t.titolo, reparto: t.reparto, progetto: "prj-cbv" },
        effects: [{ kind: "task", code: `CBV-${6 + i}` }],
      }),
    ),
    entry({
      at: at(-12, "16:07"),
      stepId: "nc-welcome",
      path: "3",
      kind: "sendEmail",
      outcome: "waiting",
      input: WELCOME,
    }),
    entry({
      at: at(-11, "09:30"),
      stepId: "nc-welcome",
      path: "3",
      kind: "sendEmail",
      outcome: "approved",
      byId: "p-roberta",
    }),
    entry({
      at: at(-11, "09:30"),
      stepId: "nc-welcome",
      path: "3",
      kind: "sendEmail",
      outcome: "ok",
      input: WELCOME,
      output: { inviata: true, casella: "p-roberta" },
    }),
  ],
};

const waitingProjectRun: AutomationRun = {
  id: RUN_WAITING_PROJECT,
  automationId: AUTOMATION_NEW_CONTRACT,
  n: 2,
  version: 1,
  title: "Nuovo contratto – Forneria Rossi & Lari",
  status: "waiting_project",
  event: FORNERIA_DEAL,
  vars: { "analisi.prodotto": "CRM" },
  cursor: "1",
  waitingUntil: null,
  pending: {
    approverIds: ["p-roberta"],
    preview: { clientKey: "forneriarossilari.example", clientName: "Forneria Rossi & Lari" },
  },
  startedAt: at(-1, "14:20"),
  endedAt: null,
  error: null,
  projectIds: [],
  log: [
    trigger(at(-1, "14:20"), FORNERIA_DEAL),
    entry({
      at: at(-1, "14:21"),
      stepId: "nc-read",
      path: "0",
      kind: "claude",
      outcome: "ok",
      input: {
        "trattativa.contratto": "Contratto AUD-TR-1063.pdf",
        "trattativa.prodotti": ["CRM", "Campagne WhatsApp", "Preventivi online"],
      },
      output: {
        "analisi.prodotto": "CRM",
        "analisi.task": [
          { titolo: "Configurare la pipeline degli ordini all'ingrosso", reparto: "Development" },
          { titolo: "Caricare il catalogo dal listino PDF", reparto: "Support" },
          { titolo: "Preparare la prima campagna ai rivenditori", reparto: "Sales" },
        ],
      },
      reason:
        "Il prodotto principale è il CRM (tre utenti); le campagne e i preventivi online dipendono dal catalogo e dalla pipeline.",
    }),
    entry({
      at: at(-1, "14:21"),
      stepId: "nc-milestone",
      path: "1",
      kind: "createMilestone",
      outcome: "waiting",
      input: { clientKey: "forneriarossilari.example" },
      reason: "Il cliente non è nella tabella cliente → progetto: deve scegliere il proprietario.",
    }),
  ],
};

// --- «Richiesta dati al cliente» ----------------------------------------------

const BELLAVISTA_REQUEST = WEBHOOK_SAMPLE_EVENTS[0]!;
const MIXCUCINE_REQUEST = WEBHOOK_SAMPLE_EVENTS[1]!;

const BELLAVISTA_REPLY =
  "Buongiorno, i numeri da collegare sono 0577 000111 e 0577 000112. Siamo aperti dal lunedì al sabato, dalle 9 alle 18.";
const MISSING = "il testo del messaggio di benvenuto";
const MISSING_EMAIL = {
  to: "amministrazione@cantinabellavista.example",
  subject: "Mancano ancora alcuni dati per Centralino AI",
  body: `Gentile Cantina Bellavista Srl,\n\ngrazie della risposta. Per completare l'attivazione ci mancano: ${MISSING}\n\nGrazie,\nil team Audin`,
};
const MISSING_PATH = "3/then/0/mancano informazioni/0";

const waitingApprovalRun: AutomationRun = {
  id: RUN_WAITING_APPROVAL,
  automationId: AUTOMATION_CLIENT_DATA,
  n: 1,
  version: 1,
  title: "Dati per Centralino AI – Cantina Bellavista Srl",
  status: "waiting_approval",
  event: BELLAVISTA_REQUEST,
  vars: { "risposta.testo": BELLAVISTA_REPLY, "verifica.mancanti": MISSING },
  cursor: MISSING_PATH,
  waitingUntil: null,
  pending: { approverIds: ["p-laura"], preview: MISSING_EMAIL },
  startedAt: at(-6, "09:40"),
  endedAt: null,
  error: null,
  projectIds: ["prj-aud"],
  log: [
    trigger(at(-6, "09:40"), BELLAVISTA_REQUEST),
    entry({
      at: at(-6, "09:40"),
      stepId: "cd-ask",
      path: "0",
      kind: "sendEmail",
      outcome: "ok",
      input: {
        to: "amministrazione@cantinabellavista.example",
        subject: "Ci servono alcuni dati per attivare Centralino AI",
      },
      output: { inviata: true, casella: "p-laura" },
    }),
    entry({ at: at(-6, "09:40"), stepId: "cd-wait", path: "1", kind: "wait", outcome: "waiting" }),
    entry({
      at: at(-4, "15:20"),
      stepId: "cd-wait",
      path: "1",
      kind: "wait",
      outcome: "ok",
      output: { "risposta.testo": BELLAVISTA_REPLY },
    }),
    entry({
      at: at(-4, "15:20"),
      stepId: "cd-reminders",
      path: "2",
      kind: "repeatUntil",
      outcome: "skipped",
      output: { giri: 0 },
      reason: "La risposta è già arrivata: nessun promemoria.",
    }),
    entry({
      at: at(-4, "15:20"),
      stepId: "cd-replied",
      path: "3",
      kind: "condition",
      outcome: "ok",
      output: { ramo: "then" },
    }),
    entry({
      at: at(-4, "15:21"),
      stepId: "cd-verify",
      path: "3/then/0",
      kind: "claude",
      outcome: "ok",
      input: {
        "richiesta.dati": (BELLAVISTA_REQUEST.richiesta as { dati: string }).dati,
        "risposta.testo": BELLAVISTA_REPLY,
      },
      output: { uscita: "mancano informazioni", "verifica.mancanti": MISSING },
      reason:
        "La risposta indica i due numeri e gli orari di apertura, ma non il testo del messaggio di benvenuto richiesto.",
    }),
    entry({
      at: at(-4, "15:21"),
      stepId: "cd-missing",
      path: MISSING_PATH,
      kind: "sendEmail",
      outcome: "waiting",
      input: MISSING_EMAIL,
      reason: "Chiede l'approvazione del proprietario.",
    }),
  ],
};

const waitingEventRun: AutomationRun = {
  id: RUN_WAITING_EVENT,
  automationId: AUTOMATION_CLIENT_DATA,
  n: 2,
  version: 1,
  title: "Dati per Campagne WhatsApp – Mix Cucine Srl",
  status: "waiting_event",
  event: MIXCUCINE_REQUEST,
  vars: {},
  cursor: "1",
  waitingUntil: at(2, "10:15"),
  pending: null,
  startedAt: at(-3, "10:15"),
  endedAt: null,
  error: null,
  projectIds: ["prj-aud"],
  log: [
    trigger(at(-3, "10:15"), MIXCUCINE_REQUEST),
    entry({
      at: at(-3, "10:15"),
      stepId: "cd-ask",
      path: "0",
      kind: "sendEmail",
      outcome: "ok",
      input: {
        to: "marketing@mixcucine.example",
        subject: "Ci servono alcuni dati per attivare Campagne WhatsApp",
      },
      output: { inviata: true, casella: "p-laura" },
    }),
    entry({
      at: at(-3, "10:15"),
      stepId: "cd-wait",
      path: "1",
      kind: "wait",
      outcome: "waiting",
      input: { replyTo: "cd-ask", maxDays: 5 },
    }),
  ],
};

// --- «Report settimanale delle campagne» (in pausa) ---------------------------

const failedRun: AutomationRun = {
  id: RUN_FAILED,
  automationId: AUTOMATION_PAUSED,
  n: 1,
  version: 1,
  title: "Report settimanale delle campagne",
  status: "failed",
  event: { data: daysFromToday(-4) },
  vars: {},
  cursor: "0",
  waitingUntil: null,
  pending: null,
  startedAt: at(-4, "09:00"),
  endedAt: at(-4, "09:00"),
  error: "permesso perso",
  projectIds: ["prj-mkx"],
  log: [
    trigger(at(-4, "09:00"), { data: daysFromToday(-4) }),
    entry({
      at: at(-4, "09:00"),
      stepId: "wk-report",
      path: "0",
      kind: "createTask",
      outcome: "failed",
      input: {
        titolo: "Report settimanale delle campagne",
        progetto: "prj-mkx",
        proprietario: "p-matteo",
      },
      reason: "permesso perso",
    }),
  ],
};

export const AUTOMATION_RUNS: AutomationRun[] = [
  doneRun,
  waitingProjectRun,
  waitingApprovalRun,
  waitingEventRun,
  failedRun,
];
