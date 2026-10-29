import { utterance } from "../../domain/claude/answers";
import { truncateOutput } from "../../domain/servers/commands";
import { ANALYSIS_MAX_MINUTES } from "../../domain/servers/limits";
import i18n from "../../i18n";
import { state } from "../store";
import type {
  EpisodeReason,
  MonitoredServer,
  ScriptStep,
  ServerEpisode,
  ServerService,
} from "../types";

// Lo script dell'analisi automatica (area 8b, solo prototipo): che cosa
// Claude legge sul server per ogni motivo dell'episodio e che diagnosi ne
// esce. Deterministico: stesso server e stesso episodio, stessi passi.
//
// Ogni passo è un'azione `tool: "server.read"` con il comando in `input`:
// solo comandi di lettura (`isReadCommand`), `journalctl` e `systemctl
// status` SENZA `sudo` (R-L5), con `sudo` solo le tre letture docker. Il
// risultato è l'uscita intera; `truncated` dice che ha più di
// `COMMAND_OUTPUT_MAX_LINES` righe (la UI ne mostra le ultime, con «vedi
// tutto», come le altre azioni).
//
// Le etichette sono frasi (`labelText`, chiavi `claude.serverAnalysis.*`):
// chi guarda le legge nella sua lingua. Messaggi, titolo e testo della task
// restano in inglese come i dati del seme.

/** Una lettura: il comando, la sua etichetta, l'uscita finta. */
export interface ServerRead {
  /** La chiave dell'etichetta (`claude.serverAnalysis.reads.<id>`). */
  id: string;
  input: string;
  params?: Record<string, string>;
  output: string;
}

export interface AnalysisDiagnosis {
  title: string;
  body: string;
  proposal: string;
}

const pct = (v: number) => `${Math.round(v)}%`;
const mb = (bytes: number | null) => (bytes === null ? "?" : `${Math.round(bytes / 1024 ** 2)}MiB`);

const docker = (s: MonitoredServer) => s.services.filter((x) => x.source === "docker");

/** Il servizio che pesa di più per una misura (il primo, a pari merito). */
function heaviest(s: MonitoredServer, by: "cpu" | "mem"): ServerService | null {
  const value = (x: ServerService) => (by === "cpu" ? (x.cpuPct ?? 0) : (x.memBytes ?? 0));
  return s.services.reduce<ServerService | null>(
    (best, x) => (best === null || value(x) > value(best) ? x : best),
    null,
  );
}

const checkOf = (id: string) => state.serverChecks.find((c) => c.id === id);

/** Il servizio legato a un controllo: quello nominato dal bersaglio, o il primo. */
function serviceOfCheck(s: MonitoredServer, checkId: string): ServerService | null {
  const check = checkOf(checkId);
  const named = check ? s.services.find((x) => check.target.includes(x.name)) : undefined;
  return named ?? s.services[0] ?? null;
}

// --- le letture -------------------------------------------------------------

const uptime = (load: string): ServerRead => ({
  id: "uptime",
  input: "uptime",
  output: ` 12:00:04 up 41 days,  3:12,  0 users,  load average: ${load}`,
});

function containerStats(s: MonitoredServer): ServerRead {
  const rows = docker(s).map(
    (x) => `${x.name.padEnd(16)} ${`${(x.cpuPct ?? 0).toFixed(1)}%`.padEnd(9)} ${mb(x.memBytes)}`,
  );
  return {
    id: "containers",
    input: "sudo docker stats --no-stream",
    output: ["NAME             CPU %     MEM USAGE", ...rows].join("\n"),
  };
}

function processes(s: MonitoredServer, by: "cpu" | "mem"): ServerRead {
  const top = heaviest(s, by);
  return {
    id: by === "cpu" ? "processesCpu" : "processesMem",
    input: by === "cpu" ? "ps aux --sort=-%cpu" : "ps aux --sort=-%mem",
    output: [
      "USER   PID  %CPU %MEM COMMAND",
      `app   2214  ${(top?.cpuPct ?? 0).toFixed(1)}  ${by === "mem" ? "71.4" : "12.0"} ${top?.name ?? "node"}`,
    ].join("\n"),
  };
}

function logs(service: ServerService): ServerRead {
  return {
    id: "logs",
    input: `sudo docker logs --tail 200 ${service.name}`,
    params: { service: service.name },
    output: [
      `11:41:02 ${service.name}: batch started`,
      `11:52:40 ${service.name}: still working, 812,000 items kept in memory`,
      `11:59:58 ${service.name}: still working, 1,240,000 items kept in memory`,
    ].join("\n"),
  };
}

