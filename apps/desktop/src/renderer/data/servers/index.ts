// I Server (area 8b) come li espone `api.ts`: `api.servers.<funzione>`. Chi
// vede che cosa e gli stati derivati li decide `visibility.ts` con le regole
// pure di `domain/servers`; `monitor.ts` sono le scritture della sezione
// Monitor del web (`monitor.manage`); `access.ts` gli accessi SSH
// (`servers.ssh.manage`), `simulate.ts` i «Simula …» del solo prototipo.
// `secrets.ts` (le chiavi private) NON si esporta: lo importa `access.ts`
// (e `fix.ts`, se gli serve). L'analisi non lo importa: legge solo con
// l'accesso di lettura, attraverso `accessUsable` e `markUsed`.
//
// `alertTypes.ts` si importa qui, STATICAMENTE e per il suo effetto:
// registra gli avvisi dei server nel catalogo prima del primo `resetApi`.
// `analysis.ts` (episodi e analisi automatica) non è una funzione dell'API:
// ci arrivano i «Simula …» di `simulate.ts`.
import "./alertTypes";

export {
  getInstallCommand,
  getServer,
  getServerMetrics,
  listProjectServers,
  searchServers,
  type MetricRange,
  type ServerMetrics,
  type ServerSearchResult,
} from "./reads";
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
