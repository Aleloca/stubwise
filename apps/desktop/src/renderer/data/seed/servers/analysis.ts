import { commandInput } from "../../../domain/servers/commands";
import type { ServerAnalysis, ServerCommandMeta, Task } from "../../types";
import { at, done, says, seeded, type Seeded } from "../conversations/helpers";
import { PROJECTS } from "../projects";
import { statusIdOf } from "../statuses";
import { SRV1_MEMORY_EPISODE, SRV2_DISK_EPISODE } from "./episodes";

// L'analisi dell'allarme di memoria di SRV-1: Claude guarda il server con
// l'accesso di LETTURA e, con le operazioni dell'agente accese, legge il log
// del container via agente (solo letture degli insiemi chiusi, F4b,
// `tool: "server.read"`),
// scrive la diagnosi, la attribuisce ad ACQ (l'unico progetto del server) e
// apre lì la task. Nessuno l'ha chiesta: la sessione è di Claude, entrata in
// ACQ con l'attribuzione, e si legge come le altre sessioni automatiche.
//
// Il codice della task è il prossimo libero di ACQ (5 task generate, quindi
// ACQ-6): `seed.test.ts` lo verifica.

export const SERVER_TASK_CODE = "ACQ-6";

const ACQ = PROJECTS.find((p) => p.code === "ACQ")!;
const ANALYSIS_ID = SRV1_MEMORY_EPISODE.analysisId!;
const TASK_ID = "t-acq-srv-1";
const CONVERSATION_ID = "cv-srv-1-analysis";
const STARTED = at(2, "18:01");
const ENDED = at(2, "18:09");
const TASK_LINK = `#/p/ACQ/tasks?task=${SERVER_TASK_CODE}`;
const PROPOSAL =
  "Restart the `portale-import` container so the memory comes back now; then commit the readings in batches of 5,000 rows instead of all at the end, so an import can't starve the portal again.";

// L'allarme di SRV-2 di stamattina: db-stw-01 non ha l'accesso SSH, e
// l'analisi parte lo stesso, solo senza le letture SSH (decisione del
// maintainer del 15 nov 2026, riconfermata il 23 nov). È già finita (scelta
// A2 di 46): Claude ha guardato con ciò che riporta l'agente e non ha potuto
// dire quale progetto è la causa (ha nominato un container che l'agente non
// riporta), quindi nessuna task: la diagnosi resta sull'episodio.
const SRV2_ANALYSIS_ID = SRV2_DISK_EPISODE.analysisId!;
const SRV2_CONVERSATION_ID = "cv-srv-2-analysis";
const SRV2_STARTED = at(0, "09:41");
const SRV2_ENDED = at(0, "09:47");
export const SRV2_UNDETERMINED_BODY =
  "Claude looked into db-stw-01 with read-only access, but couldn't tell which project is causing it: it named a container the agent doesn't report on this server. No task was opened.";

export const SERVER_ANALYSES: ServerAnalysis[] = [
  {
    id: ANALYSIS_ID,
    serverCode: "SRV-1",
    episodeId: SRV1_MEMORY_EPISODE.id,
    conversationId: CONVERSATION_ID,
    // Area 8, F4b-4: l'analisi è del server e dice il progetto; SRV-1 lo usa
    // solo ACQ, quindi la regola di shared lo attribuisce ad ACQ (il test del
    // seme lo ricalcola con `attributeServerCause`).
    attribution: { kind: "attributed", projectId: ACQ.id, projectCode: ACQ.code },
    outcome: "diagnosed",
    taskId: TASK_ID,
    startedAt: STARTED,
    endedAt: ENDED,
    // La stessa proposta della task (sotto, «**Proposal** —»).
    proposal: PROPOSAL,
  },
  {
    id: SRV2_ANALYSIS_ID,
    serverCode: "SRV-2",
    episodeId: SRV2_DISK_EPISODE.id,
    conversationId: SRV2_CONVERSATION_ID,
    attribution: { kind: "undetermined", reason: "unknown_container" },
    outcome: "diagnosed",
    taskId: null,
    startedAt: SRV2_STARTED,
    endedAt: SRV2_ENDED,
    proposal: null,
    diagnosis: [
      "**Diagnosis** — Disk on db-stw-01 (SRV-2) reached 93%, above the 90% alert, and the check “Replica port” is down. The agent reports the Postgres data directory growing by about 1.3% a day for a week, and the replica refusing connections on 10.0.4.12:5433.",
      "",
      "Claude looked without SSH reads (there is no read-only SSH access on db-stw-01): only what the agent reports. Nothing was changed on the server.",
    ].join("\n"),
  },
];

/** Una lettura del seme: un comando degli insiemi chiusi (F4b), la riga com'è nel registro. */
const read = (hm: string, label: string, command: ServerCommandMeta, result: string) =>
  done(at(2, hm), "server.read", label, {
    input: commandInput(command),
    result,
    serverCommand: command,
  });
const ssh = (action: string, params: Record<string, unknown> = {}): ServerCommandMeta => ({
  action,
  params,
  kind: "read",
  via: "ssh",
  approvalId: null,
  exitCode: 0,
});

