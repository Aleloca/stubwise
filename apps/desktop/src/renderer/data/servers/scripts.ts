import type { AttributionInput } from "@stubwise/shared";
import { utterance } from "../../domain/claude/answers";
import { commandInput, truncateOutput } from "../../domain/servers/commands";
import i18n from "../../i18n";
import { state } from "../store";
import type {
  EpisodeReason,
  MonitoredServer,
  ScriptStep,
  ServerCommandMeta,
  ServerEpisode,
  ServerService,
} from "../types";

// Lo script dell'analisi automatica (area 8b, solo prototipo): che cosa
// Claude legge sul server per ogni motivo dell'episodio e che diagnosi ne
// esce. Deterministico: stesso server e stesso episodio, stessi passi.
//
// Ogni passo è un'azione `tool: "server.read"` con un comando degli insiemi
// CHIUSI di `@stubwise/shared` (area 8, F4b), mai un comando libero:
// - via SSH, con l'utente di sola lettura, le letture di `SSH_READS` (argv
//   fissi, parametri numerici) — niente `sudo`, niente docker;
//   `journal_errors` solo se la verifica ha trovato l'utente nel gruppo del
//   journal (F4b-3 = a);
// - via AGENTE le letture dei container (`container.logs`,
//   `container.state`), solo con le operazioni dell'agente accese (Q2 = a).
// Ciò che manca si DICE (`unavailableOf`), non si salta in silenzio.
// Il risultato è l'uscita intera, contenuto NON fidato; `truncated` dice che
// ha più di `COMMAND_OUTPUT_MAX_LINES` righe (la UI ne mostra le ultime, con
// «vedi tutto»).
//
// Le etichette sono frasi (`labelText`, chiavi `claude.serverAnalysis.*`):
// chi guarda le legge nella sua lingua. Messaggi, titolo e testo della task
// restano in inglese come i dati del seme.

/** Una lettura: il comando dell'insieme chiuso, la sua etichetta, l'uscita finta. */
export interface ServerRead {
  /** La chiave dell'etichetta (`claude.serverAnalysis.reads.<id>`). */
  id: string;
  params?: Record<string, string>;
  command: ServerCommandMeta;
  output: string;
}

/** Che cosa l'analisi può leggere adesso, oltre alle letture SSH di base. */
export interface ReadReach {
  /** Il journal di sistema (`journalReadable`). */
  journal: boolean;
  /** Le letture dell'agente (`agentOperations`). */
  agent: boolean;
}

/** Le letture che servirebbero e che adesso non si possono fare. */
export type UnavailableRead = "journal" | "agent";

export interface AnalysisDiagnosis {
  title: string;
  body: string;
  proposal: string;
}

export const pct = (v: number) => `${Math.round(v)}%`;

export const docker = (s: MonitoredServer) => s.services.filter((x) => x.source === "docker");

/** Il servizio che pesa di più per una misura (il primo, a pari merito). */
export function heaviest(s: MonitoredServer, by: "cpu" | "mem"): ServerService | null {
  const value = (x: ServerService) => (by === "cpu" ? (x.cpuPct ?? 0) : (x.memBytes ?? 0));
  return s.services.reduce<ServerService | null>(
    (best, x) => (best === null || value(x) > value(best) ? x : best),
    null,
  );
}

const checkOf = (id: string) => state.serverChecks.find((c) => c.id === id);

/** Il servizio legato a un controllo: quello nominato dal bersaglio, o il primo. */
export function serviceOfCheck(s: MonitoredServer, checkId: string): ServerService | null {
  const check = checkOf(checkId);
  const named = check ? s.services.find((x) => check.target.includes(x.name)) : undefined;
  return named ?? s.services[0] ?? null;
}

// --- le letture -------------------------------------------------------------

const ssh = (
  id: string,
  read: string,
  output: string,
  params: Record<string, number> = {},
): ServerRead => ({
  id,
  command: { action: read, params, kind: "read", via: "ssh", approvalId: null, exitCode: 0 },
  output,
});

