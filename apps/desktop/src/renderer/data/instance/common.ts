import { refuse as adminRefuse } from "../admin/common";
import { requireReauth } from "../auth/reauth";
import type { ApiFnName } from "../store";
import type { InstanceRefusal } from "./types";

// Ciò che le scritture d'istanza (area 9b) condividono: i rifiuti e la
// riconferma. L'ordine dei controlli è quello del 9a
// (`admin/common.ts`): `not_found` (R-G5) → `forbidden` → l'input
// (`invalid`) → i blocchi (`conflict`, `in_use`) → `reauth_required` → la
// scrittura e la sua voce del registro. La riconferma viene dopo le regole:
// non si chiede il codice per un'azione che sarebbe rifiutata.

export const refuse = {
  ...adminRefuse,
  conflict: (): InstanceRefusal => ({ ok: false, error: "conflict" }),
  /**
   * Qualcosa usa ancora l'oggetto. `usedBy` sono solo le righe che chi
   * guarda vede; le altre sono contate in `hiddenCount`, senza nome (R-G5).
   */
  inUse: (
    usedBy: { label: string; projectCode: string | null }[],
    hiddenCount: number,
  ): InstanceRefusal => ({ ok: false, error: "in_use", usedBy, hiddenCount }),
};

/** `reauth_required` se la funzione è dichiarata in `REAUTH_REQUIRED` e manca una riconferma recente. */
export function reauthRefusal(me: string, fn: ApiFnName): InstanceRefusal | null {
  return requireReauth(me, fn) ? adminRefuse.reauth() : null;
}

export { canI, nameOf } from "../admin/common";
