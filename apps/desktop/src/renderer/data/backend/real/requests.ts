import { ApiError } from "@stubwise/api-client";
import type { ProjectRequestView, RequestJobView, RequestToConvertView } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ProjectRequest, RequestLevel } from "../../types";
import { appClient } from "./client";
import { createTask } from "./tasks";

// Le Requests della build app (integrazione area 2, fetta 4): elenco,
// dettaglio, nuova richiesta (che passa dall'intake e può essere fusa da sola:
// decisione del maintainer), metadati, fusione (riscritta dal modello: 502
// `merge_failed` e niente cambia), archivia, riapri, ripristina, conversione.
//
// Le richieste da trasformare in task (integrazione area 2, fetta 3, Task J):
// nuove, in rifinitura o pronte, non fuse, dei progetti dove chi guarda può
// creare task. Servono a «Da decidere» e al blocco «Richieste nuove». La
// sezione Requests è della fetta 4: una richiesta si apre nel web vecchio
// (`webHref`). Il codice R<n> lo deriva il server (diventerà un numero vero
// nella fetta 4, con gli stessi valori). Differenza dal prototipo: chi non ha
// `backlog.view_all` (un Contributor) vede solo le richieste sue.

/** La scala dei ticket in quella del prototipo: «urgent» si legge «high»; senza stima, «medium». */
function urgencyOf(wide: string | null): RequestLevel {
  if (wide === "low" || wide === "medium" || wide === "high") return wide;
  return wide === "urgent" ? "high" : "medium";
}

/** Il progetto di ogni richiesta letta: «Turn into task» la crea lì senza rileggere la voce. */
const projectOfRequest = new Map<string, string>();

function toRequest(v: RequestToConvertView): ProjectRequest {
  projectOfRequest.set(v.id, v.projectId);
  return {
    id: v.id,
    code: v.code,
    projectId: v.projectId,
    title: v.title,
    description: "",
    requesterIds: v.requesterIds,
    status: v.status as ProjectRequest["status"],
    urgency: urgencyOf(v.urgency),
    similarToId: null,
    mergedIntoId: null,
    taskIds: [],
    createdAt: v.createdAt,
    webHref: v.webHref,
  };
}

export const listRequestsToConvert: typeof Fake.listRequestsToConvert = async () =>
  (await appClient().requests.toConvert()).map((v) => toRequest(v as RequestToConvertView));

/** «Turn into task»: la task nasce nel progetto della richiesta, collegata a lei (`requestId`). */
export const convertRequest: typeof Fake.convertRequest = async (id, input) => {
  const projectId = projectOfRequest.get(id) ?? (await getRequest(id))?.projectId;
  if (!projectId) throw new Error("not_found");
  return createTask({ ...input, projectId, requestId: id });
};

// --- Requests (fetta 4) ------------------------------------------------------

function fromView(v: ProjectRequestView): ProjectRequest {
  projectOfRequest.set(v.id, v.projectId);
  return {
    id: v.id,
    code: v.code,
    projectId: v.projectId,
    title: v.title,
    description: v.description,
    requesterIds: v.requesterIds,
    status: v.status as ProjectRequest["status"],
    urgency: urgencyOf(v.urgency),
    ...(v.urgent ? { urgent: true } : {}),
    size: v.size,
    risk: v.risk,
    riskNote: v.riskNote,
    design: v.design,
    plan: v.plan,
    similarToId: v.similarToId,
    mergedIntoId: v.mergedIntoId,
    taskIds: v.taskIds,
    createdAt: v.createdAt,
    suggestions: v.suggestions ?? null,
    ...(v.webHref ? { webHref: v.webHref } : {}),
  } as ProjectRequest;
}

const nullOn404 = async (read: () => Promise<unknown>): Promise<ProjectRequest | null> => {
  try {
    return fromView((await read()) as ProjectRequestView);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
};

export const listRequests: typeof Fake.listRequests = async (projectId) =>
  (await appClient().requests.list(projectId)).map((v) => fromView(v as ProjectRequestView));

/** Una voce invisibile risponde come una che non c'è: `null`. */
export const getRequest: typeof Fake.getRequest = (id) => nullOn404(() => appClient().requests.get(id));

/** Il codice è indipendente da maiuscole e minuscole («aud-r4»). */
export const getRequestByCode: typeof Fake.getRequestByCode = (code) =>
  nullOn404(() => appClient().requests.byCode(code.toUpperCase()));

/** Quanto si aspetta l'intake: un controllo ogni `POLL_MS`, al massimo `POLL_TRIES` volte (~1 minuto). */
const POLL_MS = 400;
const POLL_TRIES = 150;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * «Nuova richiesta»: l'intake del server la crea o la fonde in una esistente
 * (decisione del maintainer). La risposta è la richiesta in cui è finita; se
 * fusa, `landedByMerge` («Unita a R12»). Un intake fallito, o che non risponde
 * entro il tetto, è un errore: il dialogo lo dice e si può riprovare.
 */
export const createRequest: typeof Fake.createRequest = async (input) => {
  const { jobId } = await appClient().requests.create({
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? "",
  });
  for (let i = 0; i < POLL_TRIES; i++) {
    const job = (await appClient().requests.job(jobId)) as RequestJobView;
    if (job.status === "done" && job.request) {
      const request = fromView(job.request);
      return job.outcome === "merged" ? { ...request, landedByMerge: true } : request;
    }
    if (job.status === "failed" || job.status === "done") throw new Error("intake_failed");
    await wait(POLL_MS);
  }
  throw new Error("intake_timeout");
};

/**
 * Titolo e metadati (`backlog.edit`; 409 `request_read_only` su una trasformata
 * o archiviata). `suggestions: null` è «scarta i suggerimenti dell'intake», che
 * ha una rotta sua (sotto `/api/backlog` finché non arriva sotto `/api/requests`).
 */
export const updateRequest: typeof Fake.updateRequest = async (id, patch) => {
  const { suggestions, ...fields } = patch;
  const body = {
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.urgency !== undefined ? { urgency: fields.urgency } : {}),
    ...(fields.size !== undefined ? { size: fields.size } : {}),
    ...(fields.risk !== undefined ? { risk: fields.risk } : {}),
    ...(fields.riskNote !== undefined ? { riskNote: fields.riskNote } : {}),
  };
  let view: ProjectRequestView | null = null;
  if (Object.keys(body).length > 0) view = (await appClient().requests.update(id, body as never)) as ProjectRequestView;
  if (suggestions === null) {
    await appClient().request("POST", `/api/backlog/${encodeURIComponent(id)}/suggested/dismiss`);
    view = (await appClient().requests.get(id)) as ProjectRequestView;
  }
  if (!view) view = (await appClient().requests.get(id)) as ProjectRequestView;
  return fromView(view);
};

/** «Fondi in…»: la destinazione riscritta dal modello; un errore (502 `merge_failed`) non cambia niente. */
export const mergeRequest: typeof Fake.mergeRequest = async (id, intoId) =>
  fromView((await appClient().requests.merge(id, intoId)) as ProjectRequestView);

export const archiveRequest: typeof Fake.archiveRequest = async (id) =>
  fromView((await appClient().requests.archive(id)) as ProjectRequestView);

export const reopenRequest: typeof Fake.reopenRequest = async (id) =>
  fromView((await appClient().requests.reopen(id)) as ProjectRequestView);

export const restoreRequest: typeof Fake.restoreRequest = async (id, status) =>
  fromView((await appClient().requests.restore(id, status)) as ProjectRequestView);
