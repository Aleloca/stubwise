// Le automazioni del seme (area 7): i due esempi dello spec, attivi
// («Nuovo contratto», generale; «Richiesta dati al cliente», di AUD), una
// bozza mai accesa e una in pausa (BTG-A1, il cui proprietario è uscito dal
// progetto). I flussi usano solo i passi del modello.
import type { Automation, AutomationFlow, Condition, Step } from "../../types";
import { daysFromToday } from "../dates";
import { SOURCE_AUDIN, SOURCE_WEBHOOK } from "./sources";

export const AUTOMATION_NEW_CONTRACT = "aut-new-contract";
export const AUTOMATION_CLIENT_DATA = "aut-aud-client-data";
export const AUTOMATION_DRAFT = "aut-stw-triage";
export const AUTOMATION_PAUSED = "aut-btg-weekly";

const at = (days: number, time: string) => `${daysFromToday(days)}T${time}:00Z`;
const AUTO = { mode: "auto" } as const;
const ASK_OWNER = { mode: "ask", who: { owner: true } } as const;
const FROM_CLIENT = { mode: "from_client", clientRef: "cliente.dominio" } as const;
const OWN = { mode: "own" } as const;

// --- «Nuovo contratto» --------------------------------------------------------

/** Una task di attivazione per il reparto che Claude ha indicato. */
function activationTask(id: string, departmentId: string): Step {
  return {
    id,
    kind: "createTask",
    title: "{{task.titolo}}",
    description: "Dal contratto «{{trattativa.titolo}}» con {{cliente.nome}}.",
    assignee: { departmentId },
    dueInDays: 14,
    project: FROM_CLIENT,
    milestoneRef: "nc-milestone",
    approval: AUTO,
  };
}

const departmentIs = (name: string): Condition => ({
  left: { ref: "task.reparto" },
  op: "is",
  right: { value: name },
});

