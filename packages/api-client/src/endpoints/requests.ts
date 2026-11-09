import { projectRequestViewSchema, requestJobViewSchema, requestToConvertViewSchema } from "@stubwise/shared";
import type {
  NewRequestBody,
  ProjectRequestView,
  Reader,
  RequestJobView,
  RequestPatchBody,
  RequestToConvertView,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * Le richieste dell'app nuova (integrazione area 2, fetta 4; le da
 * trasformare dalla fetta 3): la vista `ProjectRequest` del prototipo, col
 * codice R<n> vero. Creare passa dall'intake come oggi (asincrono): `create`
 * dà il job, `job` dice se la richiesta è nuova o è stata fusa, e in quale.
 * «Fondi in…» riscrive la destinazione col modello: se non risponde, 502
 * `merge_failed` e niente cambia. Trasformare in task è `tasks.create` con
 * `requestId`.
 */
export function createRequestsEndpoints(request: ApiRequest) {
  const one = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<Reader<ProjectRequestView>> =>
    request(method, path, body, projectRequestViewSchema);
  return {
    /** Nuove, in rifinitura o pronte, non fuse, dei progetti dove posso creare task; dalla più recente. */
    toConvert(): Promise<Reader<RequestToConvertView>[]> {
      return request("GET", "/api/requests/to-convert", undefined, z.array(requestToConvertViewSchema));
    },
    /** Le richieste di un progetto che vedo, dalla più recente. */
    list(projectId: string): Promise<Reader<ProjectRequestView>[]> {
      return request("GET", `/api/requests${toQuery({ projectId })}`, undefined, z.array(projectRequestViewSchema));
    },
    get(id: string): Promise<Reader<ProjectRequestView>> {
      return one("GET", `/api/requests/${seg(id)}`);
    },
    /** Per codice (`STW-R4`); una che non vedo risponde come una che non c'è (404). */
    byCode(code: string): Promise<Reader<ProjectRequestView>> {
      return one("GET", `/api/requests/by-code/${seg(code)}`);
    },
    /** Accoda l'intake (202): l'esito si legge con `job`. */
    create(body: NewRequestBody): Promise<{ jobId: string }> {
      return request("POST", "/api/requests", body, z.object({ jobId: z.string() }));
    },
    job(jobId: string): Promise<Reader<RequestJobView>> {
      return request("GET", `/api/requests/jobs/${seg(jobId)}`, undefined, requestJobViewSchema);
    },
    /** Titolo, descrizione e metadati; su una trasformata o archiviata (salvo il titolo) → 409. */
    update(id: string, patch: RequestPatchBody): Promise<Reader<ProjectRequestView>> {
      return one("PATCH", `/api/requests/${seg(id)}`, patch);
    },
    archive(id: string): Promise<Reader<ProjectRequestView>> {
      return one("POST", `/api/requests/${seg(id)}/archive`);
    },
    /** Un'archiviata (anche fusa) torna «nuova». */
    reopen(id: string): Promise<Reader<ProjectRequestView>> {
      return one("POST", `/api/requests/${seg(id)}/reopen`);
    },
    /** L'«Annulla» di un'archiviazione a mano: torna allo stato aperto di prima. */
    restore(id: string, status: "new" | "refining" | "ready"): Promise<Reader<ProjectRequestView>> {
      return one("POST", `/api/requests/${seg(id)}/restore`, { status });
    },
    /** Accetta le proposte dell'intake: diventano i metadati. 409 se non ce ne sono o la richiesta è chiusa. */
    acceptSuggestions(id: string): Promise<Reader<ProjectRequestView>> {
      return one("POST", `/api/requests/${seg(id)}/suggestions/accept`);
    },
    /** Scarta le proposte dell'intake. */
    dismissSuggestions(id: string): Promise<Reader<ProjectRequestView>> {
      return one("POST", `/api/requests/${seg(id)}/suggestions/dismiss`);
    },
    /** Fonde questa richiesta in `intoId`; risponde con la destinazione riscritta. */
    merge(id: string, intoId: string): Promise<Reader<ProjectRequestView>> {
      return one("POST", `/api/requests/${seg(id)}/merge`, { intoId });
    },
  };
}
