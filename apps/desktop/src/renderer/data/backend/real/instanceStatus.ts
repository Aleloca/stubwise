import type { InstanceStatusView } from "../../instance/status";
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

/** La rotta (sul client vero: `client.instance`). */
export interface InstanceStatusApi {
  status(): Promise<Any>;
}

/** Dove porta un lavoro, per tipo; `null` se non ha una pagina sua. */
function hrefOf(j: Any): string | null {
  const code: string | null = j.code ?? null;
  if (!code) return null;
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
      const s = await api.status();
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
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: InstanceStatusApi = {
  status: () => appClient().instance.status(),
};

/** SOLO TEST: la rotta vera. */
export const liveInstanceStatusApiForTest = liveApi;

export const liveInstanceStatus = createRealInstanceStatus(liveApi);
