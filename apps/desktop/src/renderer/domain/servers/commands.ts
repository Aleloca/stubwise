import { serverActionKind, serverActionSchema, SSH_READS, sshReadSchema } from "@stubwise/shared";
import type { ConversationEvent, ServerCommandMeta } from "../../data/model";
import { COMMAND_OUTPUT_MAX_LINES } from "./limits";

// I comandi su un server (area 8, F4b): SOLO quelli degli insiemi chiusi di
// `@stubwise/shared` — le azioni dell'agente (`SERVER_ACTIONS`, via agente)
// e le letture SSH (`SSH_READS`, argv fissi, parametri numerici). Nessun
// comando libero, nessuna grammatica di shell da interpretare: un comando
// fuori dagli schemi non esiste.

/**
 * Se `cmd` sta nel suo insieme chiuso: una lettura SSH dell'elenco coi
 * parametri stretti (sempre `read`), o un'azione dell'agente coi parametri
 * stretti e il tipo che l'insieme le dà.
 */
export function inClosedSet(cmd: ServerCommandMeta): boolean {
  if (cmd.via === "ssh")
    return (
      cmd.kind === "read" &&
      sshReadSchema.safeParse({ read: cmd.action, params: cmd.params }).success
    );
  return (
    serverActionKind(cmd.action) === cmd.kind &&
    serverActionSchema.safeParse({ action: cmd.action, params: cmd.params }).success
  );
}

/**
 * Il comando come si mostra nel registro: per una lettura SSH l'argv FISSO
 * di shared (`df -P`), per un'azione dell'agente il suo nome coi parametri
 * (`container.restart container=api timeoutSeconds=30`) — mai una riga di
 * shell, perché l'agente non ne esegue.
 */
export function commandInput(cmd: ServerCommandMeta): string {
  if (cmd.via === "ssh") {
    const read = SSH_READS.find((r) => r.read === cmd.action);
    if (read) return read.argv(cmd.params as Record<string, number>).join(" ");
  }
  const params = Object.entries(cmd.params).map(([k, v]) => `${k}=${String(v)}`);
  return [cmd.action, ...params].join(" ");
}

/**
 * Una riga del registro dei comandi di un server (i concetti di
 * `serverCommandViewSchema`): l'azione dell'insieme chiuso, se cambia o
 * legge, per quale via, chi l'ha chiesta e quale approvazione la copre.
 * `output` è contenuto NON fidato: si mostra come testo.
 */
export interface ServerCommandRow {
  id: string;
  action: string;
  params: Record<string, unknown>;
  kind: "change" | "read";
  via: "agent" | "ssh";
  /** `cancelled`/`expired` (build app): un comando mai eseguito, non un errore. */
  status: "delivered" | "done" | "failed" | "cancelled" | "expired";
  requestedById: string | null;
  approvalId: string | null;
  issuedAt: string;
  exitCode: number | null;
  output: string | null;
}

/**
 * Il registro dei comandi di una sessione, dal suo flusso: una riga per
 * azione con un `serverCommand`. `requestedById`: chi ha avviato la
 * sessione (`null` per un'analisi automatica, a nome di nessuno).
 */
export function serverCommandsOf(
  events: readonly ConversationEvent[],
  requestedById: string | null,
): ServerCommandRow[] {
  return events.flatMap((e) =>
    e.type === "action" && e.serverCommand
      ? [
          {
            id: e.id,
            action: e.serverCommand.action,
            params: { ...e.serverCommand.params },
            kind: e.serverCommand.kind,
            via: e.serverCommand.via,
            status: e.state === "running" ? "delivered" : e.state,
            requestedById,
            approvalId: e.serverCommand.approvalId,
            issuedAt: e.at,
            exitCode: e.state === "running" ? null : e.serverCommand.exitCode,
            output: e.result ?? null,
          },
        ]
      : [],
  );
}

/**
 * L'uscita di un comando come si mostra di base: le ultime
 * `COMMAND_OUTPUT_MAX_LINES` righe (l'errore sta in fondo). Un a capo finale
 * non conta come riga.
 */
export function truncateOutput(text: string): { text: string; truncated: boolean } {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= COMMAND_OUTPUT_MAX_LINES) return { text, truncated: false };
  return { text: lines.slice(-COMMAND_OUTPUT_MAX_LINES).join("\n"), truncated: true };
}
