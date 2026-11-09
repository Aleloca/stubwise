import { utterance } from "../../domain/claude/answers";
import { truncateOutput } from "../../domain/servers/commands";
import i18n from "../../i18n";
import type { EpisodeReason, MonitoredServer, ScriptStep, ServerService } from "../types";
import {
  docker,
  heaviest,
  pct,
  readsFor,
  readSteps,
  serviceOfCheck,
  uptime,
  type ServerRead,
} from "./scripts";

// Gli script della correzione di un server (area 8b, solo prototipo).
// Claude rilegge il server con l'accesso di LETTURA (le letture dell'analisi),
// scrive il piano coi comandi previsti e si ferma; solo dopo l'approvazione
// di una persona esegue i comandi con l'accesso di CORREZIONE (`tool:
// "server.fix"`), poi controlla in sola lettura. Mai un rilascio
// (anti-obiettivo 1): nessun pull, aggiornamento d'immagine o deploy.

/** Un comando della correzione: l'etichetta, il comando, il perché (nel piano), l'uscita finta. */
export interface FixCommand {
  /** La chiave dell'etichetta (`claude.serverFix.commands.<id>`). */
  id: string;
  input: string;
  params?: Record<string, string>;
  why: string;
  output: string;
}

const restartOf = (x: ServerService): FixCommand => ({
  id: "restart",
  input: x.source === "docker" ? `sudo docker restart ${x.name}` : `sudo pm2 restart ${x.name}`,
  params: { service: x.name },
  why: `Restarts \`${x.name}\`, so it starts again from a clean state.`,
  output: x.source === "docker" ? x.name : `[PM2] [${x.name}] ✓ restarted`,
});

/**
 * Il servizio su cui agire: quello che la diagnosi della task nomina (fra
 * backtick, come la scrive l'analisi), se è del server; altrimenti il più
 * pesante. Il piano corregge ciò che la persona ha letto nella diagnosi.
 */
function targetOf(s: MonitoredServer, by: "cpu" | "mem", diagnosis: string): ServerService | null {
  return s.services.find((x) => diagnosis.includes(`\`${x.name}\``)) ?? heaviest(s, by);
}

function commandsOf(s: MonitoredServer, reason: EpisodeReason, diagnosis: string): FixCommand[] {
  switch (reason.kind) {
    case "memory": {
      const top = targetOf(s, "mem", diagnosis);
      if (!top) return [];
      const limit: FixCommand = {
        id: "limitMemory",
        input: `sudo docker update --memory 2g --memory-swap 2g ${top.name}`,
        params: { service: top.name },
        why: `Caps \`${top.name}\` at 2 GB, so it can't starve the rest of the server.`,
        output: top.name,
      };
      return top.source === "docker" ? [limit, restartOf(top)] : [restartOf(top)];
    }
    case "cpu": {
      const top = targetOf(s, "cpu", diagnosis);
      return top ? [restartOf(top)] : [];
    }
    case "disk":
      return [
        ...(docker(s).length > 0
          ? [
              {
                id: "pruneImages",
                input: "sudo docker image prune -af",
                why: "Removes the images no container uses: nothing running is touched.",
                output: "Total reclaimed space: 38.2GB",
              },
            ]
          : []),
        {
          id: "vacuumJournal",
          input: "sudo journalctl --vacuum-size=500M",
          why: "Keeps the last 500 MB of the system journal.",
          output: "Vacuuming done, freed 3.1G of archived journals from /var/log/journal.",
        },
      ];
    case "check": {
      const service = serviceOfCheck(s, reason.checkId);
      return service ? [restartOf(service)] : [];
    }
    case "agent_silent":
      return [
        {
          id: "restartAgent",
          input: "sudo systemctl restart stubwise-agent",
          why: "Restarts the monitoring agent.",
          output: "",
        },
      ];
  }
}

export interface FixPlan {
  /** Le letture prima del piano, in sola lettura. */
  reads: ServerRead[];
  commands: FixCommand[];
  planText: string;
  summary: string;
}

/**
 * Il piano della correzione: le letture di adesso, i comandi previsti (uno
 * per riga, col perché), le note di chi ha avviato la correzione e le
 * indicazioni di chi ha rifiutato il piano di prima, se ci sono. `diagnosis`: il testo della task (il servizio che nomina).
 */