const agentRead = (
  id: string,
  action: "container.logs" | "container.state",
  service: ServerService,
  output: string,
): ServerRead => ({
  id,
  params: { service: service.name },
  command: {
    action,
    params:
      action === "container.logs"
        ? { container: service.name, lines: 200, sinceMinutes: 60 }
        : { container: service.name },
    kind: "read",
    via: "agent",
    approvalId: null,
    exitCode: 0,
  },
  output,
});

export const uptime = (load: string): ServerRead =>
  ssh("uptime", "uptime", ` 12:00:04 up 41 days,  3:12,  0 users,  load average: ${load}`);

const loadavg = (load: string): ServerRead =>
  ssh("load", "load", `${load.replaceAll(",", "")} 3/412 22141`);

function processes(s: MonitoredServer, by: "cpu" | "mem"): ServerRead {
  const top = heaviest(s, by);
  return ssh(
    "processes",
    "processes",
    [
      "  PID USER     %CPU %MEM     ELAPSED COMMAND",
      ` 2214 app      ${(top?.cpuPct ?? 0).toFixed(1).padStart(4)} ${by === "mem" ? "71.4" : "12.0"}  2-03:12:44 ${top?.name ?? "node"}`,
      " 1033 999       4.1 20.7 41-03:12:10 postgres",
    ].join("\n"),
    { top: 10 },
  );
}

const containerLogs = (service: ServerService): ServerRead =>
  agentRead(
    "logs",
    "container.logs",
    service,
    [
      `11:41:02 ${service.name}: batch started`,
      `11:52:40 ${service.name}: still working, 812,000 items kept in memory`,
      `11:59:58 ${service.name}: still working, 1,240,000 items kept in memory`,
    ].join("\n"),
  );

const containerState = (service: ServerService): ServerRead =>
  agentRead(
    "containerState",
    "container.state",
    service,
    JSON.stringify(
      {
        State: { Status: service.state, Running: service.state === "running" },
        RestartCount: service.restarts ?? 0,
        Image: service.image ?? null,
      },
      null,
      2,
    ),
  );

const journalErrors = (output: string): ServerRead =>
  ssh("journal", "journal_errors", output, { lines: 50 });

/** Il servizio docker di un motivo: le letture via agente esistono solo per un container. */
const dockerOf = (x: ServerService | null): ServerService | null =>
  x?.source === "docker" ? x : null;

/** Le letture di un motivo, con quello che si può leggere adesso (`reach`). */
function readsOf(s: MonitoredServer, reason: EpisodeReason, reach: ReadReach): ServerRead[] {
  const keep = (...reads: (ServerRead | null | false)[]) =>
    reads.filter((r): r is ServerRead => !!r);
  switch (reason.kind) {
    case "memory": {
      const top = dockerOf(heaviest(s, "mem"));
      return keep(
        ssh(
          "memory",
          "memory",
          [
            "MemTotal:        8130560 kB",
            `MemFree:          ${Math.round(81305.6 * (100 - reason.valuePct) * 0.4)} kB`,
            `MemAvailable:     ${Math.round(81305.6 * (100 - reason.valuePct))} kB`,
            "SwapTotal:       2096124 kB",
            "SwapFree:         427008 kB",
          ].join("\n"),
        ),
        processes(s, "mem"),
        reach.agent && top && containerLogs(top),
      );
    }
    case "cpu": {
      const top = dockerOf(heaviest(s, "cpu"));
      return keep(
        loadavg("7.92, 7.40, 6.11"),
        uptime("7.92, 7.40, 6.11"),
        processes(s, "cpu"),
        reach.agent && top && containerLogs(top),
      );
    }
    case "disk":
      return keep(
        ssh(
          "disk",
          "disk",
          [
            "Filesystem     1024-blocks      Used Available Capacity Mounted on",
            `/dev/sda1        209715200 ${Math.round(2097152 * reason.valuePct)} ${Math.round(2097152 * (100 - reason.valuePct))}      ${pct(reason.valuePct)} /`,
          ].join("\n"),
        ),
        reach.journal && journalErrors("-- No entries --"),
      );
    case "check": {
      const service = dockerOf(serviceOfCheck(s, reason.checkId));
      const check = checkOf(reason.checkId);
      return keep(
        ssh(
          "ports",
          "listening",
          [
            "State  Recv-Q Send-Q Local Address:Port Peer Address:Port",
            "LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*",
            `LISTEN 0      4096       127.0.0.1:5432      0.0.0.0:*${check?.type === "postgres" ? "" : ""}`,
          ].join("\n"),
        ),
        reach.agent && service && containerState(service),
        reach.agent && service && containerLogs(service),
      );
    }
    case "agent_silent":
      return keep(
        uptime("0.42, 0.61, 0.58"),
        ssh("failedUnits", "failed_units", ""),
        reach.journal &&
          journalErrors(
            [
              "Oct 21 11:57:40 host unattended-upgrade[1830]: Automatic reboot requested by unattended-upgrades",
              "Oct 21 11:57:52 host systemd[1]: stubwise-agent.service: Stopping (reboot)",
            ].join("\n"),
          ),
      );
  }
}

