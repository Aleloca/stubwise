// I Server (area 8b) come li espone `api.ts`: `api.servers.<funzione>`. Chi
// vede che cosa e gli stati derivati li decide `visibility.ts` con le regole
// pure di `domain/servers`; `monitor.ts` sono le scritture della sezione
// Monitor del web (`monitor.manage`); `access.ts` gli accessi SSH
// (`servers.ssh.manage`), `simulate.ts` i «Simula …» del solo prototipo.
// `secrets.ts` (le chiavi private) NON si esporta: lo importano `access.ts`
// e `fix.ts` (che chiede solo se la chiave di correzione c'è, `hasKey`).
// L'analisi non lo importa: legge solo con l'accesso di lettura, attraverso
// `accessUsable` e `markUsed`. `fix.ts` è la correzione da task
// (`startServerFix`); il resto del suo percorso (decidere il piano, Stop)
// passa dalle scritture delle conversazioni.
//
// Gli avvisi dei server stanno nel catalogo condiviso (`@stubwise/shared`,
// F2 dell'integrazione: prima li registrava qui `alertTypes.ts`).
// `analysis.ts` (episodi e analisi automatica) non è una funzione dell'API:
// ci arrivano i «Simula …» di `simulate.ts`.
export {
  getInstallCommand,
  getRemovalCommand,
  getServer,
  getServerMetrics,
  getServerTaskInfo,
  listAllServers,
  listProjectServers,
  searchServers,
  type InstanceServerRow,
  type MetricRange,
  type ServerMetrics,
  type ServerSearchResult,
  type ServerTaskInfo,
} from "./reads";
export { startServerFix } from "./fix";
export {
  createCheck,
  createServer,
  deleteCheck,
  deleteServer,
  regenerateAgentKey,
  setThresholds,
  updateCheck,
  updateServer,
  type CheckInput,
  type CreateServerInput,
  type UpdateServerInput,
} from "./monitor";
export { linkSshAccess, regenerateSshAccess, revokeSshAccess, verifySshAccess } from "./access";
export {
  simulateFixCheck,
  simulateServerAlert,
  simulateServerRecovery,
  simulateSshUnreachable,
  simulateSshVerifyOutcome,
} from "./simulate";
export {
  RECENT_CPU_POINTS,
  serverHref,
  type ServerDetail,
  type ServerEpisodeView,
  type ServerRow,
  type SshAccessView,
  type SshUseView,
} from "./visibility";