function readsOf(s: MonitoredServer, reason: EpisodeReason): ServerRead[] {
  const hasDocker = docker(s).length > 0;
  const withDocker = (...reads: (ServerRead | false)[]) =>
    reads.filter((r): r is ServerRead => r !== false);
  switch (reason.kind) {
    case "memory": {
      const top = heaviest(s, "mem");
      return withDocker(
        uptime("2.84, 2.41, 1.97"),
        {
          id: "memory",
          input: "free -m",
          output: [
            "               total        used        free",
            `Mem:            7940        ${Math.round(79.4 * reason.valuePct)}         112`,
            "Swap:           2047        1630         417",
          ].join("\n"),
        },
        hasDocker && containerStats(s),
        processes(s, "mem"),
        hasDocker && top?.source === "docker" && logs(top),
      );
    }
    case "cpu": {
      const top = heaviest(s, "cpu");
      return withDocker(
        uptime("7.92, 7.40, 6.11"),
        hasDocker && containerStats(s),
        processes(s, "cpu"),
        hasDocker && top?.source === "docker" && logs(top),
      );
    }
    case "disk":
      return withDocker(
        {
          id: "disk",
          input: "df -h",
          output: [
            "Filesystem      Size  Used Avail Use% Mounted on",
            `/dev/sda1       200G  ${Math.round(2 * reason.valuePct)}G   ${200 - Math.round(2 * reason.valuePct)}G  ${pct(reason.valuePct)} /`,
          ].join("\n"),
        },
        hasDocker && {
          id: "containerSizes",
          input: "sudo docker ps -a --size",
          output: docker(s)
            .map((x) => `${x.name}   Up 41 days   ${x.name === "postgres" ? "142GB" : "1.2GB"}`)
            .join("\n"),
        },
        {
          id: "journal",
          input: "journalctl -u docker --since -30min --no-pager",
          output: "-- No entries --",
        },
      );
    case "check": {
      const service = serviceOfCheck(s, reason.checkId);
      const check = checkOf(reason.checkId);
      return withDocker(
        hasDocker && {
          id: "containerList",
          input: "sudo docker ps -a",
          output: docker(s)
            .map((x) => `${x.name}   ${x.state === "running" ? "Up 41 days" : "Exited (1)"}`)
            .join("\n"),
        },
        {
          id: "ports",
          input: "ss -tlnp",
          output: [
            "State  Local Address:Port  Process",
            "LISTEN 0.0.0.0:22         sshd",
            `LISTEN 127.0.0.1:5432     ${check?.type === "postgres" ? "postgres" : "docker-proxy"}`,
          ].join("\n"),
        },
        hasDocker && service?.source === "docker" && logs(service),
      );
    }
    case "agent_silent":
      return [
        uptime("0.42, 0.61, 0.58"),
        {
          id: "agent",
          input: "systemctl status --no-pager stubwise-agent",
          output: [
            "● stubwise-agent.service - Stubwise monitoring agent",
            "     Active: active (running) since today 11:58:41 UTC",
          ].join("\n"),
        },
        {
          id: "bootJournal",
          input: "journalctl --boot=-1 -n 50 --no-pager",
          output: "-- Boot ended: reboot requested by unattended-upgrades --",
        },
      ];
  }
}

/** Le letture per i motivi dati, ognuna una volta sola (lo stesso comando non si ripete). */
export function readsFor(s: MonitoredServer, reasons: EpisodeReason[]): ServerRead[] {
  const out: ServerRead[] = [];
  for (const reason of reasons) {
    for (const r of readsOf(s, reason)) if (!out.some((x) => x.input === r.input)) out.push(r);
  }
  return out;
}

/** Le azioni di sola lettura di una serie di letture. */
export function readSteps(reads: ServerRead[]): ScriptStep[] {
  return reads.map((r) => {
    const key = `claude.serverAnalysis.reads.${r.id}`;
    return {
      step: "action",
      tool: "server.read",
      label: i18n.t(key, r.params),
      labelText: utterance(key, r.params),
      input: r.input,
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

function diagnosisOfReason(s: MonitoredServer, reason: EpisodeReason): AnalysisDiagnosis {
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
      return {
        title: `${s.name} stopped reporting`,
        body: `The agent on ${where} stopped reporting. The system journal shows a reboot requested by the automatic updates; the agent started again with the server.`,
        proposal:
          "Nothing to fix if it doesn't happen again; schedule the automatic reboots outside working hours.",
      };
  }
}

/** La diagnosi di un episodio: un paragrafo e una proposta per motivo, nell'ordine. */
export function diagnosisOf(s: MonitoredServer, episode: ServerEpisode): AnalysisDiagnosis {
  const parts = episode.reasons.map((r) => diagnosisOfReason(s, r));
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

/** L'apertura della sessione: la fase d'analisi e che cosa Claude va a guardare. */
export function openingSteps(s: MonitoredServer, episode: ServerEpisode): ScriptStep[] {
  return [
    { step: "event", event: { type: "phase", phase: "analysis", outcome: null } },
    { step: "state", state: "working" },
    {
      step: "say",
      text: `${s.name}: ${reasonsPhrase(episode.reasons)}. Looking into it with the read-only access (at most ${ANALYSIS_MAX_MINUTES} minutes).`,
    },
  ];
}

/**
 * Lo script intero di un episodio: apertura, le letture di tutti i motivi,
 * e la diagnosi che ne esce. L'analisi lo esegue a pezzi
 * (`data/servers/analysis.ts`), perché un secondo allarme durante aggiunge
 * letture e motivi.
 */
export function analysisScript(
  server: MonitoredServer,
  episode: ServerEpisode,
): { steps: ScriptStep[]; diagnosis: AnalysisDiagnosis } {
  return {
    steps: [...openingSteps(server, episode), ...readSteps(readsFor(server, episode.reasons))],
    diagnosis: diagnosisOf(server, episode),
  };
}