/** Le letture per i motivi dati, ognuna una volta sola (lo stesso comando non si ripete). */
export function readsFor(
  s: MonitoredServer,
  reasons: EpisodeReason[],
  reach: ReadReach,
): ServerRead[] {
  const out: ServerRead[] = [];
  for (const reason of reasons) {
    for (const r of readsOf(s, reason, reach)) {
      const input = commandInput(r.command);
      if (!out.some((x) => commandInput(x.command) === input)) out.push(r);
    }
  }
  return out;
}

/**
 * Le letture che i motivi chiederebbero e che adesso non si possono fare:
 * il journal senza il gruppo (F4b-3), i container con le operazioni
 * dell'agente spente. L'analisi lo dice, una volta.
 */
export function unavailableOf(
  s: MonitoredServer,
  reasons: EpisodeReason[],
  reach: ReadReach,
): UnavailableRead[] {
  const all = readsFor(s, reasons, { journal: true, agent: true });
  const out: UnavailableRead[] = [];
  if (!reach.journal && all.some((r) => r.command.action === "journal_errors")) out.push("journal");
  if (!reach.agent && all.some((r) => r.command.via === "agent")) out.push("agent");
  return out;
}

/** Le frasi di ciò che non si legge (in inglese, come gli altri messaggi dei dati). */
export function unavailableSteps(s: MonitoredServer, missing: UnavailableRead[]): ScriptStep[] {
  return missing.map((m) => ({
    step: "say" as const,
    text:
      m === "journal"
        ? `I can't read the system journal: stubwise-read isn't in the systemd-journal or adm group.`
        : `I can't read the containers' logs: the agent on ${s.code} doesn't have operations on.`,
  }));
}

/** Le azioni di sola lettura di una serie di letture. */
export function readSteps(reads: ServerRead[]): ScriptStep[] {
  return reads.map((r) => {
    const key = `claude.serverAnalysis.reads.${r.id}`;
    return {
      step: "action",
      tool: "server.read",
      serverCommand: r.command,
      label: i18n.t(key, r.params),
      labelText: utterance(key, r.params),
      input: commandInput(r.command),
      result: r.output,
      ...(truncateOutput(r.output).truncated ? { truncated: true } : {}),
    };
  });
}

// --- le parole --------------------------------------------------------------

/** Un motivo, in una frase breve (per gli avvisi e il titolo della sessione). */
export function reasonPhrase(reason: EpisodeReason): string {
  switch (reason.kind) {
    case "cpu":
      return `CPU at ${pct(reason.valuePct)} (alert at ${pct(reason.thresholdPct)})`;
    case "memory":
      return `memory at ${pct(reason.valuePct)} (alert at ${pct(reason.thresholdPct)})`;
    case "disk":
      return `disk at ${pct(reason.valuePct)} (alert at ${pct(reason.thresholdPct)})`;
    case "check":
      return `the check “${checkOf(reason.checkId)?.name ?? reason.checkId}” is down`;
    case "agent_silent":
      return "the agent stopped reporting";
  }
}

