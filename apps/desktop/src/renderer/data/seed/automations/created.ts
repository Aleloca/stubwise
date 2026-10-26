// Cosa ha creato l'esecuzione finita di «Nuovo contratto» (AUT-1 #1) in CBV:
// il traguardo di attivazione e le quattro task, una per reparto, senza
// incaricato (le prende il reparto). Entrano in `MILESTONES` e `TASKS`: il
// registro dell'esecuzione cita questi codici.
import type { Milestone, Task } from "../../types";
import { daysFromToday } from "../dates";
import { PROJECTS } from "../projects";
import { statusIdOf } from "../statuses";

const CBV = PROJECTS.find((p) => p.code === "CBV")!;
/** Creato il giorno dell'esecuzione, 12 giorni fa. */
const CREATED_AT = `${daysFromToday(-12)}T16:07:00Z`;

export const NEW_CONTRACT_MILESTONE_ID = "ms-cbv-aut1";

export const AUTOMATION_MILESTONES: Milestone[] = [
  {
    id: NEW_CONTRACT_MILESTONE_ID,
    projectId: CBV.id,
    name: "Attivazione CRM – Cantina Bellavista Srl",
    description: "",
    // `dueInDays: 30` dal giorno dell'esecuzione.
    dueDate: daysFromToday(18),
    closed: false,
  },
];

/** [titolo, reparto]: le task che Claude ha ricavato dal contratto, nell'ordine del registro. */
export const NEW_CONTRACT_TASKS: [title: string, departmentId: string][] = [
  ["Importare l'anagrafica clienti nel CRM", "dep-development"],
  ["Configurare il Centralino AI sui due numeri della cantina", "dep-support"],
  ["Fatturare il primo canone all'attivazione", "dep-administration"],
  ["Pianificare le due sessioni di formazione sul CRM", "dep-sales"],
];

/** Dopo le 5 task generate di CBV. */
const FIRST_N = 6;

export const AUTOMATION_TASKS: Task[] = NEW_CONTRACT_TASKS.map(([title, departmentId], i) => ({
  id: `t-cbv-${FIRST_N + i}`,
  code: `CBV-${FIRST_N + i}`,
  projectId: CBV.id,
  title,
  description:
    "Dal contratto «CRM + Centralino AI – Cantina Bellavista Srl» con Cantina Bellavista Srl.",
  statusId: statusIdOf(CBV, "todo"),
  departmentId,
  assigneeId: null,
  // L'automazione agisce a nome del suo proprietario.
  createdById: "p-roberta",
  followerIds: [],
  size: null,
  // `dueInDays: 14` dal giorno dell'esecuzione.
  dueDate: daysFromToday(2),
  plannedWeek: null,
  slipCount: 0,
  milestoneId: NEW_CONTRACT_MILESTONE_ID,
  labels: [],
  type: departmentId === "dep-development" ? "feature" : "activity",
  priority: "medium",
  requestId: null,
  links: [],
  attachments: [],
  manualStall: null,
  claude: "none",
  createdAt: CREATED_AT,
  closedAt: null,
  lastActivityAt: CREATED_AT,
  source: "manual",
  occurrences: 1,
}));
