import type { ServerAnalysis, Task } from "../../types";
import { at, done, says, seeded, type Seeded } from "../conversations/helpers";
import { PROJECTS } from "../projects";
import { statusIdOf } from "../statuses";
import { SRV1_MEMORY_EPISODE } from "./episodes";

// L'analisi dell'allarme di memoria di SRV-1 (ACQ): Claude guarda il server
// con l'accesso di LETTURA (solo comandi di lettura, `tool: "server.read"`),
// scrive la diagnosi e apre la task. Nessuno l'ha chiesta: la sessione è di
// Claude, e si legge come le altre sessioni automatiche.
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

export const SERVER_ANALYSES: ServerAnalysis[] = [
  {
    id: ANALYSIS_ID,
    serverCode: "SRV-1",
    episodeId: SRV1_MEMORY_EPISODE.id,
    projectId: ACQ.id,
    conversationId: CONVERSATION_ID,
    outcome: "diagnosed",
    taskId: TASK_ID,
    startedAt: STARTED,
    endedAt: ENDED,
  },
];

const read = (hm: string, label: string, input: string, result: string) =>
  done(at(2, hm), "server.read", label, { input, result });

const analysis = seeded(
  {
    id: CONVERSATION_ID,
    kind: "server_analysis",
    title: "SRV-1 acq-prod-01 · memory above 90%",
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
    read("18:02", "Reads the uptime and load", "uptime", " 18:02:11 up 41 days,  3:12,  0 users,  load average: 2.84, 2.41, 1.97"),
    read(
      "18:03",
      "Reads the memory",
      "free -m",
      [
        "               total        used        free      shared  buff/cache   available",
        "Mem:            7940        7466         112          38         361         246",
        "Swap:           2047        1630         417",
      ].join("\n"),
    ),
    read(
      "18:04",
      "Reads the container usage",
      "sudo docker stats --no-stream",
      [
        "NAME             CPU %     MEM USAGE / LIMIT     MEM %",
        "portale-import   1.9%      5.12GiB / 7.75GiB     66.1%",
        "postgres         4.2%      1.61GiB / 7.75GiB     20.8%",
        "portale-api      6.3%      648MiB / 7.75GiB      8.2%",
        "portale-web      2.8%      212MiB / 7.75GiB      2.7%",
        "caddy            0.3%      38MiB / 7.75GiB       0.5%",
      ].join("\n"),
    ),
    read(
      "18:05",
      "Reads the import worker log",
      "sudo docker logs --tail 200 portale-import",
      [
        "17:20:02 nightly import started: readings_2026-10-21.csv",
        "17:20:03 parsing 1,412,906 rows",
        "17:41:55 parsed 800,000 rows (kept in memory until commit)",
        "17:59:48 parsed 1,300,000 rows (kept in memory until commit)",
      ].join("\n"),
    ),
    read(
      "18:06",
      "Reads the processes by memory",
      "ps aux --sort=-%mem",
      [
        "USER   PID  %CPU %MEM    VSZ   RSS COMMAND",
        "app   2214   1.8 66.0 6012332 5368812 node dist/import.js",
        "pg    1033   4.1 20.7 2213104 1688520 postgres: checkpointer",
      ].join("\n"),
    ),
    read("18:07", "Reads the system journal", "sudo journalctl -u docker --since -30min --no-pager", "-- No entries --"),
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

export const SERVER_CONVERSATIONS: Seeded[] = [analysis];

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
      "**Proposal** — Limit the `portale-import` container to 2 GB of memory and restart it, so an import can't starve the portal; then commit the readings in batches of 5,000 rows instead of all at the end.",
      "",
      "Claude looked with the read-only access: nothing was changed on the server.",
      "",
      `**Back to normal at 20:00**, when the import committed (after 2 h).`,
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