export const reasonsPhrase = (reasons: EpisodeReason[]): string =>
  reasons.map(reasonPhrase).join(" and ");

function diagnosisOfReason(
  s: MonitoredServer,
  reason: EpisodeReason,
  reach: ReadReach,
): AnalysisDiagnosis {
  const where = `${s.name} (${s.code})`;
  switch (reason.kind) {
    case "memory": {
      const top = heaviest(s, "mem");
      return {
        title: `Memory at ${pct(reason.valuePct)} on ${s.name}`,
        body: `Memory on ${where} reached ${pct(reason.valuePct)}, above the ${pct(reason.thresholdPct)} alert. The service using the most is \`${top?.name ?? "unknown"}\`, which keeps growing while its batch runs; the server started swapping.`,
        proposal: `Limit the memory of \`${top?.name ?? "the heaviest service"}\` and restart it, then make its batch release memory as it goes.`,
      };
    }
    case "cpu": {
      const top = heaviest(s, "cpu");
      return {
        title: `CPU at ${pct(reason.valuePct)} on ${s.name}`,
        body: `CPU on ${where} stayed at ${pct(reason.valuePct)}, above the ${pct(reason.thresholdPct)} alert, for more than ${s.thresholds.sustainedMinutes} minutes. Most of it is \`${top?.name ?? "unknown"}\`.`,
        proposal: `Restart \`${top?.name ?? "the busiest service"}\` and look at what it was doing in its logs.`,
      };
    }
    case "disk":
      return {
        title: `Disk at ${pct(reason.valuePct)} on ${s.name}`,
        body: `The disk of ${where} is at ${pct(reason.valuePct)}, above the ${pct(reason.thresholdPct)} alert. Most of the space is taken by container data and old images.`,
        proposal:
          "Remove the unused images and rotate the logs; if it keeps filling, grow the disk.",
      };
    case "check": {
      const check = checkOf(reason.checkId);
      const service = serviceOfCheck(s, reason.checkId);
      const name = check?.name ?? reason.checkId;
      return {
        title: `Check “${name}” down on ${s.name}`,
        body: `The check “${name}” on ${where} doesn't answer (${check?.target ?? "unknown target"}: ${check?.lastError ?? "no answer"}). \`${service?.name ?? "The service"}\` is still listed as running.`,
        proposal: `Restart \`${service?.name ?? "the service"}\` and check its logs for the reason it stopped listening.`,
      };
    }
    case "agent_silent":
      // F4b-3: senza il gruppo del journal la causa non si legge, e si dice.
      return reach.journal
        ? {
            title: `${s.name} stopped reporting`,
            body: `The agent on ${where} stopped reporting. The system journal shows a reboot requested by the automatic updates; the agent started again with the server.`,
            proposal:
              "Nothing to fix if it doesn't happen again; schedule the automatic reboots outside working hours.",
          }
        : {
            title: `${s.name} stopped reporting`,
            body: `The agent on ${where} stopped reporting, and the server has been up for a short while. Claude couldn't read the system journal (stubwise-read isn't in the systemd-journal or adm group), so it can't say why it restarted.`,
            proposal:
              "Add stubwise-read to the systemd-journal group (re-run the access command) so the next analysis can read the journal.",
          };
  }
}

/** La diagnosi di un episodio: un paragrafo e una proposta per motivo, nell'ordine. */
export function diagnosisOf(
  s: MonitoredServer,
  episode: ServerEpisode,
  reach: ReadReach,
): AnalysisDiagnosis {
  const parts = episode.reasons.map((r) => diagnosisOfReason(s, r, reach));
  const first = parts[0] ?? {
    title: `${s.name} in trouble`,
    body: `${s.name} (${s.code}) raised an alert.`,
    proposal: "Look at the server's charts.",
  };
  const more = parts.length - 1;
  return {
    title: more > 0 ? `${first.title} (and ${more} more)` : first.title,
    body: parts.length > 1 ? parts.map((p) => p.body).join("\n\n") : first.body,
    proposal: parts.length > 1 ? parts.map((p) => `- ${p.proposal}`).join("\n") : first.proposal,
  };
}

