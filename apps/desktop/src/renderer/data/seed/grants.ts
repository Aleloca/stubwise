import type { LocalInstancePermission } from "../types";

// Le concessioni personali del seme: permessi d'istanza dati a una persona,
// in più del suo preset (che resta com'è). `resetApi` torna a queste.
//
// R-J10 (area 7): Matteo possiede «Nuovo contratto» (AUT-1), un'automazione
// generale, quindi ha `automations.manage` d'istanza; la sua casella è
// collegata, così le email dell'automazione partono davvero.
export const SEED_INSTANCE_GRANTS: Record<string, readonly LocalInstancePermission[]> = {
  "p-matteo": ["automations.manage"],
};
