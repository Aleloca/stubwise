import type { Db } from "@stubwise/db";
import type { ClaudeActionFailure, ClaudeFillField } from "@stubwise/shared";
import { evaluateProjectAccess } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { SERVER_CATALOG, syntheticRequest } from "../claude-actions/catalog.js";
import { releaseNotesWriteAccess } from "./pr-release-notes.js";

/**
 * Area 10, F6 (D-4 = a): può chi chiede scrivere QUEL campo? Lo si chiede
 * prima che una bozza di Claude (`fillField`) diventi una scheda: se non può,
 * non diventa niente («se non può, non diventa una scheda», il design). Le
 * regole sono quelle delle ROTTE del campo, non una copia:
 * - la descrizione: l'accesso della voce `updateTask` del catalogo, che il test
 *   d'accordo `claude-actions-class.test.ts` tiene uguale a quello di
 *   `PATCH /api/tasks/:ticketId` (`onTicket("tickets.edit")`, con l'eccezione
 *   all'archivio della rotta). Una task che chi chiede non vede è `not_found`,
 *   come la rotta;
 * - le note di rilascio: `releaseNotesWriteAccess`, la regola di
 *   `putPrReleaseNotes` (`release.merge` o `tickets.edit`).
 * Non scrive niente: il testo lo salva la persona dal campo.
 */
export type FillFieldAccess =
  | { ok: true; projectId: string }
  | { ok: false; failure: Pick<ClaudeActionFailure, "code" | "permission" | "projectId" | "message"> };

export async function canFillField(
  db: Db,
  user: SessionUser,
  args: { field: ClaudeFillField; taskId?: string; repositoryId?: string; prNumber?: number },
): Promise<FillFieldAccess> {
  if (args.field === "task.description") {
    const entry = SERVER_CATALOG.get("updateTask")!;
    if (entry.access.kind !== "project") throw new Error("updateTask: accesso di progetto atteso");
    const access = await evaluateProjectAccess(syntheticRequest(db, user, await entry.request({ id: args.taskId }, db), entry.archived), db, user, entry.access);
    if (access.ok) return { ok: true, projectId: access.projectId };
    if (access.error === "archived") return { ok: false, failure: { code: "conflict", permission: null, projectId: null, message: "The project is archived" } };
    return {
      ok: false,
      failure: { code: access.error, permission: access.error === "forbidden" ? entry.access.permission : null, projectId: null, message: "" },
    };
  }
  const notes = await releaseNotesWriteAccess(db, user, args.repositoryId!, args.prNumber!);
  if (notes.ok) return notes;
  return {
    ok: false,
    failure: notes.error === "forbidden"
      ? { code: "forbidden", permission: "release.merge", projectId: null, message: "release.merge or tickets.edit" }
      : { code: "not_found", permission: null, projectId: null, message: "" },
  };
}