export function fixPlan(
  s: MonitoredServer,
  reasons: EpisodeReason[],
  diagnosis: string,
  instructions?: string,
  notes?: string,
): FixPlan {
  const commands: FixCommand[] = [];
  for (const reason of reasons)
    for (const c of commandsOf(s, reason, diagnosis))
      if (!commands.some((x) => x.input === c.input)) commands.push(c);
  const lines = [
    `## Fix plan for ${s.code} ${s.name}`,
    "",
    `Runs as stubwise-fix, which can do anything on ${s.code}: nothing runs until a person who can approve plans approves this plan.`,
    "",
    "### Commands",
    "",
    ...(commands.length > 0
      ? commands.flatMap((c, i) => [`${i + 1}. \`${c.input}\``, `   ${c.why}`])
      : ["No command: what the server shows doesn't call for a change."]),
    "",
    "### Check",
    "",
    "Afterwards Claude reads the server again with the read-only access and says whether the problem is gone.",
    ...(notes ? ["", "### Notes from the person who started the fix", "", notes] : []),
    ...(instructions ? ["", "### Instructions from the review", "", instructions] : []),
  ];
  const n = commands.length;
  return {
    reads: readsFor(s, reasons),
    commands,
    planText: lines.join("\n"),
    summary:
      n > 0
        ? `Run ${n} command${n === 1 ? "" : "s"} on ${s.code} as stubwise-fix, then check.`
        : `No command on ${s.code}: only the check.`,
  };
}

/**
 * Le azioni della correzione, una per comando (`tool: "server.fix"`), con
 * l'uscita intera e `truncated` oltre `COMMAND_OUTPUT_MAX_LINES` righe. Chi
 * le esegue le passa UNA alla volta, ricontrollando prima l'accesso.
 */
export function fixExecution(commands: FixCommand[]): ScriptStep[] {
  return commands.map((c) => {
    const key = `claude.serverFix.commands.${c.id}`;
    return {
      step: "action",
      tool: "server.fix",
      access: "fix" as const,
      label: i18n.t(key, c.params),
      labelText: utterance(key, c.params),
      input: c.input,
      result: c.output,
      ...(truncateOutput(c.output).truncated ? { truncated: true } : {}),
    };
  });
}

/** La lettura del controllo per un motivo, e che cosa ne dice. */
function checkRead(reason: EpisodeReason, ok: boolean): { read: ServerRead; phrase: string } {
  switch (reason.kind) {
    case "memory":
      return {
        read: {
          id: "memory",
          input: "free -m",
          output: `               total        used        free\nMem:            7940        ${ok ? 3260 : Math.round(79.4 * reason.valuePct)}        ${ok ? 4100 : 140}`,
        },
        phrase: ok ? "memory at 41%" : `memory still at ${pct(reason.valuePct)}`,
      };
    case "cpu":
      return {
        read: uptime(ok ? "0.84, 2.10, 4.02" : "7.88, 7.61, 7.02"),
        phrase: ok ? "CPU back to normal" : `CPU still at ${pct(reason.valuePct)}`,
      };
    case "disk":
      return {
        read: {
          id: "disk",
          input: "df -h",
          output: `Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       200G  ${ok ? "122G   78G  61%" : `${Math.round(2 * reason.valuePct)}G   ${200 - Math.round(2 * reason.valuePct)}G  ${pct(reason.valuePct)}`} /`,
        },
        phrase: ok ? "disk at 61%" : `disk still at ${pct(reason.valuePct)}`,
      };
    case "check":
      return {
        read: {
          id: "ports",
          input: "ss -tlnp",
          output: `State  Local Address:Port  Process\nLISTEN 0.0.0.0:22         sshd${ok ? "\nLISTEN 127.0.0.1:5432     docker-proxy" : ""}`,
        },
        phrase: ok ? "the check answers again" : "the check still doesn't answer",
      };
    case "agent_silent":
      return {
        read: {
          id: "agent",
          input: "systemctl status --no-pager stubwise-agent",
          output: `● stubwise-agent.service - Stubwise monitoring agent\n     Active: ${ok ? "active (running)" : "failed (Result: exit-code)"}`,
        },
        phrase: ok ? "the agent reports again" : "the agent still doesn't report",
      };
  }
}

/**
 * Il controllo finale, in sola lettura: le letture dei motivi e la riga
 * `server_check` con `resolved` esplicito (R-L3): è lei, non l'esito della
 * sessione, a dire risolto o no.
 */
export function fixCheck(reasons: EpisodeReason[], resolved: boolean): ScriptStep[] {
  const parts = reasons.map((r) => checkRead(r, resolved));
  const reads: ServerRead[] = [];
  for (const p of parts) if (!reads.some((x) => x.input === p.read.input)) reads.push(p.read);
  const what = parts.map((p) => p.phrase).join(", ");
  return [
    ...readSteps(reads),
    {
      step: "event",
      event: {
        type: "work_result",
        kind: "server_check",
        text: `Check after the fix: ${resolved ? "resolved" : "not resolved"}${what ? ` — ${what}` : ""}`,
        resolved,
        ...(what ? { detail: what } : {}),
      },
    },
  ];
}
