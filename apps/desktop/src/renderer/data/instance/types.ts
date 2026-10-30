import type { AdminRefusal } from "../admin/types";

// Le risposte delle scritture d'istanza (area 9b): quelle d'amministrazione
// del 9a, più `conflict` (un lavoro già vivo, un nome già preso) e `in_use`
// (un account o un'app che qualcosa usa ancora). In `in_use` le righe
// nascoste a chi guarda non hanno nome: sono solo contate (R-G5).

export type InstanceRefusal =
  | AdminRefusal
  | { ok: false; error: "conflict" }
  | {
      ok: false;
      error: "in_use";
      usedBy: { label: string; projectCode: string | null }[];
      hiddenCount: number;
    };

export type InstanceResult<T extends object = object> = ({ ok: true } & T) | InstanceRefusal;