const analysis = seeded(
  {
    id: CONVERSATION_ID,
    kind: "server_analysis",
    title: "SRV-1 acq-prod-01 · memory above 90%",
    serverAnalysis: { serverCode: "SRV-1" },
    ownerId: "p-claude",
    projectId: ACQ.id,
    taskId: TASK_ID,
    state: "finished",
    outcome: "ok",
  },
  [
    { at: STARTED, type: "phase", phase: "analysis", outcome: null },
    says(
      STARTED,
      "Memory on acq-prod-01 is at 94%, above the 90% alert. Looking into it with the read-only access.",
    ),
    read("18:02", "Reads the load", ssh("load"), "2.84 2.41 1.97 3/412 22141"),
    read(
      "18:03",
      "Reads the memory",
      ssh("memory"),
      [
        "MemTotal:        8130560 kB",
        "MemFree:          114688 kB",
        "MemAvailable:     251904 kB",
        "SwapTotal:       2096124 kB",
        "SwapFree:         427008 kB",
      ].join("\n"),
    ),
    read(
      "18:04",
      "Reads the processes",
      ssh("processes", { top: 10 }),
      [
        "  PID USER     %CPU %MEM     ELAPSED COMMAND",
        " 2214 app       1.8 66.0       41:58 node",
        " 1033 999       4.1 20.7 41-03:12:10 postgres",
      ].join("\n"),
    ),
    read(
      "18:05",
      "Reads the log of portale-import",
      {
        action: "container.logs",
        params: { container: "portale-import", lines: 200, sinceMinutes: 60 },
        kind: "read",
        via: "agent",
        approvalId: null,
        exitCode: 0,
      },
      [
        "17:20:02 nightly import started: readings_2026-10-21.csv",
        "17:20:03 parsing 1,412,906 rows",
        "17:41:55 parsed 800,000 rows (kept in memory until commit)",
        "17:59:48 parsed 1,300,000 rows (kept in memory until commit)",
      ].join("\n"),
    ),
    read(
      "18:07",
      "Reads the errors in the system journal",
      ssh("journal_errors", { lines: 50 }),
      "-- No entries --",
    ),
    says(
      ENDED,
      [
        "**Diagnosis**: the nightly import keeps every parsed meter reading in memory until the batch is committed. Today's file has 1.4 million rows, so `portale-import` grew to 5.1 GB and the server started swapping.",
        "",
        "Nothing crashed and the portal still answers, slower. Memory should go back to normal when the import commits.",
        "",
        `I wrote the diagnosis and a proposal in ${SERVER_TASK_CODE}.`,
      ].join("\n"),
    ),
    {
      at: ENDED,
      type: "work_result",
      kind: "server_diagnosis",
      text: `Diagnosis written in ${SERVER_TASK_CODE}`,
      link: TASK_LINK,
    },
    { at: ENDED, type: "phase", phase: "analysis", outcome: "ok" },
  ],
);

const srv2Analysis = seeded(
  {
    id: SRV2_CONVERSATION_ID,
    kind: "server_analysis",
    title: "SRV-2 db-stw-01 · disk above 90%, “Replica port” down",
    serverAnalysis: { serverCode: "SRV-2" },
    ownerId: "p-claude",
    state: "finished",
    outcome: "ok",
  },
  [
    { at: SRV2_STARTED, type: "phase", phase: "analysis", outcome: null },
    says(
      SRV2_STARTED,
      "Disk on db-stw-01 is at 93%, above the 90% alert, and the check “Replica port” is down. There is no read-only SSH access: looking into it with what the agent reports, without SSH reads.",
    ),
    says(
      SRV2_ENDED,
      "I couldn't tell which project is causing it (it named a container the agent doesn't report on this server), so I didn't open a task or propose a fix. The diagnosis stays with the alert on SRV-2.",
    ),
    { at: SRV2_ENDED, type: "phase", phase: "analysis", outcome: "ok" },
  ],
);

export const SERVER_CONVERSATIONS: Seeded[] = [analysis, srv2Analysis];

/**
 * La task della diagnosi: bug, senza incaricato, di Claude, legata al
 * server e all'episodio. Il rientro (due ore dopo) l'ha aggiunto in fondo.
 */
export const SERVER_TASKS: Task[] = [
  {
    id: TASK_ID,
    code: SERVER_TASK_CODE,
    projectId: ACQ.id,
    title: "Memory leak in the nightly import worker",
    description: [
      "**Diagnosis** — Memory on acq-prod-01 (SRV-1) reached 94%, above the 90% alert. The nightly import (`portale-import`) keeps every parsed meter reading in memory until the batch is committed: with 1.4 million rows it grew to 5.1 GB and the server started swapping. The portal kept answering, slower.",
      "",
      `**Proposal** — ${PROPOSAL}`,
      "",
      "Claude looked with the read-only access: nothing was changed on the server.",
      "",
      // Niente ora nel testo: è lo stesso per tutti, il fuso no. L'ora del
      // rientro sta nell'episodio (`recoveredAt`) e la UI la formatta per
      // chi guarda (`data/servers/analysis.ts`, `recoveredLine`).
      "**Back to normal** after 2 h, when the import committed, without any change from Stubwise.",
    ].join("\n"),
    statusId: statusIdOf(ACQ, "todo"),
    departmentId: "dep-development",
    assigneeId: null,
    createdById: "p-claude",
    followerIds: [],
    size: null,
    dueDate: null,
    plannedWeek: null,
    slipCount: 0,
    milestoneId: null,
    labels: [],
    type: "bug",
    priority: "high",
    requestId: null,
    links: [],
    attachments: [],
    manualStall: null,
    claude: "none",
    createdAt: ENDED,
    closedAt: null,
    lastActivityAt: SRV1_MEMORY_EPISODE.recoveredAt!,
    source: "server",
    occurrences: 1,
    serverRef: { serverCode: "SRV-1", episodeId: SRV1_MEMORY_EPISODE.id },
  },
];
