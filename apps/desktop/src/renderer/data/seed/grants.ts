import type { LocalInstancePermission, LocalProjectPermission } from "../types";

// Le concessioni personali del seme: permessi dati a una persona, in più del
// suo preset (che resta com'è). `resetApi` torna a queste.
//
// R-J10 (area 7): Matteo possiede «Nuovo contratto» (AUT-1), un'automazione
// generale, quindi ha `automations.manage` d'istanza; la sua casella è
// collegata, così le email dell'automazione partono davvero.
export const SEED_INSTANCE_GRANTS: Record<string, readonly LocalInstancePermission[]> = {
  "p-matteo": ["automations.manage"],
};

// Per progetto (codice), sulle righe dei progetti di cui la persona è membro.
//
// Area 8b: `servers.operate` non sta in nessun preset (spec «Permessi»): si dà
// persona per persona. Marco (Developer) avvia la correzione dei server di ACQ
// ma non approva il proprio piano; Laura (Project Lead) lo approva ma non la
// avvia. La pagina Membri che lo assegna è dell'area 9: fino ad allora, solo qui.
export const SEED_PROJECT_GRANTS: Record<
  string,
  Record<string, readonly LocalProjectPermission[]>
> = {
  "p-marco": { ACQ: ["servers.operate"] },
};
