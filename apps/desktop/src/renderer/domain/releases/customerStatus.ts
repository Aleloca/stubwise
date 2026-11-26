import type { ProjectRequest, Task } from "../../data/model";
import { customerStatus as sharedCustomerStatus, type CustomerStatus } from "@stubwise/shared";
import type { ReleaseStatusKind } from "./releaseStatus";

// Lo stato della richiesta in parole, come lo vede il CLIENTE (spec «Cosa
// vede il cliente»): la regola è UNA, in `@stubwise/shared` (area 8, F3), con
// un ingresso neutro. Qui il prototipo la legge dai suoi oggetti: una
// richiesta fusa passa `merged`, una task chiusa ha `closedAt`, Claude ci
// lavora se `claude` non è `none`.

export { CUSTOMER_STATUSES, type CustomerStatus } from "@stubwise/shared";

/**
 * `tasks` sono le task nate dalla richiesta, `releases` gli stati dei
 * rilasci delle loro PR. Una richiesta fusa in un'altra non è «non
 * procediamo»: il desiderio vive nella destinazione (chi chiama, se la
 * vede, passa quella).
 */
export function customerStatus(
  req: ProjectRequest | null,
  tasks: Task[],
  releases: ReleaseStatusKind[],
): CustomerStatus {
  return sharedCustomerStatus(
    req
      ? { status: req.status, merged: req.mergedIntoId !== null && req.mergedIntoId !== undefined }
      : null,
    tasks.map((t) => ({ closed: t.closedAt !== null, claudeActive: t.claude !== "none" })),
    releases,
  );
}
