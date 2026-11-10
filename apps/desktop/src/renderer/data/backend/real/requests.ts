import { ApiError } from "@stubwise/api-client";
import type { ProjectRequestView, RequestJobView, RequestToConvertView } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ProjectRequest, RequestLevel } from "../../types";
import { appClient, session } from "./client";
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

/** I suggerimenti dell'intake di ogni voce letta: «Accetta» li riconosce nella patch. */
const suggestionsOf = new Map<string, ProjectRequestView["suggestions"]>();

function fromView(v: ProjectRequestView): ProjectRequest {
  projectOfRequest.set(v.id, v.projectId);
  suggestionsOf.set(v.id, v.suggestions ?? null);
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
/** Gli errori transitori (rete, 5xx) tollerati di fila durante l'attesa. */
const POLL_TRANSIENT_ERRORS = 3;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Un errore da cui l'attesa si riprende: rete giù o un 5xx/429 del server. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

/**
 * «Nuova richiesta»: l'intake del server la crea o la fonde in una esistente
 * (decisione del maintainer). La risposta è la richiesta in cui è finita; se
 * fusa, `landedByMerge` («Unita a R12»).
 *
 * Due esiti d'errore, da non confondere (review della fetta 4, punto 1):
 * - il POST fallisce: non è partito nulla, l'errore è quello del POST e si
 *   può riprovare;
 * - il job è accodato ma l'esito non arriva (tetto, troppi errori di rete di
 *   fila, `done` senza richiesta, un 4xx sulla lettura del job):
 *   `Error("intake_pending")`. La richiesta c'è o ci sarà: il dialogo lo
 *   dice e NON offre «Riprova», che creerebbe un duplicato.
 * Un intake `failed` resta un errore normale. L'attesa si ferma
 * (`Error("aborted")`) quando `signal` scatta (il dialogo si smonta) o la
 * persona della sessione cambia.
 */
export const createRequest: typeof Fake.createRequest = async (input, options) => {
  const { jobId } = await appClient().requests.create({
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? "",
  });
  const person = session.personId;
  const stopped = () => options?.signal?.aborted === true || session.personId !== person;
  let errors = 0;
  for (let i = 0; i < POLL_TRIES; i++) {
    if (stopped()) throw new Error("aborted");
    let job: RequestJobView;
    try {
      job = (await appClient().requests.job(jobId)) as RequestJobView;
      errors = 0;
    } catch (error) {
      if (stopped()) throw new Error("aborted");
      if (!isTransient(error) || ++errors > POLL_TRANSIENT_ERRORS) throw new Error("intake_pending");
      await wait(POLL_MS);
      continue;
    }
    if (stopped()) throw new Error("aborted");
    if (job.status === "done" && job.request) {
      const request = fromView(job.request);
      return job.outcome === "merged" ? { ...request, landedByMerge: true } : request;
    }
    if (job.status === "failed") throw new Error("intake_failed");
    if (job.status === "done") throw new Error("intake_pending");
    await wait(POLL_MS);
  }
  throw new Error("intake_pending");
};

const SUGGESTED = ["urgency", "size", "risk", "riskNote"] as const;

/**
 * «Accetta»: la patch porta esattamente i valori suggeriti (e `suggestions:
 * null`), come la scrive `RequestGuidance`.
 */
function isAcceptance(id: string, fields: Record<string, unknown>): boolean {
  const suggested = suggestionsOf.get(id);
  if (!suggested) return false;
  const keys = SUGGESTED.filter((k) => suggested[k] !== undefined);
  const given = Object.keys(fields);
  return (
    keys.length > 0 &&
    given.length === keys.length &&
    keys.every((k) => given.includes(k) && fields[k] === suggested[k])
  );
}

/**
 * Titolo, descrizione e metadati (`backlog.edit`; 409 `request_read_only` su
 * una trasformata o archiviata). `suggestions: null` chiude i suggerimenti
 * dell'intake: con i loro stessi valori è «Accetta», da solo è «Scarta»; con
 * altre modifiche, prima quelle e poi «Scarta».
 */
export const updateRequest: typeof Fake.updateRequest = async (id, patch) => {
  const { suggestions, ...rest } = patch;
  const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const client = appClient().requests;
  if (suggestions === null && isAcceptance(id, fields)) {
    return fromView((await client.acceptSuggestions(id)) as ProjectRequestView);
  }
  let view: ProjectRequestView | null = null;
  if (Object.keys(fields).length > 0) view = (await client.update(id, fields as never)) as ProjectRequestView;
  if (suggestions === null) {
    try {
      view = (await client.dismissSuggestions(id)) as ProjectRequestView;
    } catch (error) {
      if (!view) throw error;
      // Le modifiche sono salvate, i suggerimenti no: l'errore lo dice (`suggestions_kept`).
      fromView(view);
      throw Object.assign(new Error("suggestions_kept"), { code: "suggestions_kept", cause: error });
    }
  }
  return fromView(view ?? ((await client.get(id)) as ProjectRequestView));
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
