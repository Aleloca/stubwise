import { ApiError } from "@stubwise/api-client";
import type { InstanceStatusView } from "../../instance/status";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";

// Amministrazione → Instance status nella build app (area 9, F4) su
// `GET /api/instance/status` (72, e7875b084), nella forma del prototipo e
// tutta calcolata dal server: blocchi, visibilità (la riga «Other projects»,
// i worker occupati altrove), cosa si può rilanciare e perché no. Il server
// non conosce le rotte del renderer: i link li compone il client da `kind`,
// `projectCode` e `code` (la task «ACQ-57», l'esecuzione «ACQ-A2 #7», il
// server «SRV-3»). I worker sono gli slot dell'heartbeat (`<processo>:<n>`).

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.instance`, `client.projects`). */
export interface InstanceStatusApi {
  status(): Promise<Any>;
  pauseQueue(projectId: string): Promise<void>;
  resumeQueue(projectId: string): Promise<void>;
  retryJob(jobId: string): Promise<{ jobId: string; status: string; stopsAtPlan: boolean }>;
}

/**
 * I rifiuti di pausa, ripresa e rilancio nelle parole della pagina:
 * `already_paused`, `not_paused`, `not_retryable`, `monthly_budget` col loro
 * codice; 409 `conflict` (già ripartito, o superato da lavoro vivo).
 */
function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  const code = error.code ?? "";
  if (code === "conflict") return { ok: false, error: "conflict" };
  if (error.status === 404) return { ok: false, error: "not_found" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (code) return { ok: false, error: "invalid", reason: code };
  throw error;
}

async function attempt<T extends object>(call: () => Promise<T>): Promise<InstanceResult<T>> {
  try {
    return { ok: true, ...(await call()) } as InstanceResult<T>;
  } catch (error) {
    return refusalOf(error);
  }
}

/** Dove porta un lavoro, per tipo; `null` se non ha una pagina sua. */
function hrefOf(j: Any): string | null {
  const code: string | null = j.code ?? null;
  if (!code) return null;
  // Un progetto senza codice non fa un link rotto (review F4, M5).
  if (j.projectId && !j.projectCode) return null;
  switch (j.kind) {
    case "task_run":
    case "correction":
      return j.projectCode ? `#/p/${j.projectCode}/tasks?task=${encodeURIComponent(code)}` : null;
    case "automation": {
      const m = /^(\S+) #(\d+)$/.exec(code);
      return m ? `#/automations/${m[1]}/runs/${m[2]}` : null;
    }
    case "server_fix":
    case "server_analysis":
      return j.projectId ? `#/p/${j.projectCode}/servers/${code}` : `#/admin/servers/${code}`;
    default:
      return null;
  }
}

export function createRealInstanceStatus(api: InstanceStatusApi) {
  return {
    async getInstanceStatus(): Promise<InstanceStatusView> {
      let s: Any;
      try {
        s = await api.status();
      } catch (error) {
        // Senza instance.status.view: la pagina dice «not found» (review F4, I2).
        if (error instanceof ApiError && error.status === 403) throw new Error("forbidden");
        throw error;
      }
      const jobs = (s.jobs as Any[]).map((j) => ({ ...j, href: j.href ?? hrefOf(j) }));
      const byId = new Map(jobs.map((j) => [j.id, j]));
      return {
        ...s,
        jobs,
        errors: (s.errors as Any[]).map((e) => ({
          ...e,
          href: e.href ?? byId.get(e.jobId)?.href ?? null,
        })),
      } as InstanceStatusView;
    },

    pauseQueue: (projectId: string) =>
      attempt(async () => {
        await api.pauseQueue(projectId);
        return {};
      }),

    resumeQueue: (projectId: string) =>
      attempt(async () => {
        await api.resumeQueue(projectId);
        return {};
      }),

    /** Il rilancio: il lavoro nuovo lo dice il server (`jobId`). */
    retryJob: (jobId: string) =>
      attempt(async () => ({ conversationId: (await api.retryJob(jobId)).jobId })),
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: InstanceStatusApi = {
  status: () => appClient().instance.status(),
  pauseQueue: (projectId) => appClient().projects.pauseQueue(projectId),
  resumeQueue: (projectId) => appClient().projects.resumeQueue(projectId),
  retryJob: (jobId) => appClient().instance.retryJob(jobId) as Promise<Any>,
};

/** SOLO TEST: la rotta vera. */
export const liveInstanceStatusApiForTest = liveApi;

export const liveInstanceStatus = createRealInstanceStatus(liveApi);