function newContractFlow(welcomeSubject: string): AutomationFlow {
  return {
    trigger: { kind: "source", sourceId: SOURCE_AUDIN, event: "deal_won" },
    titleTemplate: "Nuovo contratto – {{cliente.nome}}",
    steps: [
      {
        id: "nc-read",
        kind: "claude",
        instruction:
          "Leggi il contratto e i prodotti venduti. Indica il prodotto principale e l'elenco delle task di attivazione, ciascuna col reparto che se ne occupa (Sales, Support, Development o Administration).",
        inputs: ["trattativa.contratto", "trattativa.prodotti"],
        outcomes: [],
        fields: [
          { key: "analisi.prodotto", label: "Prodotto principale", type: "text" },
          {
            key: "analisi.task",
            label: "Task di attivazione",
            type: "list",
            of: [
              { key: "titolo", label: "Titolo", type: "text" },
              { key: "reparto", label: "Reparto", type: "text" },
            ],
          },
        ],
        branches: {},
      },
      {
        id: "nc-milestone",
        kind: "createMilestone",
        name: "Attivazione {{analisi.prodotto}} – {{cliente.nome}}",
        dueInDays: 30,
        project: FROM_CLIENT,
        approval: AUTO,
      },
      {
        id: "nc-each",
        kind: "forEach",
        list: "analisi.task",
        as: "task",
        steps: [
          {
            id: "nc-dev",
            kind: "condition",
            when: departmentIs("Development"),
            then: [activationTask("nc-task-dev", "dep-development")],
            else: [
              {
                id: "nc-support",
                kind: "condition",
                when: departmentIs("Support"),
                then: [activationTask("nc-task-support", "dep-support")],
                else: [
                  {
                    id: "nc-admin",
                    kind: "condition",
                    when: departmentIs("Administration"),
                    then: [activationTask("nc-task-admin", "dep-administration")],
                    else: [activationTask("nc-task-sales", "dep-sales")],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "nc-welcome",
        kind: "sendEmail",
        to: "{{cliente.email}}",
        subject: welcomeSubject,
        body: "Gentile {{cliente.nome}},\n\ngrazie per averci scelto. Nei prossimi giorni il nostro team vi contatterà per l'attivazione di {{analisi.prodotto}}.\n\nA presto,\nil team Audin",
        attachRefs: [],
        approval: ASK_OWNER,
      },
    ],
  };
}

// --- «Richiesta dati al cliente» ----------------------------------------------

/**
 * La risposta del cliente è arrivata: ogni attesa riscrive `risposta.testo`,
 * vuoto se scade (R-J2), quindi vale solo per l'ultima attesa.
 */
const REPLIED: Condition = { left: { ref: "risposta.testo" }, op: "not_empty" };

function activate(id: string): Step {
  return {
    id,
    kind: "createTask",
    title: "Attivare {{richiesta.funzione}} per {{cliente.nome}}",
    description: "Il cliente ha mandato tutto: {{risposta.testo}}",
    assignee: { departmentId: "dep-development" },
    dueInDays: 5,
    project: OWN,
    milestoneRef: null,
    approval: AUTO,
  };
}

function verify(id: string, branches: Record<string, Step[]>): Step {
  return {
    id,
    kind: "claude",
    instruction:
      "Confronta la risposta del cliente con i dati richiesti. Rispondi «tutto presente» se c'è tutto, altrimenti «mancano informazioni» e scrivi cosa manca.",
    inputs: ["richiesta.dati", "risposta.testo"],
    outcomes: ["tutto presente", "mancano informazioni"],
    fields: [{ key: "verifica.mancanti", label: "Cosa manca", type: "text" }],
    branches,
  };
}

const clientDataFlow: AutomationFlow = {
  trigger: { kind: "source", sourceId: SOURCE_WEBHOOK, event: "webhook" },
  titleTemplate: "Dati per {{richiesta.funzione}} – {{cliente.nome}}",
  steps: [
    {
      id: "cd-ask",
      kind: "sendEmail",
      to: "{{cliente.email}}",
      subject: "Ci servono alcuni dati per attivare {{richiesta.funzione}}",
      body: "Gentile {{cliente.nome}},\n\nper attivare {{richiesta.funzione}} ci servono: {{richiesta.dati}}\n\nPuò rispondere direttamente a questa email.\n\nGrazie,\nil team Audin",
      attachRefs: [],
      approval: AUTO,
    },
    { id: "cd-wait", kind: "wait", for: { replyTo: "cd-ask", maxDays: 5 } },
    {
      id: "cd-reminders",
      kind: "repeatUntil",
      until: REPLIED,
      max: 2,
      steps: [
        {
          id: "cd-remind",
          kind: "sendEmail",
          to: "{{cliente.email}}",
          subject: "Promemoria: dati per attivare {{richiesta.funzione}}",
          body: "Gentile {{cliente.nome}},\n\nle ricordiamo che per attivare {{richiesta.funzione}} ci servono: {{richiesta.dati}}\n\nGrazie,\nil team Audin",
          attachRefs: [],
          approval: AUTO,
        },
        { id: "cd-remind-wait", kind: "wait", for: { replyTo: "cd-remind", maxDays: 5 } },
      ],
      onLimit: [
        {
          id: "cd-call",
          kind: "createTask",
          title: "Chiamare {{cliente.nome}}: nessuna risposta alla richiesta dati",
          description:
            "Dopo la richiesta e due promemoria il cliente non ha risposto. Dati richiesti: {{richiesta.dati}}",
          assignee: { projectRole: "project_lead" },
          dueInDays: 2,
          project: OWN,
          milestoneRef: null,
          approval: AUTO,
        },
      ],
    },
    {
      id: "cd-replied",
      kind: "condition",
      when: REPLIED,
      then: [
        verify("cd-verify", {
          "tutto presente": [activate("cd-activate")],
          "mancano informazioni": [
            {
              id: "cd-missing",
              kind: "sendEmail",
              to: "{{cliente.email}}",
              subject: "Mancano ancora alcuni dati per {{richiesta.funzione}}",
              body: "Gentile {{cliente.nome}},\n\ngrazie della risposta. Per completare l'attivazione ci mancano: {{verifica.mancanti}}\n\nGrazie,\nil team Audin",
              attachRefs: [],
              approval: ASK_OWNER,
            },
            { id: "cd-missing-wait", kind: "wait", for: { replyTo: "cd-missing", maxDays: 5 } },
            verify("cd-reverify", {
              "tutto presente": [activate("cd-activate-2")],
              "mancano informazioni": [
                {
                  id: "cd-followup",
                  kind: "createTask",
                  title: "Completare i dati di {{cliente.nome}} con una telefonata",
                  description: "Mancano ancora: {{verifica.mancanti}}",
                  assignee: { projectRole: "project_lead" },
                  dueInDays: 2,
                  project: OWN,
                  milestoneRef: null,
                  approval: AUTO,
                },
              ],
            }),
          ],
        }),
      ],
      else: [],
    },
  ],
};

// --- la bozza e quella in pausa -----------------------------------------------

const triageFlow: AutomationFlow = {
  trigger: { kind: "stubwise", event: "request_created" },
  titleTemplate: "Smistamento – {{richiesta.titolo}}",
  steps: [
    {
      id: "tr-classify",
      kind: "claude",
      instruction:
        "Leggi la richiesta e di' se è un bug o una funzionalità nuova, con una riga di motivazione.",
      inputs: ["richiesta.titolo", "richiesta.descrizione"],
      outcomes: ["bug", "funzionalità"],
      fields: [],
      branches: {
        bug: [
          {
            id: "tr-bug",
            kind: "createTask",
            title: "Verificare: {{richiesta.titolo}}",
            description: "{{richiesta.descrizione}}",
            assignee: { departmentId: "dep-development" },
            dueInDays: 3,
            project: OWN,
            milestoneRef: null,
            approval: { mode: "ask", who: { projectRole: "project_lead" } },
          },
        ],
      },
    },
  ],
};

const weeklyFlow: AutomationFlow = {
  trigger: { kind: "schedule", rule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9" },
  titleTemplate: "Report settimanale delle campagne",
  steps: [
    {
      id: "wk-report",
      kind: "createTask",
      title: "Report settimanale delle campagne",
      description: "Risultati della settimana scorsa: aperture, clic e contatti per campagna.",
      assignee: { projectRole: "project_lead" },
      dueInDays: 1,
      project: OWN,
      milestoneRef: null,
      approval: AUTO,
    },
  ],
};

export const AUTOMATIONS: Automation[] = [
  {
    id: AUTOMATION_NEW_CONTRACT,
    code: "AUT-1",
    name: "Nuovo contratto",
    description:
      "Quando su Audin si chiude una trattativa, Claude legge il contratto e crea il traguardo di attivazione con le task per ogni reparto; l'email di benvenuto parte dopo l'approvazione.",
    projectId: null,
    // Una generale vuole automations.manage d'istanza: Matteo lo ha per concessione personale
    // del seme (R-J10), e la sua casella è collegata.
    ownerId: "p-matteo",
    status: "active",
    versions: [
      {
        n: 1,
        flow: newContractFlow("Benvenuti in Audin, {{cliente.nome}}"),
        publishedAt: at(-40, "10:00"),
        publishedById: "p-matteo",
      },
      // Modificata dopo l'accensione: la bozza della versione successiva.
      {
        n: 2,
        flow: newContractFlow("Benvenuti, {{cliente.nome}}: i prossimi passi con Audin"),
        publishedAt: null,
        publishedById: null,
      },
    ],
    createdAt: at(-41, "15:30"),
  },
  {
    id: AUTOMATION_CLIENT_DATA,
    code: "AUD-A1",
    name: "Richiesta dati al cliente",
    description:
      "Scrive al cliente i dati che servono per attivare una funzione, gli ricorda fino a due volte, e quando risponde Claude controlla che ci sia tutto.",
    projectId: "prj-aud",
    ownerId: "p-matteo",
    status: "active",
    versions: [
      {
        n: 1,
        flow: clientDataFlow,
        publishedAt: at(-20, "09:15"),
        publishedById: "p-matteo",
      },
    ],
    createdAt: at(-21, "17:40"),
  },
  {
    id: AUTOMATION_DRAFT,
    code: "STW-A1",
    name: "Smistamento delle richieste",
    description:
      "Claude dice se una richiesta nuova è un bug; per i bug propone una task da verificare.",
    projectId: "prj-stw",
    ownerId: null,
    status: "draft",
    versions: [{ n: 1, flow: triageFlow, publishedAt: null, publishedById: null }],
    createdAt: at(-2, "11:05"),
  },
  {
    id: AUTOMATION_PAUSED,
    code: "BTG-A1",
    name: "Report settimanale delle campagne",
    description: "Ogni lunedì alle 9 crea la task del report settimanale per il Project Lead.",
    // L'ha accesa Matteo quando era Project Lead di BTG; poi è uscito dal
    // progetto: l'esecuzione di lunedì è fallita per permesso perso e il
    // team l'ha messa in pausa. Il proprietario resta lui finché qualcuno
    // non la riaccende.
    projectId: "prj-btg",
    ownerId: "p-matteo",
    status: "paused",
    versions: [
      { n: 1, flow: weeklyFlow, publishedAt: at(-30, "08:30"), publishedById: "p-matteo" },
    ],
    createdAt: at(-30, "08:20"),
  },
];
