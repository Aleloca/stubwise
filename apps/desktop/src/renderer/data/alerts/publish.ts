import { isCatalogKind } from "../../domain/alerts/catalog";
import { mergeMandatory } from "../../domain/alerts/recipients";
import { newId, nextSeq, now, state } from "../store";
import type { AppNotification, MandatoryReason, Release } from "../types";
import { invalid } from "../writer";

// L'unico modo in cui le aree dell'8a (`data/releases`, `data/support`)
// creano un avviso: la riga non porta destinatari (`recipientIds: []`),
// chi la riceve si calcola a lettura dal catalogo, dalle iscrizioni, dagli
// obbligatori scritti qui e dai permessi di adesso.

export interface AlertInput {
  kind: string;
  projectId: string;
  objectCode: string;
  title: string;
  body: string;
  link: string;
  mandatory?: { personId: string; reason: MandatoryReason }[];
}

export function publishAlert(input: AlertInput): void {
  if (!isCatalogKind(input.kind)) throw invalid("kind");
  const task = state.tasks.find(
    (t) => t.projectId === input.projectId && t.code === input.objectCode,
  );
  const n: AppNotification = {
    id: newId("n-alert"),
    kind: input.kind,
    projectId: input.projectId,
    objectCode: input.objectCode,
    departmentId: task?.departmentId ?? null,
    recipientIds: [],
    title: input.title,
    body: input.body,
    createdAt: now(),
    seq: nextSeq(),
    read: false,
    archived: false,
    snoozedUntil: null,
    link: input.link,
  };
  if (input.mandatory?.length) n.mandatory = input.mandatory.map((m) => ({ ...m }));
  state.notifications.push(n);
}

/**
 * Gli obbligatori di un avviso su un rilascio: chi ha fatto il merge; se è
 * stato fatto fuori da Stubwise da un'identità non collegata, chi ha creato
 * la task della PR (dalla cronologia delle PR); altrimenti nessuno.
 */
export function releaseMandatory(
  release: Release,
): { personId: string; reason: MandatoryReason }[] {
  const pr = state.pullRequests.find(
    (p) =>
      p.projectId === release.projectId &&
      p.repo === release.pr.repo &&
      p.number === release.pr.number,
  );
  const task = pr ? state.tasksById.get(pr.taskId) : undefined;
  // Un nome git collegato dopo a una persona («Collega l'autore») vale come
  // merge suo: l'autore della task subentra solo se nessuno è collegato.
  const merger = release.mergedById ?? state.commitAuthorLinks.get(release.mergedGitName) ?? null;
  return mergeMandatory(merger, task?.createdById ?? null);
}