// --- la causa dichiarata (F4b-4) ------------------------------------------

/** Il container docker che un motivo chiama in causa, se c'è. */
function containerOf(s: MonitoredServer, reason: EpisodeReason): string | null {
  const service =
    reason.kind === "memory"
      ? heaviest(s, "mem")
      : reason.kind === "cpu"
        ? heaviest(s, "cpu")
        : reason.kind === "check"
          ? serviceOfCheck(s, reason.checkId)
          : null;
  return service?.source === "docker" ? service.name : null;
}

/**
 * La causa che l'analisi DICHIARA (solo prototipo, deterministica: in
 * produzione è il campo strutturato dello strumento finale): i container
 * docker che i motivi chiamano in causa, e il progetto che Claude nomina —
 * quello a cui il primo di quei container è legato (oggi il NOME
 * dell'ambiente, finché manca il campo «containers», R7), altrimenti il
 * primo progetto del server. È contenuto del modello, NON fidato: lo valida
 * `attributeServerCause` (`analysis.ts`).
 */
export function declaredCauseOf(
  s: MonitoredServer,
  episode: ServerEpisode,
  serverProjects: AttributionInput["serverProjects"],
): AttributionInput["cause"] {
  const containers: string[] = [];
  for (const r of episode.reasons) {
    const c = containerOf(s, r);
    if (c !== null && !containers.includes(c)) containers.push(c);
  }
  const owner = serverProjects.find((p) =>
    p.environments.some((e) =>
      (e.containers.length > 0 ? e.containers : [e.name]).includes(containers[0] ?? ""),
    ),
  );
  return { projectCode: (owner ?? serverProjects[0])?.projectCode ?? null, containers };
}

/**
 * Lo sguardo generale di un'analisi a mano senza allarme (R0-A2): le stesse
 * letture di memoria, CPU e disco, ai valori di adesso (le soglie restano
 * quelle del server). Non sono motivi di un episodio: non si salvano mai.
 */
export function lookReasons(s: MonitoredServer): EpisodeReason[] {
  const root = s.disks[0];
  const diskPct = root && root.totalBytes > 0 ? (root.usedBytes / root.totalBytes) * 100 : 0;
  return [
    { kind: "memory", valuePct: 52, thresholdPct: s.thresholds.memPct ?? 90 },
    { kind: "cpu", valuePct: 18, thresholdPct: s.thresholds.cpuPct ?? 90 },
    { kind: "disk", valuePct: Math.round(diskPct), thresholdPct: s.thresholds.diskPct ?? 90 },
  ];
}

/** La diagnosi di uno sguardo a mano: niente sopra gli avvisi, e chi pesa di più. */
export function lookDiagnosisOf(s: MonitoredServer): AnalysisDiagnosis {
  const mem = heaviest(s, "mem");
  const cpu = heaviest(s, "cpu");
  const who = [
    mem ? `the service using the most memory is \`${mem.name}\`` : null,
    cpu ? `the busiest is \`${cpu.name}\`` : null,
  ].filter(Boolean);
  return {
    title: `${s.name} checked on request`,
    body: `Claude looked at ${s.name} (${s.code}) on request: memory, CPU and disk are under the alerts right now.${who.length > 0 ? ` Of the services, ${who.join(" and ")}.` : ""}`,
    proposal:
      "Nothing to do right now; if something looks off, the server's charts show when it started.",
  };
}

/** L'apertura della sessione: la fase d'analisi e che cosa Claude va a guardare. */
export function openingSteps(
  s: MonitoredServer,
  episode: ServerEpisode,
  maxMinutes: number,
): ScriptStep[] {
  return [
    { step: "event", event: { type: "phase", phase: "analysis", outcome: null } },
    { step: "state", state: "working" },
    {
      step: "say",
      text: `${s.name}: ${reasonsPhrase(episode.reasons)}. Looking into it with the read-only access (at most ${maxMinutes} minutes).`,
    },
  ];
}
