import type { RequestToConvertView } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ProjectRequest, RequestLevel } from "../../types";
import { appClient } from "./client";
import { getRequest } from "./taskDetail";
import { createTask } from "./tasks";

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
