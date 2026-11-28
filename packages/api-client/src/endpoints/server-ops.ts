import {
  serverAnalysisSettingsSchema,
  serverAnalysisViewSchema,
  serverCommandViewSchema,
  serverFixViewSchema,
  serverSshAccessViewSchema,
  serverTaskViewSchema,
} from "@stubwise/shared";
import type { Reader, ServerAnalysisView, ServerCommandView, ServerFixView, ServerSshAccessView, ServerTaskView } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

const analysesSchema = z.object({ analyses: z.array(serverAnalysisViewSchema) });
const operationsSchema = z.object({ commands: z.array(serverCommandViewSchema) });
const commandKeySchema = z.object({ publicKey: z.string() });

export type ServerAnalysisSettings = z.infer<typeof serverAnalysisSettingsSchema>;

/**
 * Area 8, F4b: le operazioni sui server (docs/invariants/server-operations.md).
 * Ciò che chi guarda PUÒ fare lo dice il server (`can…`); la diagnosi e le
 * uscite sono contenuto NON fidato, da mostrare come testo.
 * - analisi (`servers.operate` per avviarne una), registro, chiave dei comandi;
 * - SSH di sola lettura (`servers.ssh.manage`): la privata non esce mai;
 * - la correzione di una task di server (piano nuovo `servers.operate`,
 *   approva/rifiuta `plans.approve` nel progetto della task, Stop);
 * - i tetti dell'analisi (`settings.manage`).
 */
export function createServerOpsEndpoints(request: ApiRequest) {
  const server = (id: string) => `/api/servers/${seg(id)}`;
  const fix = (ticketId: string) => `/api/tasks/${seg(ticketId)}/server-fix`;
  return {
    /** Le ultime 20 analisi, nella busta `{ analyses }` (come le altre liste del client). */
    analyses(serverId: string): Promise<Reader<{ analyses: ServerAnalysisView[] }>> {
      return request("GET", `${server(serverId)}/analyses`, undefined, analysesSchema);
    },
    startAnalysis(serverId: string): Promise<Reader<ServerAnalysisView>> {
      return request("POST", `${server(serverId)}/analyses`, undefined, serverAnalysisViewSchema);
    },
    /** La chiave pubblica d'istanza per il comando d'installazione con le operazioni (`monitor.manage`). */
    commandKey(): Promise<Reader<{ publicKey: string }>> {
      return request("GET", "/api/servers/command-key", undefined, commandKeySchema);
    },

    ssh(serverId: string): Promise<Reader<ServerSshAccessView>> {
      return request("GET", `${server(serverId)}/ssh`, undefined, serverSshAccessViewSchema);
    },
    connectSsh(serverId: string, input: { host: string; port?: number }): Promise<Reader<ServerSshAccessView>> {
      return request("PUT", `${server(serverId)}/ssh`, input, serverSshAccessViewSchema);
    },
    verifySsh(serverId: string): Promise<Reader<ServerSshAccessView>> {
      return request("POST", `${server(serverId)}/ssh/verify`, undefined, serverSshAccessViewSchema);
    },
    regenerateSsh(serverId: string): Promise<Reader<ServerSshAccessView>> {
      return request("POST", `${server(serverId)}/ssh/regenerate`, undefined, serverSshAccessViewSchema);
    },
    revokeSsh(serverId: string): Promise<Reader<ServerSshAccessView>> {
      return request("DELETE", `${server(serverId)}/ssh`, undefined, serverSshAccessViewSchema);
    },

    fix(ticketId: string): Promise<Reader<ServerFixView>> {
      return request("GET", fix(ticketId), undefined, serverFixViewSchema);
    },
    requestPlan(ticketId: string): Promise<Reader<ServerFixView>> {
      return request("POST", fix(ticketId), undefined, serverFixViewSchema);
    },
    /** Approva il piano VISTO: `planDigest` è quello della vista (409 `plan_changed` se è stato riscritto). */
    approve(ticketId: string, planDigest: string): Promise<Reader<ServerFixView>> {
      return request("POST", `${fix(ticketId)}/approve`, { planDigest }, serverFixViewSchema);
    },
    reject(ticketId: string, note = ""): Promise<Reader<ServerFixView>> {
      return request("POST", `${fix(ticketId)}/reject`, { note }, serverFixViewSchema);
    },
    /** La sezione Server di una task nata da un server (server, episodio, analisi, correzione, startBlock). */
    taskServer(ticketId: string): Promise<Reader<ServerTaskView>> {
      return request("GET", `/api/tasks/${seg(ticketId)}/server`, undefined, serverTaskViewSchema);
    },
    /** I comandi di questa correzione (passi e letture della sua sessione), con le uscite non fidate. */
    fixCommands(ticketId: string): Promise<Reader<{ commands: ServerCommandView[] }>> {
      return request("GET", `${fix(ticketId)}/commands`, undefined, operationsSchema);
    },
    stop(ticketId: string): Promise<Reader<ServerFixView>> {
      return request("POST", `${fix(ticketId)}/stop`, undefined, serverFixViewSchema);
    },

    analysisSettings(): Promise<Reader<ServerAnalysisSettings>> {
      return request("GET", "/api/settings/server-analysis", undefined, serverAnalysisSettingsSchema);
    },
    setAnalysisSettings(settings: ServerAnalysisSettings): Promise<Reader<ServerAnalysisSettings>> {
      return request("PUT", "/api/settings/server-analysis", settings, serverAnalysisSettingsSchema);
    },
  };
}
